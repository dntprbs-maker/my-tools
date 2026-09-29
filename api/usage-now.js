/**
 * 스마트폰이 "지금 조회"를 누르면 이 함수가 Claude/Codex 실제 현재 사용량을
 * 서버(Vercel)에서 직접 조회해 즉시 반환한다. PC는 필요 없다.
 *
 * 토큰은 Vercel Edge Config에 보관한다(=PC의 ~/.claude/.credentials.json,
 * ~/.codex/auth.json과 같은 역할을 서버 쪽에 둔 것). access token이 만료되면
 * 이 함수가 refresh token으로 직접 갱신하고, 갱신된 값을 Edge Config에 다시
 * 저장해 스스로 최신 상태를 유지한다 — 매번 재로그인하지 않아도 되게 하기 위함.
 *
 * refresh token 자체가 죽어서 갱신이 실패하면 "재인증 필요" 상태만 명확히
 * 반환한다. 이 경우에만 사람이 다시 로그인해서 seed 스크립트로 값을 새로
 * 넣어줘야 한다.
 *
 * 토큰 값은 응답·로그 어디에도 넣지 않는다. 한쪽 provider 실패가 다른 쪽
 * 결과를 막지 않는다.
 */

const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID;
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // 팀 스코프 토큰이면 필요할 수 있음

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code 공식 OAuth client id

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI 공식 OAuth client id

const UA = "usage-now/1.0";

class FetchError extends Error {
  constructor(kind, message, retryAfter) {
    super(message);
    this.kind = kind; // rate_limited / auth / network / error
    this.retryAfter = retryAfter;
  }
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isoFromEpoch(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  return v;
}

async function httpJson(url, { headers = {}, method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, body });
  } catch (e) {
    throw new FetchError("network", "네트워크 연결 실패 (" + e.message + ")");
  }
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    throw new FetchError("rate_limited", "요청이 잦아 서버가 잠시 막았습니다", ra ? Number(ra) : null);
  }
  if (res.status === 401 || res.status === 403) {
    throw new FetchError("auth", "인증이 거부됐습니다 (HTTP " + res.status + ")");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FetchError("error", "서버 오류 (HTTP " + res.status + ") " + text.slice(0, 200));
  }
  return res.json();
}

// ---------------- Edge Config (토큰 보관소) ----------------

async function getConfigItems() {
  if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) {
    throw new Error("EDGE_CONFIG_ID / VERCEL_API_TOKEN 환경변수가 설정되지 않았습니다");
  }
  const url =
    `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items` +
    (VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "");
  const list = await httpJson(url, { headers: { Authorization: "Bearer " + VERCEL_API_TOKEN } });
  const map = {};
  for (const item of list) map[item.key] = item.value;
  return map;
}

async function patchConfigItems(items) {
  const url =
    `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items` +
    (VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "");
  await httpJson(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + VERCEL_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      items: Object.entries(items).map(([key, value]) => ({ operation: "upsert", key, value })),
    }),
  });
}

// ---------------- Claude ----------------

async function refreshClaude(refreshToken) {
  const resp = await httpJson(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
  });
  if (!resp.access_token) throw new FetchError("auth", "Claude 갱신 응답이 올바르지 않습니다");
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token || refreshToken,
    expires_at: Date.now() + Number(resp.expires_in || 3600) * 1000,
  };
}

function claudeWindow(raw, key) {
  const w = raw?.[key] || {};
  return { usedPercent: w.utilization ?? null, resetAt: w.resets_at ?? null };
}

async function fetchClaude(cfg) {
  let accessToken = cfg.claude_access_token;
  const refreshToken = cfg.claude_refresh_token;
  const expiresAt = Number(cfg.claude_expires_at || 0);

  if (!accessToken && !refreshToken) {
    return { status: "auth_required", message: "Claude 로그인 정보가 없습니다 — seed 스크립트로 등록해 주세요" };
  }

  let refreshed = null;
  if (!accessToken || Date.now() > expiresAt - 120000) {
    if (!refreshToken) return { status: "auth_required", message: "Claude 재인증이 필요합니다" };
    try {
      refreshed = await refreshClaude(refreshToken);
      accessToken = refreshed.access_token;
    } catch (e) {
      return { status: "auth_required", message: "Claude 재인증이 필요합니다 (갱신 실패: " + e.message + ")" };
    }
  }

  async function call(token) {
    return httpJson(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: "Bearer " + token,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const raw = await call(accessToken);
    if (refreshed) await patchConfigItems({
      claude_access_token: refreshed.access_token,
      claude_refresh_token: refreshed.refresh_token,
      claude_expires_at: refreshed.expires_at,
    });
    return { status: "ok", fiveHour: claudeWindow(raw, "five_hour"), weekly: claudeWindow(raw, "seven_day") };
  } catch (e) {
    if (e.kind === "auth" && !refreshed && refreshToken) {
      try {
        const r2 = await refreshClaude(refreshToken);
        const raw2 = await call(r2.access_token);
        await patchConfigItems({
          claude_access_token: r2.access_token,
          claude_refresh_token: r2.refresh_token,
          claude_expires_at: r2.expires_at,
        });
        return { status: "ok", fiveHour: claudeWindow(raw2, "five_hour"), weekly: claudeWindow(raw2, "seven_day") };
      } catch (e2) {
        return { status: "auth_required", message: "Claude 재인증이 필요합니다" };
      }
    }
    if (e.kind === "rate_limited") return { status: "rate_limited", message: "요청 제한(429)", retryAfter: e.retryAfter };
    if (e.kind === "auth") return { status: "auth_required", message: "Claude 재인증이 필요합니다" };
    return { status: "error", message: e.message || "조회 실패" };
  }
}

// ---------------- Codex ----------------

async function refreshCodex(refreshToken) {
  const resp = await httpJson(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
  });
  if (!resp.access_token) throw new FetchError("auth", "Codex 갱신 응답이 올바르지 않습니다");
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token || refreshToken,
    expires_at: Date.now() + Number(resp.expires_in || 3600) * 1000,
  };
}

function codexWindow(w) {
  w = w || {};
  return { usedPercent: w.used_percent ?? null, resetAt: isoFromEpoch(w.reset_at) };
}

async function fetchCodex(cfg) {
  let accessToken = cfg.codex_access_token;
  const refreshToken = cfg.codex_refresh_token;
  const accountId = cfg.codex_account_id;
  const expiresAt = Number(cfg.codex_expires_at || 0);

  if ((!accessToken && !refreshToken) || !accountId) {
    return { status: "auth_required", message: "Codex 로그인 정보가 없습니다 — seed 스크립트로 등록해 주세요" };
  }

  let refreshed = null;
  if (!accessToken || Date.now() > expiresAt - 120000) {
    if (!refreshToken) return { status: "auth_required", message: "Codex 재인증이 필요합니다" };
    try {
      refreshed = await refreshCodex(refreshToken);
      accessToken = refreshed.access_token;
    } catch (e) {
      return { status: "auth_required", message: "Codex 재인증이 필요합니다 (갱신 실패: " + e.message + ")" };
    }
  }

  async function call(token) {
    return httpJson(CODEX_USAGE_URL, {
      headers: { Authorization: "Bearer " + token, "ChatGPT-Account-Id": accountId, Accept: "application/json" },
    });
  }

  try {
    const raw = await call(accessToken);
    if (refreshed) await patchConfigItems({
      codex_access_token: refreshed.access_token,
      codex_refresh_token: refreshed.refresh_token,
      codex_expires_at: refreshed.expires_at,
    });
    const rl = raw.rate_limit || {};
    return { status: "ok", fiveHour: codexWindow(rl.primary_window), weekly: codexWindow(rl.secondary_window) };
  } catch (e) {
    if (e.kind === "auth" && !refreshed && refreshToken) {
      try {
        const r2 = await refreshCodex(refreshToken);
        const raw2 = await call(r2.access_token);
        await patchConfigItems({
          codex_access_token: r2.access_token,
          codex_refresh_token: r2.refresh_token,
          codex_expires_at: r2.expires_at,
        });
        const rl2 = raw2.rate_limit || {};
        return { status: "ok", fiveHour: codexWindow(rl2.primary_window), weekly: codexWindow(rl2.secondary_window) };
      } catch (e2) {
        return { status: "auth_required", message: "Codex 재인증이 필요합니다" };
      }
    }
    if (e.kind === "rate_limited") return { status: "rate_limited", message: "요청 제한(429)", retryAfter: e.retryAfter };
    if (e.kind === "auth") return { status: "auth_required", message: "Codex 재인증이 필요합니다" };
    return { status: "error", message: e.message || "조회 실패" };
  }
}

// ---------------- handler ----------------

module.exports = async (req, res) => {
  try {
    const cfg = await getConfigItems();
    const [claude, codex] = await Promise.all([
      fetchClaude(cfg).catch((e) => ({ status: "error", message: e.message || "조회 실패" })),
      fetchCodex(cfg).catch((e) => ({ status: "error", message: e.message || "조회 실패" })),
    ]);
    return json(res, 200, { fetchedAt: new Date().toISOString(), claude, codex });
  } catch (e) {
    return json(res, 500, { error: e.message || "서버 오류" });
  }
};
