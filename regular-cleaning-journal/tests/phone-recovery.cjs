// Real Android Chrome; synthetic File payload injection is used only for this
// transport recovery check. Native picker and real camera are tested separately.
const pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base='http://127.0.0.1:8791',result={checks:[],ok:false,input:'synthetic File payload; native picker/camera separately verified'};
const pass=s=>{result.checks.push(s);console.log('PASS '+s);};
(async()=>{
 const browser=await pw.chromium.connectOverCDP('http://localhost:9223');const context=browser.contexts()[0];
 const api=await pw.request.newContext({baseURL:base});let r=await api.post('/api/login',{data:{username:'admin',password:'Admin-test-2026!'}});const admin=await r.json();const headers={'X-CSRF-Token':admin.csrf};
 const site=await (await api.post('/api/sites',{headers,data:{name:'실기기 전송복구 QA '+Date.now(),address:'합성 현장',checklist:['검증 항목']}})).json();
 r=await api.post('/api/assignments',{headers,data:{siteId:site.id,workerId:'w1',promiseDate:'2026-10-21',period:'AM',plannedStart:'2026-10-21T05:00:00+09:00',plannedEnd:'2026-10-21T07:00:00+09:00'}});assert.equal(r.status(),201);const assignment=await r.json();result.assignment=assignment.id;
 let page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(base);if(await page.getByRole('button',{name:'로그아웃',exact:true}).count())await page.getByRole('button',{name:'로그아웃',exact:true}).click();
 await page.getByLabel('아이디',{exact:true}).fill('worker');await page.getByLabel('비밀번호',{exact:true}).fill('Worker-test-2026!');await page.getByRole('button',{name:'로그인',exact:true}).click();await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();
 const open=async()=>{await page.locator('.card').filter({hasText:site.name}).getByRole('button',{name:'현장 상세 보기'}).click();await page.locator('#log-form').waitFor();};
 await open();for(const name of ['현장 도착','작업 시작','작업 종료']){const response=page.waitForResponse(r=>r.request().method()==='POST'&&!r.url().endsWith('/api/login'));await page.getByRole('button',{name,exact:true}).click();assert.equal((await response).status(),200);}
 const block=route=>route.abort('failed');await page.route('**/api/assignments/*/photos',block);
 await page.locator('#album').setInputFiles({name:'synthetic-recovery.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(root,'evidence/FieldNote-QA-before-20261019.png'))});
 await page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 1장'));assert.equal(await page.locator('#submit').isDisabled(),true);pass('실제 Android 전송 실패 사진 보존·제출 차단');
 await page.close();page=await context.newPage();page.setDefaultTimeout(15000);await page.route('**/api/assignments/*/photos',block);await page.goto(base);await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();await open();await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 1장'));pass('실제 Android 앱 탭 종료·새 탭 재열기 후 IndexedDB 사진 복원');
 await page.unroute('**/api/assignments/*/photos',block);await page.getByRole('button',{name:'대기 사진 다시 전송',exact:true}).click();await page.waitForFunction(()=>state.selected.log.photos.length===1);await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 사진이 없어요'));pass('실제 Android 연결 복구 후 서버 전송·대기열 제거');
 r=await api.get('/api/assignments/'+assignment.id);const final=await r.json();assert.equal(final.log.photos.length,1);assert.equal(final.log.status,'ended');assert.equal(final.promiseDate,'2026-10-21');assert.ok(final.log.endedAt);pass('실제 Android 종료시각·약속일 보존·사진 중복 0건');
 result.ok=true;result.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(root,'evidence/phone-recovery.json'),JSON.stringify(result,null,2));await api.dispose();process.exit(0);
})().catch(e=>{result.failure=String(e.stack||e);fs.writeFileSync(path.join(root,'evidence/phone-recovery.json'),JSON.stringify(result,null,2));console.error(e);process.exit(1);});
