const { chromium } = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname==='/api/me') return route.fulfill({status:401,contentType:'application/json',body:'{"error":"로그인 필요"}'});
    const file = path.join(root,'web',url.pathname==='/'?'index.html':url.pathname.slice(1));
    if(!fs.existsSync(file)) return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
  });
  await page.goto('http://cleaning.test/');
  await page.getByRole('heading',{name:'오늘의 현장을 준비해요'}).waitFor();
  await page.screenshot({path:path.join(root,'evidence','mobile-login.png'),fullPage:true});
  console.log(JSON.stringify({title:await page.title(),width:await page.evaluate(()=>document.documentElement.scrollWidth),viewport:390}));
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
