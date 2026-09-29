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
    if (!r.ok) throw Object.assign(new Error('로그인 확인 실패 (HTTP ' + r.status + ')'), { http: true });
    const d = await r.json();
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: d.authorization_code,
      redirect_uri: CODEX.issuer + '/deviceauth/callback', client_id: CODEX.clientId, code_verifier: d.code_verifier,
    });
    const t = await fetch(CODEX.issuer + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!t.ok) throw Object.assign(new Error('로그인 마무리 실패 (HTTP ' + t.status + ')'), { http: true });
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
  async function codexUsage(retried) {
    let c = await load('codex');
    if (!c) return { status: 'login' };
    if (Date.now() > (c.expires_at || 0) - 120000) { c = await codexRefresh(c); await save('codex', c); }
    const r = await fetch(CODEX.usageUrl, { headers: { Authorization: 'Bearer ' + c.access_token, 'ChatGPT-Account-Id': c.account_id || '', Accept: 'application/json' } });
    if ((r.status === 401 || r.status === 403) && !retried) {
      c = await codexRefresh(c); await save('codex', c);
      return codexUsage(true);
    }
    if (r.status === 429) return { status: 'limited' };
    if (!r.ok) throw new Error('조회 실패 (HTTP ' + r.status + ')');
    const d = await r.json(); const rl = d.rate_limit || {};
    const w = (x) => ({ used: x ? x.used_percent : null, reset: x && x.reset_at ? new Date(x.reset_at * 1000) : null });
    return { status: 'ok', five: w(rl.primary_window), week: w(rl.secondary_window) };
  }

  // ---------- Claude: 공식 로그인(코드 붙여넣기 방식) ----------
  const CLAUDE = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude Code 공개 client id
    authorize: 'https://claude.com/cai/oauth/authorize',
    token: 'https://platform.claude.com/v1/oauth/token',
    redirect: 'https://platform.claude.com/oauth/code/callback',
    usageUrl: 'https://api.anthropic.com/api/oauth/usage',
  };
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  async function claudeStart() {
    const verifier = rand(32), st = rand(24);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    await save('claude_pending', { verifier, state: st });
    const q = new URLSearchParams({
      code: 'true', client_id: CLAUDE.clientId, response_type: 'code', redirect_uri: CLAUDE.redirect,
      scope: 'user:profile user:inference', code_challenge: challenge, code_challenge_method: 'S256', state: st,
    });
    return CLAUDE.authorize + '?' + q.toString();
  }
  async function claudeFinish(pasted) {
    const p = await load('claude_pending');
    if (!p) throw new Error('로그인을 처음부터 다시 시작해 주세요.');
    const [code, st] = String(pasted).trim().split('#');
    if (!code) throw new Error('코드를 붙여 넣어 주세요.');
    const r = await fetch(CLAUDE.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE.redirect, client_id: CLAUDE.clientId, code_verifier: p.verifier, state: st || p.state }),
    });
    if (!r.ok) throw new Error('로그인 마무리 실패 (HTTP ' + r.status + ') — 코드를 다시 받아 주세요.');
    const d = await r.json();
    await save('claude', { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000 });
    await remove('claude_pending');
  }
  async function claudeRefresh(c) {
    const r = await fetch(CLAUDE.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: CLAUDE.clientId }),
    });
    if (!r.ok) throw Object.assign(new Error('다시 로그인이 필요합니다'), { relogin: true });
    const d = await r.json();
    return { access_token: d.access_token, refresh_token: d.refresh_token || c.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  }
  async function claudeUsage(retried) {
    let c = await load('claude');
    if (!c) return { status: 'login' };
    if (Date.now() > (c.expires_at || 0) - 120000) { c = await claudeRefresh(c); await save('claude', c); }
    const r = await fetch(CLAUDE.usageUrl, { headers: { Authorization: 'Bearer ' + c.access_token, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } });
    if ((r.status === 401 || r.status === 403) && !retried) { c = await claudeRefresh(c); await save('claude', c); return claudeUsage(true); }
    if (r.status === 429) return { status: 'limited' };
    if (!r.ok) throw new Error('조회 실패 (HTTP ' + r.status + ')');
    const d = await r.json();
    const w = (x) => ({ used: x ? x.utilization : null, reset: x && x.resets_at ? new Date(x.resets_at) : null });
    return { status: 'ok', five: w(d.five_hour), week: w(d.seven_day) };
  }

  // ---------- 화면 ----------
  const WORKERS = [
    { key: 'claude', title: '코드D (Claude)', cls: '' },
    { key: 'codex', title: '덱스D (Codex)', cls: 'dex' },
  ];
  const state = { claude: { status: 'login' }, codex: { status: 'login' } };
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
    else if (s.status === 'paste') body = '<div class="box">열린 페이지에서 로그인·승인하면 코드가 나옵니다. 그 코드를 복사해 아래에 붙여 넣으세요.<input id="claudeCode" placeholder="코드 붙여넣기" autocomplete="off"><div class="actions"><button class="btn primary" data-finish="claude">확인</button><button class="btn" data-login="claude">페이지 다시 열기</button></div></div>';
    else if (s.status === 'login') body = '<div class="box">로그인이 필요합니다.<div class="actions"><button class="btn primary" data-login="' + w.key + '">' + (w.key === 'codex' ? 'Codex' : 'Claude') + ' 로그인</button></div></div>';
    else if (s.status === 'device') body = '<div class="box">아래 코드를 복사한 뒤 [로그인 페이지 열기]를 눌러 입력하세요.<div class="code">' + esc(s.userCode) + '</div><div class="actions"><button class="btn primary" data-open="codex">로그인 페이지 열기</button><button class="btn" data-copy="' + esc(s.userCode) + '">코드 복사</button></div><div class="meta">' + esc(s.note || '입력을 마치면 자동으로 연결됩니다(15분 안).') + '</div></div>';
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
    const run = async (key, fn) => {
      if (state[key].status === 'device' || state[key].status === 'paste') return; // 로그인 진행 중이면 건드리지 않음
      try { state[key] = { ...(await fn()), at: new Date() }; }
      catch (e) {
        const net = !e.relogin && !/HTTP \d/.test(e.message); // 연결 문제는 로그인 문제가 아니다
        state[key] = { status: 'error', message: net ? '인터넷 연결 문제로 조회하지 못했습니다. 잠시 뒤 [지금 조회]를 눌러 주세요.' : e.message, relogin: !!e.relogin };
      }
    };
    await Promise.all([run('claude', () => claudeUsage()), run('codex', () => codexUsage())]);
    render();
    $('#status').textContent = '마지막 조회 ' + fmt(new Date());
    $('#refresh').disabled = false;
  }

  // 로그인 페이지에 가 있는 사이 휴대폰이 앱을 꺼도 이어갈 수 있게 진행 중인 로그인을 저장해 둔다.
  let polling = null, checking = false;
  async function checkCodexLogin() {
    const s = await load('codex_pending');
    if (!s || checking) return;
    if (Date.now() > s.deadline) { clearInterval(polling); await remove('codex_pending'); state.codex = { status: 'error', message: '시간이 지났습니다. 다시 로그인해 주세요.', relogin: true }; render(); return; }
    checking = true;
    try {
      const tok = await codexPollOnce(s);
      if (tok) { clearInterval(polling); await save('codex', tok); await remove('codex_pending'); state.codex = { status: 'login' }; await refreshAll(); }
    } catch (e) {
      if (!e.http) { state.codex = { status: 'device', userCode: s.userCode, note: '인터넷 연결을 기다리는 중… 자동으로 다시 확인합니다.' }; render(); }
      else { clearInterval(polling); await remove('codex_pending'); state.codex = { status: 'error', message: e.message, relogin: true }; render(); }
    }
    finally { checking = false; }
  }
  function watchCodexLogin(s) {
    state.codex = { status: 'device', userCode: s.userCode };
    render();
    clearInterval(polling);
    polling = setInterval(checkCodexLogin, (s.interval || 5) * 1000);
  }
  async function startCodexLogin() {
    try {
      const s = await codexStart();
      s.deadline = Date.now() + 15 * 60000;
      await save('codex_pending', s);
      watchCodexLogin(s);
    } catch (e) { state.codex = { status: 'error', message: e.message, relogin: true }; render(); }
  }
  async function resumePending() {
    const s = await load('codex_pending');
    if (s && Date.now() < s.deadline) { watchCodexLogin(s); checkCodexLogin(); }
    const p = await load('claude_pending');
    if (p && !(await load('claude'))) { state.claude = { status: 'paste' }; render(); }
  }
  // 앱으로 돌아오는 즉시 확인
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCodexLogin(); });

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.login === 'codex') { await remove('codex'); await remove('codex_pending'); startCodexLogin(); }
    if (t.dataset.login === 'claude') {
      try { const url = await claudeStart(); state.claude = { status: 'paste' }; render(); if (Browser) Browser.open({ url }); }
      catch (e) { state.claude = { status: 'error', message: e.message, relogin: true }; render(); }
    }
    if (t.dataset.finish === 'claude') {
      t.disabled = true;
      try { await claudeFinish($('#claudeCode').value); state.claude = { status: 'login' }; await refreshAll(); }
      catch (e) { state.claude = { status: 'error', message: e.message, relogin: true }; render(); }
    }
    if (t.dataset.open === 'codex' && Browser) Browser.open({ url: CODEX.issuer + '/codex/device' });
    if (t.dataset.copy) { try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = '복사됨'; } catch (err) {} }
  });
  $('#refresh').addEventListener('click', refreshAll);
  render();
  resumePending().then(refreshAll);
})();
