// labBundle is injected by the validation orchestrator from this workspace.
// Stubbed transport with real Store-generated synthetic fixtures; no live HTTP claim.
var labFixture=JSON.parse(labBundle.fixtures), labRole=null, labCurrent='unwritten', labPhotoStages=[], labRequests=[], labPhotoFailure=false;
var labErrors=[];
await openTab('about:blank');
await page.setViewportSize({width:390,height:844});
page.on('pageerror',e=>labErrors.push(String(e)));
await page.route('http://cleaning.test/**',async route=>{
  var req=route.request(), url=new URL(req.url()), pathname=url.pathname;
  var body=req.postData()?JSON.parse(req.postData()):{};
  labRequests.push({path:pathname,method:req.method(),body});
  var respond=(status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:labBundle.html});
  if(pathname==='/app.js')return route.fulfill({status:200,contentType:'text/javascript',body:labBundle.js});
  if(pathname==='/styles.css')return route.fulfill({status:200,contentType:'text/css',body:labBundle.css});
  if(pathname==='/api/login'){
    if((body.username==='worker'&&body.password==='Worker-test-2026!')||(body.username==='admin'&&body.password==='Admin-test-2026!')){
      labRole=body.username;return respond(200,{user:labFixture[labRole],csrf:'ui-test-csrf'});
    }
    return respond(401,{error:'테스트 로그인 실패'});
  }
  if(pathname==='/api/logout'){labRole=null;return respond(200,{ok:true});}
  if(!labRole)return respond(401,{error:'로그인이 필요해요.'});
  if(pathname==='/api/me')return respond(200,{user:labFixture[labRole],csrf:'ui-test-csrf'});
  var current=()=>JSON.parse(JSON.stringify(labFixture.states[labCurrent]));
  if(pathname==='/api/bootstrap')return respond(200,{user:labFixture[labRole],csrf:'ui-test-csrf',serverTime:'2026-10-19T04:00:00Z',sites:labFixture.sites,workers:labRole==='admin'?labFixture.workers:[],assignments:labFixture.assignments.map(a=>a.id==='demo-1'?current():a)});
  if(pathname.startsWith('/api/photos/'))return route.fulfill({status:200,contentType:'image/png',body:Buffer.from(labFixture.png,'base64')});
  var match=pathname.match(/^\/api\/assignments\/([^/]+)(?:\/([a-z]+))?$/);
  if(match){
    if(!match[2])return respond(200,match[1]==='demo-1'?current():labFixture.assignments.find(a=>a.id===match[1]));
    var action=match[2];
    if(req.headers()['x-csrf-token']!=='ui-test-csrf')return respond(403,{error:'CSRF 누락'});
    if(action==='photos'){
      if(labPhotoFailure)return route.abort('failed');
      if(!labPhotoStages.includes(body.stage))labPhotoStages.push(body.stage);
      labCurrent=labPhotoStages.includes('after')?'after':'before';return respond(200,current());
    }
    if(['arrive','start','save','stop','submit','review'].includes(action)){
      if(action==='save'&&body.note!=='모바일 검증 메모')return respond(400,{error:'검증 메모 불일치'});
      labCurrent=action;return respond(200,current());
    }
  }
  return respond(404,{error:'UI fixture에 없는 요청'});
});
await page.goto('http://cleaning.test/');
console.log(await snapshot(page));
