// AI 사용량 앱 — 휴대폰에서 직접 로그인·조회 (2026-09-29 사장님 결정)
// 로그인 정보는 이 휴대폰 안(앱 전용 저장소)에만 보관하고 어떤 서버로도 보내지 않는다.
// 네트워크는 Capacitor 네이티브 HTTP(CapacitorHttp)로 나간다.
(() => {
  const Cap = window.Capacitor || {};
  const Prefs = Cap.Plugins && Cap.Plugins.Preferences;
  const Browser = Cap.Plugins && Cap.Plugins.Browser;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 보관 ----------
  async function load(key) {
    try { const r = await Prefs.get({ key }); return r.value ? JSON.parse(r.value) : null; } catch (e) { return null; }
  }
  async function save(key, v) { await Prefs.set({ key, value: JSON.stringify(v) }); }
  async function remove(key) { await Prefs.remove({ key }); }

  // ---------- Codex: 공식 기기 코드 로그인 ----------
  const CODEX = {
    issuer: 'https://auth.openai.com',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // Codex CLI 공개 client id
    usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
  };
  function jwtClaims(t) {
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; }
  }
  async function codexStart() {
    const r = await fetch(CODEX.issuer + '/api/accounts/deviceauth/usercode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: CODEX.clientId }),
    });
    if (!r.ok) throw new Error('코드 발급 실패 (HTTP ' + r.status + ')');
    const d = await r.json();
    return { deviceAuthId: d.device_auth_id, userCode: d.user_code || d.usercode, interval: Number(d.interval) || 5 };
  }
  async function codexPollOnce(s) {
    const r = await fetch(CODEX.issuer + '/api/accounts/deviceauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: s.deviceAuthId, user_code: s.userCode }),
    });
    if (r.status === 403 || r.status === 404) return null; // 아직 입력 전
    if (!r.ok) throw new Error('로그인 확인 실패 (HTTP ' + r.status + ')');
    const d = await r.json();
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: d.authorization_code,
      redirect_uri: CODEX.issuer + '/deviceauth/callback', client_id: CODEX.clientId, code_verifier: d.code_verifier,
    });
    const t = await fetch(CODEX.issuer + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!t.ok) throw new Error('로그인 마무리 실패 (HTTP ' + t.status + ')');
    const tok = await t.json();
    const auth = jwtClaims(tok.id_token)['https://api.openai.com/auth'] || {};
    return { access_token: tok.access_token, refresh_token: tok.refresh_token, account_id: auth.chatgpt_account_id, expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
  }
  async function codexRefresh(c) {
    const r = await fetch(CODEX.issuer + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: CODEX.clientId, scope: 'openid profile email offline_access' }),
    });
    if (!r.ok) throw Object.assign(new Error('다시 로그인이 필요합니다'), { relogin: true });
    const d = await r.json();
    return { ...c, access_token: d.access_token, refresh_token: d.refresh_token || c.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  }
  async function codexUsage() {
    let c = await load('codex');
    if (!c) return { status: 'login' };
    if (Date.now() > (c.expires_at || 0) - 120000) { c = await codexRefresh(c); await save('codex', c); }
    const r = await fetch(CODEX.usageUrl, { headers: { Authorization: 'Bearer ' + c.access_token, 'ChatGPT-Account-Id': c.account_id || '', Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) {
      c = await codexRefresh(c); await save('codex', c);
      return codexUsage();
    }
    if (r.status === 429) return { status: 'limited' };
    if (!r.ok) throw new Error('조회 실패 (HTTP ' + r.status + ')');
    const d = await r.json(); const rl = d.rate_limit || {};
    const w = (x) => ({ used: x ? x.used_percent : null, reset: x && x.reset_at ? new Date(x.reset_at * 1000) : null });
    return { status: 'ok', five: w(rl.primary_window), week: w(rl.secondary_window) };
  }

  // ---------- 화면 ----------
  const WORKERS = [
    { key: 'claude', title: '코드D (Claude)', cls: '' },
    { key: 'codex', title: '덱스D (Codex)', cls: 'dex' },
  ];
  const state = { claude: { status: 'soon' }, codex: { status: 'login' } };
  const n = (v) => { v = Number(v); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; };
  function fmt(d) { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); }
  function dur(ms) { if (ms <= 0) return '0분'; let m = Math.ceil(ms / 60000), dd = Math.floor(m / 1440); m %= 1440; const h = Math.floor(m / 60), mm = m % 60; return (dd ? dd + '일 ' : '') + (h ? h + '시간 ' : '') + mm + '분'; }
  // 기존 계산기와 같은 판정: 사용량 - 시간경과 < -10 파랑, <= 10 주황, 그 외 빨강
  function paceColor(used, elapsed) { const d = (n(used) ?? 0) - (n(elapsed) ?? 0); return d < -10 ? '#1769d2' : d <= 10 ? '#f59e0b' : '#dc2626'; }
  function elapsedPct(reset, hours) { const cycle = hours * 3600000; return n(((Date.now() - (reset.getTime() - cycle)) / cycle) * 100); }
  function bar(p, cls, color) { const v = n(p) ?? 0; return '<div class="barwrap ' + cls + '"><div class="bar"><div class="fill" style="width:' + v + '%;' + (color ? 'background:' + color : '') + '"></div></div><span class="pct">' + Math.round(v) + '%</span></div>'; }
  function limit(w, label, hours) {
    if (!w || w.used === null || !w.reset) return '<section class="limit"><h3>' + label + '</h3><div class="meta">값 없음</div></section>';
    const el = elapsedPct(w.reset, hours);
    return '<section class="limit"><h3>' + label + '</h3>' +
      '<div class="row"><div class="label">사용량</div>' + bar(w.used, '', paceColor(w.used, el)) + '</div>' +
      '<div class="row"><div class="label">시간경과</div>' + bar(el, 'elapsed') + '</div>' +
      '<div class="row"><div class="label">초기화</div><div class="value">' + dur(w.reset - Date.now()) + ' · ' + esc(fmt(w.reset)) + '</div></div></section>';
  }
  function card(w) {
    const s = state[w.key];
    let body;
    if (s.status === 'ok') body = limit(s.five, '5시간 한도', 5) + limit(s.week, '주간 한도', 168);
    else if (s.status === 'soon') body = '<div class="box meta">Claude 로그인은 다음 단계에서 추가됩니다.</div>';
    else if (s.status === 'login') body = '<div class="box">로그인이 필요합니다.<div class="actions"><button class="btn primary" data-login="' + w.key + '">' + (w.key === 'codex' ? 'Codex' : 'Claude') + ' 로그인</button></div></div>';
    else if (s.status === 'device') body = '<div class="box">아래 코드를 복사한 뒤 [로그인 페이지 열기]를 눌러 입력하세요.<div class="code">' + esc(s.userCode) + '</div><div class="actions"><button class="btn primary" data-open="codex">로그인 페이지 열기</button><button class="btn" data-copy="' + esc(s.userCode) + '">코드 복사</button></div><div class="meta">입력을 마치면 자동으로 연결됩니다(15분 안).</div></div>';
    else if (s.status === 'limited') body = '<div class="box">요청이 잦아 잠시 막혔습니다. 조금 뒤 다시 조회하세요.</div>';
    else body = '<div class="box err">' + esc(s.message || '오류') + (s.relogin ? '<div class="actions"><button class="btn primary" data-login="' + w.key + '">다시 로그인</button></div>' : '') + '</div>';
    return '<article class="worker ' + w.cls + '"><header class="worker-head"><h2>' + w.title + '</h2><span class="meta">' + (s.at ? esc(fmt(s.at)) + ' 조회' : '') + '</span></header>' + body + '</article>';
  }
  function banner() {
    const a = state.claude, b = state.codex;
    if (a.status !== 'ok' || b.status !== 'ok') return '';
    const rank = { '#1769d2': 0, '#f59e0b': 1, '#dc2626': 2 }, emoji = { '#1769d2': '🔵', '#f59e0b': '🟠', '#dc2626': '🔴' };
    const ca = paceColor(a.week.used, elapsedPct(a.week.reset, 168)), cb = paceColor(b.week.used, elapsedPct(b.week.reset, 168));
    const ra = rank[ca], rb = rank[cb];
    const pri = ra <= rb ? { name: '코드D', s: a, c: ca } : { name: '덱스D', s: b, c: cb };
    const oth = ra <= rb ? { name: '덱스D', s: b, c: cb } : { name: '코드D', s: a, c: ca };
    const ex = (s) => (n(s.five.used) ?? 0) >= 95;
    let t;
    if (ex(pri.s) && ex(oth.s)) t = '⏳ 둘 다 5시간 한도가 거의 찼어요. 초기화를 기다려주세요.';
    else if (ex(pri.s)) t = emoji[oth.c] + ' ' + pri.name + '는 5시간 한도가 거의 찼어요. 지금은 ' + oth.name + '를 쓰세요.';
    else if (ra === rb) t = emoji[ca] + ' ' + ({ 0: '둘 다 열심히 사용하셔도 돼요 😄', 1: '잘 쓰고 계시네요 👍', 2: '그만 쓰세요 ㅋㅋ' })[ra];
    else t = emoji[pri.c] + ' ' + pri.name + '를 우선 사용하세요.';
    return '<div class="pace-banner">' + esc(t) + '</div>';
  }
  function render() {
    $('#paceBanner').innerHTML = banner();
    $('#cards').innerHTML = WORKERS.map(card).join('');
  }

  async function refreshAll() {
    $('#refresh').disabled = true; $('#status').textContent = '조회 중…';
    try {
      state.codex = { ...(await codexUsage()), at: new Date() };
    } catch (e) {
      state.codex = { status: 'error', message: e.message, relogin: !!e.relogin };
    }
    render();
    $('#status').textContent = '마지막 조회 ' + fmt(new Date());
    $('#refresh').disabled = false;
  }

  let polling = null;
  async function startCodexLogin() {
    try {
      const s = await codexStart();
      state.codex = { status: 'device', userCode: s.userCode };
      render();
      const deadline = Date.now() + 15 * 60000;
      clearInterval(polling);
      polling = setInterval(async () => {
        if (Date.now() > deadline) { clearInterval(polling); state.codex = { status: 'error', message: '시간이 지났습니다. 다시 로그인해 주세요.', relogin: true }; render(); return; }
        try {
          const tok = await codexPollOnce(s);
          if (tok) { clearInterval(polling); await save('codex', tok); await refreshAll(); }
        } catch (e) { clearInterval(polling); state.codex = { status: 'error', message: e.message, relogin: true }; render(); }
      }, s.interval * 1000);
    } catch (e) { state.codex = { status: 'error', message: e.message, relogin: true }; render(); }
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.login === 'codex') { await remove('codex'); startCodexLogin(); }
    if (t.dataset.open === 'codex' && Browser) Browser.open({ url: CODEX.issuer + '/codex/device' });
    if (t.dataset.copy) { try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = '복사됨'; } catch (err) {} }
  });
  $('#refresh').addEventListener('click', refreshAll);
  render();
  refreshAll();
})();
