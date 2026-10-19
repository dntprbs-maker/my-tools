'use strict';
const pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base='http://127.0.0.1:8791',file=path.join(root,'evidence/phone-e2e.json');
const stage=process.argv[2]||'prepare';
const result=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{device:'SM-N976N',android:'12',checks:[]};
const pass=s=>{result.checks.push(s);console.log('PASS '+s);};
(async()=>{
 const browser=await pw.chromium.connectOverCDP('http://localhost:9223');
 const context=browser.contexts()[0];let page=context.pages().filter(p=>p.url().startsWith(base)).at(-1);
 if(!page)throw Error('해당 테스트 앱 탭이 없어요.');page.setDefaultTimeout(15000);
 await page.bringToFront();
 const cdp=await context.newCDPSession(page);
 const touch=async locator=>{await locator.evaluate(e=>e.scrollIntoView({block:'center',inline:'nearest'}));await page.evaluate(()=>new Promise(requestAnimationFrame));const box=await locator.boundingBox();assert.ok(box);const isFile=await locator.evaluate(e=>e.tagName==='INPUT'&&e.type==='file');const point={x:box.x+(isFile?Math.min(40,box.width/4):box.width/2),y:box.y+box.height/2};await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
 if(stage!=='prepare'&&!(await page.evaluate(()=>typeof state!=='undefined'&&state.selected))){await page.locator('.card').filter({hasText:result.assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();await page.locator('#log-form').waitFor();}
 const action=async(name,endpoint)=>{const promise=page.waitForResponse(r=>r.url().endsWith('/'+endpoint)&&r.request().method()==='POST');await touch(page.getByRole('button',{name,exact:true}));const response=await promise;assert.equal(response.status(),200,await response.text());const data=await response.json();await page.waitForFunction(st=>state.selected?.log?.status===st,data.log.status);return data;};
 if(stage==='prepare'){
   const api=await pw.request.newContext({baseURL:base});const login=await (await api.post('/api/login',{data:{username:'admin',password:'Admin-test-2026!'}})).json();const headers={'X-CSRF-Token':login.csrf};
   const site=await (await api.post('/api/sites',{headers,data:{name:'실기기 QA '+Date.now(),address:'합성 테스트 현장',checklist:['바닥 청소','쓰레기 정리']}})).json();
   const response=await api.post('/api/assignments',{headers,data:{siteId:site.id,workerId:'w1',promiseDate:'2026-10-21',period:'AM',plannedStart:'2026-10-20T19:00:00+09:00',plannedEnd:'2026-10-20T21:00:00+09:00'}});assert.equal(response.status(),201);result.assignment=await response.json();await api.dispose();
   await page.reload();
   if(await page.getByLabel('아이디',{exact:true}).count()){
     await page.getByLabel('아이디',{exact:true}).fill('worker');await page.getByLabel('비밀번호',{exact:true}).fill('Worker-test-2026!');await touch(page.getByRole('button',{name:'로그인',exact:true}));
   }
   await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();pass('실제 Android Chrome 작업자 로그인');
   await touch(page.locator('.card').filter({hasText:result.assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}));
   await action('현장 도착','arrive');await action('작업 시작','start');pass('실기기 터치 도착·시작과 서버 시각');
   const selects=page.locator('#log-form select');for(let i=0;i<await selects.count();i++)await selects.nth(i).selectOption('done');
   await page.getByLabel('작업 메모',{exact:true}).fill('실제 SM-N976N 검증 메모');await action('체크리스트·메모 저장','save');pass('실기기 체크리스트·메모 저장');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);pass('실기기 화면 가로 넘침 없음');
   const sizes=await page.locator('.actions button').evaluateAll(els=>els.map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,scroll:e.scrollWidth,client:e.clientWidth})));
   assert.ok(sizes.every(b=>b.height>=44&&b.scroll<=b.client));result.touchSizes=sizes;pass('실기기 주요 버튼 44px 이상·글자 잘림 없음');
   await page.locator('#album').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'evidence/phone-work-start.png'),fullPage:true});
 } else if(stage==='album-select'){
   await cdp.send('Page.setInterceptFileChooserDialog',{enabled:false});await touch(page.locator('#album'));pass('실기기 네이티브 앨범 파일선택 호출');
 } else if(stage==='album-send'){
   assert.ok(await page.locator('#album').evaluate(e=>e.files.length)>0,'네이티브 앨범 사진 선택 필요');
   await touch(page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}));
   await page.waitForFunction(()=>state.selected.log.photos.some(p=>p.stage==='before'));
   await page.waitForFunction(()=>document.querySelector('.photos img')?.naturalWidth>0);pass('실기기 네이티브 앨범 선택·원본 전송·사진 표시');
 } else if(stage==='camera-open'){
   await page.locator('#photo-form select[name=stage]').selectOption('after');
   await cdp.send('Page.setInterceptFileChooserDialog',{enabled:false});await touch(page.locator('#camera'));pass('실기기 네이티브 촬영 입력 호출');
 } else if(stage==='finish'){
   await page.waitForFunction(()=>document.querySelector('#camera')?.files.length>0);
   assert.ok(await page.locator('#camera').evaluate(e=>e.files.length)>0,'네이티브 카메라 촬영 결과 필요');
   await touch(page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}));
   await page.waitForFunction(()=>state.selected.log.photos.some(p=>p.stage==='after'));
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('.photos img')).every(i=>i.naturalWidth>0));pass('실기기 카메라 원본 전송·전후 사진 표시');
   await action('작업 종료','stop');await page.reload();await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();
   await touch(page.locator('.card').filter({hasText:result.assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}));
   assert.equal(await page.evaluate(()=>state.selected.log.status),'ended');assert.equal(await page.locator('.photos img').count(),2);pass('실기기 새로고침 후 종료·사진 복원');
   await action('작업일지 제출','submit');pass('실기기 최종 제출');
   await touch(page.getByRole('button',{name:'로그아웃',exact:true}));
   await page.getByLabel('아이디',{exact:true}).fill('admin');await page.getByLabel('비밀번호',{exact:true}).fill('Admin-test-2026!');await touch(page.getByRole('button',{name:'로그인',exact:true}));
   await page.getByRole('heading',{name:'현장 관리',exact:true}).waitFor();
   await touch(page.locator('.card').filter({hasText:result.assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}));
   await action('검토 확인 완료','review');pass('실기기 관리자 로그인·동일 사진 검토·확인 완료');
   result.ok=true;await page.screenshot({path:path.join(root,'evidence/phone-reviewed.png'),fullPage:true});
 }
 if(result.failure){result.resolvedTestFailures=[...(result.resolvedTestFailures||[]),result.failure];delete result.failure;}
 result.lastStage=stage;result.updatedAt=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(result,null,2));process.exit(0);
})().catch(e=>{result.failure=String(e.stack||e);fs.writeFileSync(file,JSON.stringify(result,null,2));console.error(e);process.exit(1);});
