// EXIF rotation + slow upload on the actual connected Android browser.
const pw=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sharp=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base='http://127.0.0.1:8791',priorPath=path.join(root,'evidence/phone-image.json'),result=fs.existsSync(priorPath)?JSON.parse(fs.readFileSync(priorPath,'utf8')):{ok:false,checks:[]};result.ok=false;let cdp;
(async()=>{
 const browser=await pw.chromium.connectOverCDP('http://localhost:9223'),context=browser.contexts()[0];const page=context.pages().filter(p=>p.url().startsWith(base)).at(-1);page.setDefaultTimeout(20000);await page.bringToFront();
 const recovery=JSON.parse(fs.readFileSync(path.join(root,'evidence/phone-recovery.json'),'utf8'));
 const api=await pw.request.newContext({baseURL:base});await api.post('/api/login',{data:{username:'worker',password:'Worker-test-2026!'}});const assignment=await (await api.get('/api/assignments/'+recovery.assignment)).json();
 await page.goto(base);await page.getByRole('heading',{name:'내 배정 현장',exact:true}).waitFor();await page.locator('.card').filter({hasText:assignment.siteName}).getByRole('button',{name:'현장 상세 보기'}).click();await page.locator('#photo-form').waitFor();
 const image=await sharp({create:{width:1200,height:800,channels:3,background:'#91b9cf'}}).withMetadata({orientation:6}).jpeg().toBuffer();
 cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:300,downloadThroughput:32000,uploadThroughput:16000,connectionType:'cellular2g'});
 if(!assignment.log.photos.some(p=>p.name==='synthetic-exif-rotation.jpg')){
   await page.locator('#photo-form select[name=stage]').selectOption('after');await page.locator('#album').setInputFiles({name:'synthetic-exif-rotation.jpg',mimeType:'image/jpeg',buffer:image});
   await page.getByRole('button',{name:'선택 사진을 전송 대기열에 저장',exact:true}).click();await page.waitForFunction(()=>state.selected.log.photos.length===2);await page.waitForFunction(()=>document.querySelector('#queue')?.textContent.includes('전송 대기 사진이 없어요'));
   result.checks.push('실제 Android 저속 통신(지연300ms·업로드16KB/s) 사진 전송 성공');
 }
 const rotated=page.locator('img[alt*="synthetic-exif-rotation.jpg"]');await rotated.scrollIntoViewIfNeeded();await page.waitForFunction(()=>Array.from(document.images).find(i=>i.alt.includes('synthetic-exif-rotation.jpg'))?.naturalWidth>0);
 const dims=await rotated.evaluate(e=>({width:e.naturalWidth,height:e.naturalHeight}));assert.deepEqual(dims,{width:800,height:1200});result.checks.push('실제 Android JPEG EXIF 회전 표시 800x1200 정상');
 const updated=await (await api.get('/api/assignments/'+assignment.id)).json();const photo=updated.log.photos.find(p=>p.name==='synthetic-exif-rotation.jpg');const original=await (await api.get(photo.url)).body();assert.equal(crypto.createHash('sha256').update(original).digest('hex'),crypto.createHash('sha256').update(image).digest('hex'));result.checks.push('회전 사진 서버 원본 바이트 SHA256 동일');
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await api.dispose();if(result.failure){result.resolvedFailures=[...(result.resolvedFailures||[]),result.failure];delete result.failure;}result.checks=[...new Set(result.checks)];result.ok=true;fs.writeFileSync(path.join(root,'evidence/phone-image.json'),JSON.stringify(result,null,2));result.checks.forEach(c=>console.log('PASS '+c));process.exit(0);
})().catch(async e=>{if(cdp)await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}).catch(()=>{});result.failure=String(e.stack||e);fs.writeFileSync(path.join(root,'evidence/phone-image.json'),JSON.stringify(result,null,2));console.error(e);process.exit(1);});
