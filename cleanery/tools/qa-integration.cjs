const {createRequire}=require('module'),assert=require('assert/strict');
const r=createRequire('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=r('playwright');
(async()=>{const b=await chromium.launch({channel:'chrome',headless:true});try{for(const w of [1440,390]){
 const p=await b.newPage({viewport:{width:w,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:4328/');assert.equal(await p.locator('a.app').count(),6);
 await p.locator('a[href="./cleanery/"]').click();await p.waitForURL('**/cleanery/public/');
 for(const route of ['','services','cases','about','faq','quote','lookup','privacy']){
  await p.goto('http://127.0.0.1:4328/cleanery/public/'+(route?'?page='+route:''),{waitUntil:'networkidle'});
  assert.equal(await p.locator('h1').count(),1);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.locator('img[src]').evaluateAll(xs=>xs.forEach(x=>x.loading='eager'));
  await p.waitForFunction(()=>[...document.querySelectorAll('img[src]')].every(x=>x.complete&&x.naturalWidth));
  if(['quote','lookup'].includes(route)){assert.equal(await p.locator('form').count(),0);assert.match(await p.locator('main').innerText(),/저장하지 않습니다/);}
 }
 await p.goto('http://127.0.0.1:4328/cleanery/public/?page=services');await p.getByRole('tab',{name:'욕실',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('#space-panel img').naturalWidth>0);
 await p.goto('http://127.0.0.1:4328/cleanery/public/?page=cases');await p.locator('.case-card').first().click();
 await p.waitForFunction(()=>document.querySelector('#gallery-dialog img').naturalWidth>0);
 assert.deepEqual(errors,[]);console.log(w,'dashboard shortcut + 8 pages + privacy boundary PASS');await p.close();
 }}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
