'use strict';
// Real browser + real HTTP/SQLite; all created records are labelled synthetic QA.
const pw = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sharp = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8791';
const root = path.resolve(__dirname,'..');
const results = {transport:'real HTTP',browser:'Edge',checks:[],errors:[],created:[]};
const record = name => {results.checks.push(name); console.log('PASS '+name);};
async function login(page, username='worker', password='Worker-test-2026!') {
  await page.goto(base);
  await page.getByLabel('아이디',{exact:true}).fill(username);
  await page.getByLabel('비밀번호',{exact:true}).fill(password);
  await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.getByRole('heading',{name:username==='admin'?'현장 관리':'내 배정 현장',exact:true}).waitFor();
}
async function action(page, name, endpoint) {
  const response=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='POST');
  await page.getByRole('button',{name,exact:true}).click();
  const r=await response;const data=await r.json();assert.equal(r.status(),200,JSON.stringify(data));
  await page.waitForFunction(status=>state.selected?.log?.status===status,data.log.status);
  return data;
}
async function makeAssignment(api, label) {
  const l=await api.post('/api/login',{data:{username:'admin',password:'Admin-test-2026!'}});assert.equal(l.status(),200);
  const auth=await l.json();const headers={'X-CSRF-Token':auth.csrf};
  const s=await api.post('/api/sites',{headers,data:{name:label,address:'합성 테스트 주소 · 운영정보 없음',instructions:'자동검증용',checklist:['바닥 청소','공용 공간 정리','분리수거'],amStart:'05:00',amMinutes:150,pmStart:'23:30',pmMinutes:120}});assert.equal(s.status(),201);const site=await s.json();
  const a=await api.post('/api/assignments',{headers,data:{siteId:site.id,workerId:'w1',promiseDate:'2026-10-21',period:'AM',plannedStart:'2026-10-20T19:00:00+09:00',plannedEnd:'2026-10-20T21:00:00+09:00'}});assert.equal(a.status(),201);const assignment=await a.json();results.created.push({site:site.id,assignment:assignment.id,label});return assignment;
}
(async()=>{
  const browser=await pw.chromium.launch({channel:'msedge',headless:true});
  const api=await pw.request.newContext({baseURL:base});
  const assignment=await makeAssignment(api,'실접속 QA '+Date.now());
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/Los_Angeles'});
  const page=await context.newPage();page.on('pageerror',e=>results.errors.push(String(e)));
  page.setDefaultTimeout(15000);
  await login(page);record('실제 HTTP 작업자 로그인');
  await page.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();
  await page.getByRole('button',{name:'현장 도착',exact:true}).waitFor();
  await action(page,'현장 도착','/arrive');await action(page,'작업 시작','/start');record('실제 도착·시작 서버 기록');
  assert.equal(await page.locator('.facts').innerText().then(t=>t.includes('2026-10-21')),true);
  const selectors=page.locator('#log-form select');for(let i=0;i<await selectors.count();i++)await selectors.nth(i).selectOption('done');
  await page.getByLabel('작업 메모',{exact:true}).fill('실접속 검증 <img src=x onerror="window.__injected=1">');
  const saved=page.waitForResponse(r=>r.url().endsWith('/save')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'체크리스트·메모 저장',exact:true}).click();assert.equal((await saved).status(),200);
  await page.waitForFunction(()=>state.selected?.log?.note.startsWith('실접속 검증'));
  assert.equal(await page.evaluate(()=>window.__injected),undefined);record('체크리스트·메모 저장과 HTML 이스케이프');
  const buffer=await sharp({create:{width:900,height:640,channels:3,background:'#b9dbcc'}}).png().toBuffer();
  await page.locator('#album').setInputFiles({name:'synthetic-before.png',mimeType:'image/png',buffer});
  await page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}).click();
  await page.waitForFunction(()=>state.selected?.log?.photos.length===1);await page.locator('.photos img').first().waitFor();
  await page.waitForFunction(()=>document.querySelector('.photos img')?.naturalWidth>0);record('전 사진 서버 전송·실제 이미지 디코딩');
  let responseLost=false;
  const failUpload=async route=>{if(!responseLost){responseLost=true;await route.fetch();}await route.abort('failed');};
  await page.route('**/api/assignments/*/photos',failUpload);
  await page.locator('#photo-form select[name=stage]').selectOption('after');
  await page.locator('#album').setInputFiles({name:'synthetic-after.png',mimeType:'image/png',buffer});
  await page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 1장'));
  await page.reload();await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();
  await page.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();
  await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 1장'));record('응답 유실·새로고침 후 IndexedDB 대기 사진 복원');
  await action(page,'작업 종료','/stop');assert.equal(await page.locator('#submit').isDisabled(),true);record('실제 종료 보존·미전송 사진 제출 차단');
  await page.unroute('**/api/assignments/*/photos',failUpload);
  await page.getByRole('button',{name:'대기 사진 다시 전송',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 사진이 없어요'));
  await page.waitForFunction(()=>state.selected?.log?.photos.length===2);
  assert.equal(await page.locator('.photos img').count(),2);record('재전송 성공·응답 유실 사진 중복 0건');
  await action(page,'작업일지 제출','/submit');record('실제 제출·접수시각 표시');
  const adminContext=await browser.newContext({viewport:{width:1280,height:900}});const admin=await adminContext.newPage();admin.on('pageerror',e=>results.errors.push(String(e)));
  await login(admin,'admin','Admin-test-2026!');
  await admin.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();
  await admin.locator('#review-form textarea').fill('합성 QA 보완 요청');await action(admin,'보완 요청','/return');record('관리자 보완 요청');
  await page.reload();await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();
  await page.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();
  await page.locator('.warning').filter({hasText:'합성 QA 보완 요청'}).first().waitFor();await action(page,'작업일지 제출','/submit');
  await admin.reload();await admin.getByRole('heading',{name:'현장 관리',exact:true}).waitFor();
  await admin.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();
  await action(admin,'검토 확인 완료','/review');record('보완 재제출→관리자 확인 완료 왕복');
  await admin.screenshot({path:path.join(root,'evidence/live-admin-reviewed.png'),fullPage:true});
  for(const width of [360,390,430,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow '+width);
  }
  record('360/390/430/1280px 가로 넘침 없음');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'evidence/live-worker-mobile.png'),fullPage:true});
  assert.deepEqual(results.errors,[]);record('실제 브라우저 JavaScript 오류 0건');
  const worker2=await pw.request.newContext({baseURL:base});await worker2.post('/api/login',{data:{username:'worker2',password:'Worker2-test-2026!'}});
  assert.equal((await worker2.get('/api/assignments/'+assignment.id)).status(),404);record('다른 작업자 실제 API 접근 거절');
  const last=(await (await api.get('/api/assignments/'+assignment.id)).json());assert.equal(last.log.status,'reviewed');assert.equal(last.log.photos.length,2);assert.equal(last.promiseDate,'2026-10-21');
  results.finishedAt=new Date().toISOString();results.ok=true;results.assignment=assignment.id;
  fs.writeFileSync(path.join(root,'evidence/live-e2e.json'),JSON.stringify(results,null,2));
  await worker2.dispose();await api.dispose();await browser.close();console.log('LIVE E2E PASS '+results.checks.length);
})().catch(error=>{results.ok=false;results.failure=String(error.stack||error);fs.writeFileSync(path.join(root,'evidence/live-e2e.json'),JSON.stringify(results,null,2));console.error(error);process.exit(1);});
