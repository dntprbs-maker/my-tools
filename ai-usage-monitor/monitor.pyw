"""AI Usage Monitor — 독립 Windows 창(WebView2) 실행기.

- 같은 프로세스 안에 127.0.0.1 전용 로컬 서버를 띄우고(포트는 실행마다 비어 있는 번호 자동 선택),
  pywebview(WebView2) 창으로 기존 사용량 계산기 화면을 연다. 브라우저 탭/창은 열지 않는다.
- 창을 닫으면 서버도 함께 종료된다.
- data/usage.json 은 실행 파일(또는 이 스크립트) 옆 data 폴더에 저장된다.
  AI_USAGE_MONITOR_DATA 환경변수로 data 폴더를 바꿀 수 있다(시험용).
"""
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)
HERE = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent
BUNDLE = Path(getattr(sys, "_MEIPASS", HERE))
sys.path.insert(0, str(BUNDLE / "collector"))
import collector  # noqa: E402



def pick_data_dir():
    """실행 파일 옆 data 폴더를 우선 쓰고, 쓸 수 없는 위치(예: Program Files)면 사용자 폴더로 옮긴다."""
    if os.environ.get("AI_USAGE_MONITOR_DATA"):
        return Path(os.environ["AI_USAGE_MONITOR_DATA"])
    for d in (HERE / "data", Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "AI Usage Monitor" / "data"):
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / ".write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return d
        except OSError:
            continue
    return HERE / "data"


DATA_DIR = pick_data_dir()
collector.USAGE_FILE = DATA_DIR / "usage.json"
APP_DIR = (BUNDLE / "app").resolve()
LOG = DATA_DIR / "monitor.log"
HOST = "127.0.0.1"
TYPES = {".html": "text/html; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
         ".webmanifest": "application/manifest+json", ".js": "text/javascript", ".css": "text/css"}


def log(msg):
    # 인증값은 절대 기록하지 않는다 — 상태 문자열만 남긴다
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{collector.now_iso()} {msg}\n")


def public_view(data):
    """화면에 보낼 값만 골라낸다 (토큰은 애초에 usage.json 에 없지만 한 번 더 걸러냄)."""
    keep = ("five_hour", "weekly", "plan", "last_success_at", "status")
    out = {"saved_at": data.get("saved_at"), "login": collector.login_status()}
    for name in ("claude", "codex"):
        if name in data:
            out[name] = {k: data[name].get(k) for k in keep if k in data[name]}
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _local_only(self):
        port = self.server.server_address[1]
        allowed = (f"{HOST}:{port}", f"localhost:{port}")
        origin = self.headers.get("Origin")
        if self.headers.get("Host", "") not in allowed or (origin and origin not in ["http://" + a for a in allowed]):
            self.send_error(403)
            return False
        return True

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        if not self._local_only():
            return
        path = self.path.split("?")[0]
        if path == "/api/ping":
            return self._json({"app": "ai-usage-monitor"})
        if path == "/api/usage":
            return self._json(public_view(collector.load_usage()))
        f = (APP_DIR / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if APP_DIR not in f.parents or not f.is_file():
            return self.send_error(404)
        self._send(f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream"))

    def do_POST(self):
        if not self._local_only():
            return
        if self.path.split("?")[0] != "/api/refresh":
            return self.send_error(404)
        data = collector.refresh_all()
        log("refresh " + ", ".join(
            f"{n}={data.get(n, {}).get('status', {}).get('state')}" for n in ("claude", "codex")))
        self._json(public_view(data))


def start_server():
    server = ThreadingHTTPServer((HOST, 0), Handler)  # 0 = 비어 있는 포트 자동 선택
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"server start {HOST}:{server.server_address[1]}")
    return server


WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"


def webview2_installed():
    """Microsoft Edge WebView2 런타임 설치 여부 (Windows 10/11 대부분 기본 설치)."""
    import winreg
    guid = r"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    keys = [(winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{guid}"),
            (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}"),
            (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{guid}")]
    for root, key in keys:
        try:
            with winreg.OpenKey(root, key) as k:
                v = winreg.QueryValueEx(k, "pv")[0]
                if v and v != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def message(text, ask=False):
    import ctypes
    flags = 0x30 | (0x4 if ask else 0x0)  # 경고 아이콘 (+ 예/아니오)
    return ctypes.windll.user32.MessageBoxW(None, text, "AI Usage Monitor", flags) == 6


def need_webview2():
    log("WebView2 runtime missing")
    if message("이 프로그램은 Microsoft Edge WebView2 런타임이 필요합니다.\n"
               "이 PC에는 설치되어 있지 않습니다.\n\n"
               "Microsoft 공식 페이지에서 'Evergreen Bootstrapper'를 받아 설치한 뒤 다시 실행하세요.\n\n"
               "지금 설치 페이지를 열까요?", ask=True):
        import webbrowser
        webbrowser.open(WEBVIEW2_URL)


def main():
    if "--server-only" not in sys.argv and (os.environ.get("AI_USAGE_MONITOR_FAKE_NO_WEBVIEW2") or not webview2_installed()):
        return need_webview2()
    server = start_server()
    url = f"http://{HOST}:{server.server_address[1]}/"
    if "--server-only" in sys.argv:  # 시험용: 창 없이 서버만
        print(url, flush=True)
        threading.Event().wait()
    import webview
    webview.create_window("AI Usage Monitor", url, width=1200, height=900, min_size=(420, 600))
    try:
        webview.start(gui="edgechromium", private_mode=False,
                      storage_path=str(DATA_DIR / "webview"))
    except Exception:
        log("window failed " + traceback.format_exc().splitlines()[-1])
        need_webview2()
    server.shutdown()
    log("window closed — exit")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("fatal " + traceback.format_exc().splitlines()[-1])
        message("프로그램을 시작하지 못했습니다.\n자세한 내용: " + str(LOG))
        raise
