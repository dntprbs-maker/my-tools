import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {validateQuote} from './public/validation.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=path.resolve(process.env.DATA_DIR||path.join(root,'data')); await mkdir(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'quotes.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);');
const port=Number(process.env.PORT||4317), host='127.0.0.1';
const hash=s=>createHash('sha256').update(s).digest('hex');
const rate=new Map();
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json','.txt':'text/plain'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 try{
 const url=new URL(req.url,`http://${host}:${port}`);
 if(req.headers.host!==`${host}:${port}`&&req.headers.host!==`localhost:${port}`)return json(res,403,{error:'허용되지 않은 호스트입니다.'});
 if(req.method==='POST'&&url.pathname==='/api/quotes'){
  if(req.headers.origin!==`http://${req.headers.host}`)return json(res,403,{error:'같은 사이트에서만 신청할 수 있습니다.'});
  if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'JSON 형식이 필요합니다.'});
  const key=req.socket.remoteAddress,now=Date.now(); const bucket=rate.get(key)||{at:now,n:0}; if(now-bucket.at>60000){bucket.at=now;bucket.n=0;}rate.set(key,bucket);if(++bucket.n>20)return json(res,429,{error:'요청이 많습니다. 잠시 후 다시 시도해주세요.'});
  let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){json(res,413,{error:'입력 내용이 너무 깁니다.'});return;}body+=chunk;}
  let input;try{input=JSON.parse(body)}catch{return json(res,400,{error:'입력 형식을 확인해주세요.'});}
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  const result=validateQuote(input,today);if(!result.ok)return json(res,422,{error:'입력 내용을 확인해주세요.',errors:result.errors});
  const id=randomBytes(8).toString('hex'),token=randomBytes(24).toString('hex'),createdAt=new Date().toISOString();
  db.prepare('INSERT INTO quotes VALUES(?,?,?,?)').run(id,hash(token),createdAt,JSON.stringify(result.value));
  return json(res,201,{id,token,createdAt,preview:true});
 }
 if(req.method==='GET'&&url.pathname.startsWith('/api/quotes/')){
  const id=url.pathname.split('/').pop(),token=req.headers.authorization?.replace(/^Bearer /,'')||'';
  const row=db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
  if(!row||!timingSafeEqual(Buffer.from(hash(token)),Buffer.from(row.token_hash)))return json(res,404,{error:'접수번호와 조회키를 확인해주세요.'});
  return json(res,200,{id:row.id,createdAt:row.created_at,status:'시연 저장 완료 · 외부 전달 없음',...JSON.parse(row.payload)});
 }
 if(url.pathname.startsWith('/api/'))return json(res,404,{error:'찾을 수 없습니다.'});
 if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'지원하지 않는 요청입니다.'});
 let route=decodeURIComponent(url.pathname);let filename=route.includes('.')?route:'/index.html';
 const file=path.resolve(root,'public','.'+filename);if(!file.startsWith(path.join(root,'public')+path.sep))return json(res,403,{error:'접근할 수 없습니다.'});
 try{const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:content);}catch{res.writeHead(404);res.end('페이지를 찾을 수 없습니다.');}
 }catch(e){console.error(e.message);if(!res.headersSent)json(res,500,{error:'저장 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.'});else res.end();}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`포트 ${port}가 이미 사용 중입니다. 기존 미리보기를 확인하거나 PORT를 변경해주세요.`:error.message);db.close();process.exitCode=1;});
server.listen(port,host,()=>console.log(`크리너리 입주청소 로컬 미리보기 http://${host}:${port}`));
function close(){server.close(()=>{db.close();process.exit(0)});}process.on('SIGINT',close);process.on('SIGTERM',close);
