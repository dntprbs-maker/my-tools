"""Claude / Codex 사용량 조회 + Claude 인증 안전 갱신.

- 인증 파일은 읽기 전용으로 쓰되, Claude access token이 만료됐을 때만 refresh token으로 갱신해
  같은 파일에 원자적으로 덮어쓴다(직전 원본은 .bak-monitor 로 1개 보관).
- 토큰 값은 반환값·로그·예외 메시지 어디에도 넣지 않는다.
- 한 서비스 실패가 다른 서비스 결과를 버리지 않도록 서비스별로 따로 처리한다.
"""
import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USAGE_FILE = ROOT / "data" / "usage.json"

# 실행한 Windows 사용자 자신의 로그인 폴더를 쓴다 (다른 사람의 인증정보는 배포판에 포함하지 않음).
# Claude Code / Codex 가 공식 지원하는 폴더 변경 환경변수도 따른다.
CLAUDE_CRED = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / ".credentials.json"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"  # Claude Code 공식 OAuth client id

CODEX_AUTH = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"

LOGIN_HINT = {
    "claude": "이 PC에서 Claude Code에 로그인되어 있지 않습니다. Claude Code(터미널의 claude 명령)를 설치·로그인한 뒤 새로고침하세요.",
    "codex": "이 PC에서 Codex에 ChatGPT 계정으로 로그인되어 있지 않습니다. Codex를 실행해 ChatGPT 계정으로 로그인한 뒤 새로고침하세요.",
}
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

UA = "ai-usage-monitor/1.0"
_lock = threading.Lock()


class FetchError(Exception):
    def __init__(self, kind, message, retry_after=None):
        super().__init__(message)
        self.kind = kind            # rate_limited / auth / network / error
        self.message = message      # 사용자에게 보여줄 문장 (토큰 없음)
        self.retry_after = retry_after


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso(v):
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, timezone.utc).isoformat(timespec="seconds")
    return v


def _atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _http_json(url, headers, data=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **headers}, data=data,
                                 method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            ra = e.headers.get("retry-after")
            ra = int(ra) if ra and ra.isdigit() else None
            raise FetchError("rate_limited", "요청이 잦아 서버가 잠시 막았습니다", ra)
        if e.code in (401, 403):
            raise FetchError("auth", f"로그인 인증이 거부됐습니다 (HTTP {e.code}) — 해당 프로그램에 다시 로그인한 뒤 새로고침하세요")
        raise FetchError("error", f"서버 오류 (HTTP {e.code})")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FetchError("network", f"네트워크 연결 실패 ({type(e).__name__})")


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def login_status():
    """네트워크 없이 로그인 파일 존재 여부만 확인 (최초 실행 화면 안내용). 토큰 값은 반환하지 않는다."""
    claude = bool((_read_json(CLAUDE_CRED).get("claudeAiOauth") or {}).get("accessToken"))
    codex = bool((_read_json(CODEX_AUTH).get("tokens") or {}).get("access_token"))
    return {"claude": {"found": claude, "hint": None if claude else LOGIN_HINT["claude"]},
            "codex": {"found": codex, "hint": None if codex else LOGIN_HINT["codex"]}}


# ---------------- Claude ----------------

def _claude_refresh(cred):
    """만료된 access token 을 갱신해 인증 파일에 저장. 성공 시 새 cred 반환."""
    oauth = cred["claudeAiOauth"]
    body = json.dumps({"grant_type": "refresh_token", "refresh_token": oauth["refreshToken"],
                       "client_id": CLAUDE_CLIENT_ID}).encode()
    try:
        resp = _http_json(CLAUDE_TOKEN_URL, {"Content-Type": "application/json"}, body)
    except FetchError as e:
        raise FetchError(e.kind if e.kind != "auth" else "auth",
                         "Claude 로그인 갱신 실패 — " + e.message, e.retry_after)
    if "access_token" not in resp:
        raise FetchError("auth", "Claude 로그인 갱신 응답이 올바르지 않습니다")
    t = int(time.time() * 1000)
    oauth["accessToken"] = resp["access_token"]
    if resp.get("refresh_token"):
        oauth["refreshToken"] = resp["refresh_token"]
    oauth["expiresAt"] = t + int(resp.get("expires_in", 3600)) * 1000
    if resp.get("refresh_token_expires_in"):
        oauth["refreshTokenExpiresAt"] = t + int(resp["refresh_token_expires_in"]) * 1000
    if resp.get("scope"):
        oauth["scopes"] = resp["scope"].split()
    shutil.copy2(CLAUDE_CRED, CLAUDE_CRED.with_name(CLAUDE_CRED.name + ".bak-monitor"))
    _atomic_write(CLAUDE_CRED, json.dumps(cred))
    return cred


def fetch_claude():
    cred = _read_json(CLAUDE_CRED)
    if not (cred.get("claudeAiOauth") or {}).get("accessToken"):
        raise FetchError("login", LOGIN_HINT["claude"])
    refreshed = False
    if cred["claudeAiOauth"].get("expiresAt", 0) < (time.time() + 120) * 1000:
        cred = _claude_refresh(cred)
        refreshed = True

    def call():
        return _http_json(CLAUDE_USAGE_URL, {
            "Authorization": "Bearer " + cred["claudeAiOauth"]["accessToken"],
            "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json"})

    try:
        raw = call()
    except FetchError as e:
        if e.kind != "auth" or refreshed:
            raise
        cred = _claude_refresh(cred)  # 만료시각이 남았는데 거부된 경우 1회만 갱신 후 재시도
        refreshed = True
        raw = call()

    def win(k):
        w = raw.get(k) or {}
        return {"used_percent": w.get("utilization"), "reset_at": w.get("resets_at")}

    return {"five_hour": win("five_hour"), "weekly": win("seven_day"),
            "plan": cred["claudeAiOauth"].get("subscriptionType"), "auth_refreshed": refreshed}


# ---------------- Codex ----------------

def fetch_codex():
    tokens = _read_json(CODEX_AUTH).get("tokens") or {}
    if not tokens.get("access_token"):  # 파일 없음 / API 키 방식 / 키체인 저장 방식
        raise FetchError("login", LOGIN_HINT["codex"])
    headers = {"Authorization": "Bearer " + tokens["access_token"], "Accept": "application/json"}
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    raw = _http_json(CODEX_USAGE_URL, headers)
    rl = raw.get("rate_limit") or {}

    def win(w):
        w = w or {}
        return {"used_percent": w.get("used_percent"), "reset_at": _iso(w.get("reset_at"))}

    return {"five_hour": win(rl.get("primary_window")), "weekly": win(rl.get("secondary_window")),
            "plan": raw.get("plan_type"), "auth_refreshed": False}


# ---------------- usage.json ----------------

FETCHERS = {"claude": fetch_claude, "codex": fetch_codex}


def load_usage():
    try:
        return json.loads(USAGE_FILE.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _blocked_until(entry):
    b = (entry or {}).get("status", {}).get("blocked_until")
    if not b:
        return None
    try:
        d = datetime.fromisoformat(b)
        return d if d > datetime.now(timezone.utc) else None
    except ValueError:
        return None


def refresh_all(providers=None):
    """서비스별로 조회해 성공한 값만 갱신하고 usage.json 을 덮어쓴다. 결과 전체를 반환."""
    with _lock:
        data = load_usage()
        for name in (providers or FETCHERS):
            prev = data.get(name) or {}
            status = {"last_attempt_at": now_iso()}
            blocked = _blocked_until(prev)
            if blocked:
                # 429 대기시간 안에는 서버를 다시 부르지 않는다
                status.update(state="rate_limited", blocked_until=blocked.isoformat(timespec="seconds"),
                              message="서버 대기시간이 끝나지 않아 조회를 건너뛰었습니다")
                data[name] = {**prev, "status": status}
                continue
            try:
                got = FETCHERS[name]()
                data[name] = {"five_hour": got["five_hour"], "weekly": got["weekly"], "plan": got["plan"],
                              "last_success_at": now_iso(),
                              "status": {**status, "state": "ok", "auth_refreshed": got["auth_refreshed"]}}
            except FetchError as e:
                status.update(state=e.kind, message=e.message)
                if e.kind == "rate_limited":
                    wait = e.retry_after or 300
                    status["blocked_until"] = datetime.fromtimestamp(
                        time.time() + wait, timezone.utc).isoformat(timespec="seconds")
                data[name] = {**prev, "status": status}  # 마지막 정상값 유지
            except Exception as e:  # 예기치 못한 오류도 토큰 없이 종류만 기록
                status.update(state="error", message=f"예기치 못한 오류 ({type(e).__name__})")
                data[name] = {**prev, "status": status}
        data["saved_at"] = now_iso()
        _atomic_write(USAGE_FILE, json.dumps(data, ensure_ascii=False, indent=2))
        return data


if __name__ == "__main__":
    print(json.dumps(refresh_all(), ensure_ascii=False, indent=2))
