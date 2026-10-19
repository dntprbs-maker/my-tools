"""Isolated synthetic-data cleaning diary lab. No production connections."""
from __future__ import annotations
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
UTC = timezone.utc
KST = timezone(timedelta(hours=9))

def now():
    return datetime.now(UTC).isoformat(timespec='milliseconds')

def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))

def uid():
    return str(uuid.uuid4())

class Problem(Exception):
    def __init__(self, message, status=400, code='invalid'):
        self.message, self.status, self.code = message, status, code

def require(value, message, status=400, code='invalid'):
    if not value:
        raise Problem(message, status, code)

def text(value, limit=2000):
    require(isinstance(value, str) and len(value) <= limit, '입력 길이 또는 형식을 확인해 주세요.')
    return value.strip()

def stamp(value):
    require(isinstance(value, str), '날짜와 시간을 입력해 주세요.')
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(dt.tzinfo is not None, '시간대가 포함된 시각이 필요해요.')
        return dt.astimezone(UTC).isoformat(timespec='milliseconds')
    except ValueError:
        raise Problem('날짜와 시간 형식이 올바르지 않아요.')

def promise(date, period):
    require(isinstance(date, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', date), '약속 날짜를 확인해 주세요.')
    try:
        datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise Problem('존재하는 날짜를 입력해 주세요.')
    require(period in ('AM', 'PM'), '오전 또는 오후를 선택해 주세요.')

def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / 'photos').mkdir(exist_ok=True)
        self.path = self.directory / 'lab.sqlite3'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT, role TEXT, company TEXT, active INTEGER, salt TEXT, hash TEXT);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT, csrf TEXT, expires REAL);
            CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY, company TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY, company TEXT, worker_id TEXT, site_id TEXT, promise_date TEXT, period TEXT, data TEXT, UNIQUE(company,worker_id,site_id,promise_date,period));
            CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY, assignment_id TEXT UNIQUE, data TEXT);
            CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, assignment_id TEXT, upload_id TEXT, user_id TEXT, stage TEXT, name TEXT, size INTEGER, mime TEXT, item_id TEXT, created TEXT, UNIQUE(assignment_id,upload_id));
            CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, assignment_id TEXT, at TEXT, actor TEXT, action TEXT, reason TEXT, before_value TEXT, after_value TEXT);
            CREATE INDEX IF NOT EXISTS audit_assignment ON audit(assignment_id,at);
            ''')
            if not db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                self.seed(db)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def seed(self, db):
        for ident, username, name, role, company, active, password in [
            ('w1','worker','김청소 · 테스트','worker','lab-a',1,'Worker-test-2026!'),
            ('w2','worker2','이정리 · 테스트','worker','lab-a',1,'Worker2-test-2026!'),
            ('a1','admin','현장 관리자 · 테스트','admin','lab-a',1,'Admin-test-2026!'),
            ('b1','other','다른 회사 작업자','worker','lab-b',1,'Other-test-2026!'),
            ('i1','inactive','비활성 계정','worker','lab-a',0,'Inactive-test-2026!')]:
            salt = secrets.token_hex(16)
            db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',(ident,username,name,role,company,active,salt,password_hash(password,salt)))
        for sid, company, name in [('s1','lab-a','오산 테스트 오피스'),('s2','lab-a','동탄 테스트 라운지'),('sb','lab-b','별도 회사 테스트 현장')]:
            site = {'id':sid,'name':name,'company':company,'address':'실제 현장이 아닌 검증용 주소','instructions':'모의 출입 안내 · 실제 출입정보 없음','checklist':[{'id':'floor','label':'바닥 청소'},{'id':'desk','label':'공용 공간 정리'},{'id':'waste','label':'분리수거'}], 'requiredBefore':1,'requiredAfter':1,'amStart':'05:00','amMinutes':150,'pmStart':'19:00','pmMinutes':120}
            db.execute('INSERT INTO sites VALUES(?,?,?)',(sid,company,dumps(site)))
        today = datetime.now(KST).date()
        for index, wid, sid, day, period in [(1,'w1','s1',today,'AM'),(2,'w1','s2',today,'PM'),(3,'w2','s1',today+timedelta(days=1),'AM'),(4,'b1','sb',today,'AM'),(5,'w1','s1',today+timedelta(days=2),'AM')]:
            start = datetime.combine(day, datetime.strptime('05:00' if period=='AM' else '19:00','%H:%M').time(), KST)
            self.create_assignment(db, self.user(db,'a1') if wid!='b1' else {**self.user(db,'b1'),'role':'admin'}, {'siteId':sid,'workerId':wid,'promiseDate':str(day),'period':period,'plannedStart':start.isoformat(),'plannedEnd':(start+timedelta(hours=2)).isoformat()}, f'demo-{index}')

    def user(self, db, user_id):
        row = db.execute('SELECT id,name,role,company,active FROM users WHERE id=?',(user_id,)).fetchone()
        return dict(row) if row else None

    def audit(self, db, aid, user, action, before, after, reason=''):
        db.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)',(uid(),aid,now(),user['name'],action,reason,dumps(before),dumps(after)))

    def access(self, db, user, aid):
        row = db.execute('SELECT * FROM assignments WHERE id=?',(aid,)).fetchone()
        require(row and row['company']==user['company'] and (user['role']=='admin' or row['worker_id']==user['id']), '접근할 수 없는 배정이에요.',404,'not_found')
        return json.loads(row['data'])

    def detail(self, db, user, aid):
        assignment = self.access(db,user,aid)
        row = db.execute('SELECT data FROM logs WHERE assignment_id=?',(aid,)).fetchone()
        log = json.loads(row['data']) if row else None
        if log:
            log['photos'] = [{'id':p['id'],'stage':p['stage'],'name':p['name'],'size':p['size'],'itemId':p['item_id'],'url':'/api/photos/'+p['id']} for p in db.execute('SELECT * FROM photos WHERE assignment_id=? ORDER BY created,id',(aid,))]
            log['elapsedSeconds'] = max(0,round((datetime.fromisoformat(log.get('endedAt') or now())-datetime.fromisoformat(log['startedAt'])).total_seconds())) if log.get('startedAt') else 0
        assignment['log'] = log
        assignment['audit'] = [{'id':r['id'],'at':r['at'],'actor':r['actor'],'action':r['action'],'reason':r['reason'],'before':json.loads(r['before_value']),'after':json.loads(r['after_value'])} for r in db.execute('SELECT * FROM audit WHERE assignment_id=? ORDER BY at,rowid',(aid,))]
        return assignment

    def create_assignment(self, db, user, body, aid=None):
        require(user['role']=='admin','관리자만 배정할 수 있어요.',403)
        promise(body.get('promiseDate'),body.get('period'))
        site = db.execute('SELECT data FROM sites WHERE id=? AND company=?',(body.get('siteId'),user['company'])).fetchone()
        worker = self.user(db,body.get('workerId'))
        require(site and worker and worker['company']==user['company'] and worker['role']=='worker' and worker['active'], '현장과 작업자를 확인해 주세요.')
        site = json.loads(site['data'])
        start,end = stamp(body.get('plannedStart')),stamp(body.get('plannedEnd'))
        require(end>start,'예정 종료는 시작 이후여야 해요.')
        aid = aid or uid()
        assignment={'id':aid,'company':user['company'],'siteId':site['id'],'siteName':site['name'],'workerId':worker['id'],'workerName':worker['name'],'promiseDate':body['promiseDate'],'period':body['period'],'promiseVersion':1,'plannedStart':start,'plannedEnd':end,'occurrenceId':uid(),'siteSnapshot':site}
        db.execute('INSERT INTO assignments VALUES(?,?,?,?,?,?,?)',(aid,user['company'],worker['id'],site['id'],body['promiseDate'],body['period'],dumps(assignment)))
        self.audit(db,aid,user,'배정 생성',None,assignment)
        return self.detail(db,user,aid)

    def mutate(self, db, user, aid, action, body):
        assignment = self.access(db,user,aid)
        row = db.execute('SELECT data FROM logs WHERE assignment_id=?',(aid,)).fetchone()
        log = json.loads(row['data']) if row else None
        before = json.loads(dumps(log))
        reason = text(body.get('reason',''))
        admin_actions = ('review','return','adjust','correct')
        if action in admin_actions:
            require(user['role']=='admin','관리자만 할 수 있는 작업이에요.',403)
        else:
            require(user['role']=='worker' and user['id']==assignment['workerId'],'배정된 작업자만 기록할 수 있어요.',403)
        if action=='adjust':
            require(reason,'변경 사유를 입력해 주세요.')
            kind = body.get('kind')
            require(kind in ('schedule','promise'),'변경 종류를 확인해 주세요.')
            customer=body.get('customer',{})
            require(isinstance(customer,dict) and isinstance(customer.get('confirmed'),bool),'고객 확인 여부를 기록해 주세요.')
            customer={k:customer.get(k,'') for k in ('confirmed','name','method','at','evidence')}
            for k in ('name','method','evidence'):
                customer[k]=text(customer[k])
            if customer['confirmed']:
                require(customer['name'] and customer['method'] and customer['at'],'고객 확인 상대·방법·시각을 입력해 주세요.')
                customer['at']=stamp(customer['at'])
            old=json.loads(dumps(assignment))
            start,end=stamp(body.get('plannedStart')),stamp(body.get('plannedEnd'))
            require(end>start,'예정 종료는 시작 이후여야 해요.')
            assignment.update(plannedStart=start,plannedEnd=end)
            if kind=='promise':
                require(customer['confirmed'],'약속 날짜 변경은 고객 확인이 필요해요.')
                promise(body.get('promiseDate'),body.get('period'))
                assignment.update(promiseDate=body['promiseDate'],period=body['period'],promiseVersion=assignment['promiseVersion']+1)
            assignment['lastCustomerConfirmation']=customer
            db.execute('UPDATE assignments SET promise_date=?,period=?,data=? WHERE id=?',(assignment['promiseDate'],assignment['period'],dumps(assignment),aid))
            self.audit(db,aid,user,'실행 예정 조정' if kind=='schedule' else '고객 약속 변경',old,assignment,reason)
            return self.detail(db,user,aid)
        if action=='arrive':
            if log:
                return self.detail(db,user,aid)
            log={'id':uid(),'status':'arrived','arrivedAt':now(),'startedAt':None,'endedAt':None,'submittedAt':None,'reviewedAt':None,'version':0,'note':'','checks':{item['id']:{'status':'pending','reason':''} for item in assignment['siteSnapshot']['checklist']}}
        else:
            require(log,'먼저 현장 도착을 기록해 주세요.',409,'state')
        if action=='start':
            if log.get('startedAt'):
                return self.detail(db,user,aid)
            require(log['status']=='arrived','시작할 수 없는 상태예요.',409,'state')
            for other in db.execute('SELECT l.data FROM logs l JOIN assignments a ON a.id=l.assignment_id WHERE a.worker_id=? AND a.company=? AND a.id<>?',(user['id'],user['company'],aid)):
                other_log=json.loads(other['data'])
                require(not(other_log.get('startedAt') and not other_log.get('endedAt')),'종료하지 않은 다른 현장이 있어요. 먼저 종료해 주세요.',409,'open_work')
            log.update(status='working',startedAt=now())
        elif action=='stop':
            if log.get('endedAt'):
                return self.detail(db,user,aid)
            require(log['status']=='working','작업 시작 후 종료할 수 있어요.',409,'state')
            end=now()
            require(end>=log['startedAt'],'서버 시각을 확인해 주세요.',409)
            log.update(status='ended',endedAt=end)
        elif action=='save':
            require(log['status'] in ('arrived','working','ended','revision_requested'),'제출 후에는 보완 요청 전까지 변경할 수 없어요.',409,'locked')
            require(body.get('version')==log['version'],'다른 화면에서 기록이 바뀌었어요. 새로 불러온 후 다시 저장해 주세요.',409,'version_conflict')
            checks=body.get('checks')
            require(isinstance(checks,dict) and set(checks)==set(log['checks']),'청소 항목을 다시 확인해 주세요.')
            cleaned={}
            for item_id,item in checks.items():
                require(isinstance(item,dict) and item.get('status') in ('pending','done','skipped'),'항목 처리 상태를 확인해 주세요.')
                cleaned[item_id]={'status':item['status'],'reason':text(item.get('reason',''),500)}
            log.update(checks=cleaned,note=text(body.get('note',''),4000))
        elif action=='submit':
            if log['status'] in ('submitted','reviewed'):
                return self.detail(db,user,aid)
            require(log['status'] in ('ended','revision_requested') and log.get('endedAt'),'실제 종료를 먼저 기록해 주세요.',409,'state')
            require(all(v['status']=='done' or (v['status']=='skipped' and v['reason']) for v in log['checks'].values()),'모든 항목을 처리하고 미실시 사유를 입력해 주세요.',409,'missing_checks')
            for stage,field in [('before','requiredBefore'),('after','requiredAfter')]:
                count=db.execute('SELECT COUNT(*) FROM photos WHERE assignment_id=? AND stage=?',(aid,stage)).fetchone()[0]
                require(count>=assignment['siteSnapshot'][field],'전·후 필수 사진을 서버에 전송한 뒤 제출해 주세요.',409,'missing_photos')
            log.update(status='submitted',submittedAt=now())
        elif action=='review':
            if log['status']=='reviewed':
                return self.detail(db,user,aid)
            require(log['status']=='submitted','제출된 일지만 확인할 수 있어요.',409,'state')
            log.update(status='reviewed',reviewedAt=now(),reviewer=user['name'])
        elif action=='return':
            require(log['status']=='submitted' and reason,'검토 대기 일지의 보완 사유를 입력해 주세요.',409,'state')
            log.update(status='revision_requested',returnReason=reason)
        elif action=='correct':
            require(reason and log.get('startedAt') and log.get('endedAt'),'종료된 기록의 정정 사유를 입력해 주세요.')
            start,end=stamp(body.get('startedAt')),stamp(body.get('endedAt'))
            require(end>=start,'실제 종료가 시작보다 빠를 수 없어요.')
            require(start>=log['arrivedAt'],'시작은 도착 이후여야 해요.')
            log.update(startedAt=start,endedAt=end)
        elif action not in ('arrive','start','stop','save','submit','review','return','correct'):
            raise Problem('없는 작업이에요.',404)
        log['version']+=1
        db.execute('INSERT INTO logs VALUES(?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET data=excluded.data',(log['id'],aid,dumps(log)))
        labels={'arrive':'현장 도착','start':'작업 시작','stop':'작업 종료','save':'항목·메모 저장','submit':'일지 제출','review':'관리자 확인','return':'보완 요청','correct':'실제 시각 정정'}
        self.audit(db,aid,user,labels[action],before,log,reason)
        return self.detail(db,user,aid)

    def photo(self, db, user, aid, body):
        assignment=self.access(db,user,aid)
        require(user['role']=='worker' and assignment['workerId']==user['id'],'배정된 작업자만 사진을 보낼 수 있어요.',403)
        logrow=db.execute('SELECT data FROM logs WHERE assignment_id=?',(aid,)).fetchone()
        require(logrow,'도착을 먼저 기록해 주세요.',409)
        log=json.loads(logrow['data'])
        upload_id=text(body.get('uploadId',''),100)
        require(re.fullmatch(r'[A-Za-z0-9_-]{8,100}',upload_id),'사진 전송 식별자가 올바르지 않아요.')
        existing=db.execute('SELECT id FROM photos WHERE assignment_id=? AND upload_id=?',(aid,upload_id)).fetchone()
        if existing:
            return self.detail(db,user,aid)
        require(log['status'] in ('arrived','working','ended','revision_requested'),'제출 후 사진을 변경할 수 없어요.',409)
        require(body.get('stage') in ('before','after'),'전·후 사진을 선택해 주세요.')
        require(db.execute('SELECT COUNT(*) FROM photos WHERE assignment_id=?',(aid,)).fetchone()[0]<12,'사진은 일지당 12장까지 보낼 수 있어요.',413)
        item_id=body.get('itemId') or None
        require(not item_id or item_id in log['checks'],'사진에 연결할 항목을 확인해 주세요.')
        try:
            raw=base64.b64decode(body.get('content',''),validate=True)
        except (ValueError,TypeError):
            raise Problem('사진 데이터가 손상됐어요.')
        require(0<len(raw)<=5*1024*1024,'사진당 최대 5MB까지 전송할 수 있어요.',413)
        mime='image/png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if raw.startswith(b'\xff\xd8\xff') else 'image/webp' if raw.startswith(b'RIFF') and raw[8:12]==b'WEBP' else None
        require(mime,'JPG·PNG·WebP 사진만 전송할 수 있어요.')
        name=text(body.get('name','사진'),160)
        photo_id=uid()
        path=self.directory/'photos'/photo_id
        path.write_bytes(raw)
        db.execute('INSERT INTO photos VALUES(?,?,?,?,?,?,?,?,?,?)',(photo_id,aid,upload_id,user['id'],body['stage'],name,len(raw),mime,item_id,now()))
        self.audit(db,aid,user,'사진 전송',None,{'id':photo_id,'stage':body['stage'],'name':name,'size':len(raw),'itemId':item_id})
        return self.detail(db,user,aid)

class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self, address, store):
        super().__init__(address,Handler)
        self.store=store
        self.failures={}
        self.failure_lock=threading.Lock()

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    server_version='CleaningLab/1'

    def handle_one_request(self):
        # A mobile browser may close a keep-alive socket between requests.
        # This is transport cleanup, not a failed save or an application error.
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            self.close_connection=True

    def log_message(self, fmt, *args):
        # Do not write passwords, bodies, cookies or query parameters to logs.
        print('%s %s %s' % (now(), self.command, urlparse(self.path).path),flush=True)

    def send(self, status, data, mime='application/json; charset=utf-8', cookie=None):
        raw=dumps(data).encode() if not isinstance(data,bytes) else data
        if status < 400 and getattr(self,'request_db',None) is not None:
            self.request_db.commit()
        self.send_response(status)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie',cookie)
        self.end_headers()
        self.wfile.write(raw)

    def identity(self, db, mutate=False):
        cookie=SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie',''))
        except Exception:
            pass
        token=cookie.get('cleanlab_session')
        session=db.execute('SELECT * FROM sessions WHERE token=? AND expires>?',(token.value if token else '',time.time())).fetchone()
        require(session,'로그인이 필요해요.',401,'unauthorized')
        user=self.server.store.user(db,session['user_id'])
        require(user and user['active'],'사용할 수 없는 계정이에요.',403,'inactive')
        if mutate:
            require(hmac.compare_digest(self.headers.get('X-CSRF-Token',''),session['csrf']),'화면을 새로 열고 다시 시도해 주세요.',403,'csrf')
        user.pop('active',None)
        return user,session

    def body(self):
        require(self.headers.get('Content-Type','').split(';')[0]=='application/json','JSON 요청이 필요해요.',415)
        try:
            length=int(self.headers.get('Content-Length','0'))
        except ValueError:
            raise Problem('요청 길이가 올바르지 않아요.')
        require(0<length<=7*1024*1024,'요청이 너무 크거나 비어 있어요.',413)
        try:
            body=json.loads(self.rfile.read(length))
        except (ValueError,UnicodeDecodeError):
            raise Problem('입력 형식을 확인해 주세요.')
        require(isinstance(body,dict),'입력 형식을 확인해 주세요.')
        return body

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, mutate):
        self.request_db=None
        try:
            path=urlparse(self.path).path
            if not path.startswith('/api/'):
                require(not mutate,'허용되지 않는 요청이에요.',405)
                filenames={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'}
                require(path in filenames,'없는 페이지예요.',404)
                file=ROOT/'web'/filenames[path]
                require(file.exists(),'화면을 준비 중이에요.',503)
                mime={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'}[file.suffix[1:]]
                self.send(200,file.read_bytes(),mime)
                return
            if path=='/api/health' and not mutate:
                self.send(200,{'ok':True,'environment':'isolated-synthetic-lab','serverTime':now()})
                return
            if mutate:
                origin=self.headers.get('Origin')
                require(not origin or urlparse(origin).netloc==self.headers.get('Host'),'다른 사이트의 요청은 허용하지 않아요.',403,'origin')
            with self.server.store.lock, self.server.store.connect() as db:
                self.request_db=db
                body=self.body() if mutate else {}
                if path=='/api/login' and mutate:
                    key=self.client_address[0]
                    with self.server.failure_lock:
                        failures=[t for t in self.server.failures.get(key,[]) if t>time.time()-60]
                        self.server.failures[key]=failures
                    require(len(failures)<20,'로그인 시도가 많아요. 1분 후 다시 시도해 주세요.',429,'rate_limit')
                    username=text(body.get('username',''),80)
                    password=text(body.get('password',''),256)
                    row=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
                    valid=hmac.compare_digest(password_hash(password,row['salt'] if row else '00'*16),row['hash'] if row else '00'*64)
                    if not row or not valid or not row['active']:
                        with self.server.failure_lock:
                            self.server.failures[key].append(time.time())
                        raise Problem('아이디와 비밀번호 또는 계정 상태를 확인해 주세요.',401,'login_failed')
                    token,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
                    db.execute('DELETE FROM sessions WHERE expires<?',(time.time(),))
                    db.execute('INSERT INTO sessions VALUES(?,?,?,?)',(token,row['id'],csrf,time.time()+12*3600))
                    user=self.server.store.user(db,row['id']);user.pop('active',None)
                    self.send(200,{'user':user,'csrf':csrf},cookie=f'cleanlab_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200')
                    return
                user,session=self.identity(db,mutate)
                if path=='/api/logout' and mutate:
                    db.execute('DELETE FROM sessions WHERE token=?',(session['token'],))
                    self.send(200,{'ok':True},cookie='cleanlab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
                    return
                if path=='/api/me' and not mutate:
                    self.send(200,{'user':user,'csrf':session['csrf']})
                    return
                if path=='/api/bootstrap' and not mutate:
                    query='SELECT id FROM assignments WHERE company=?'
                    params=[user['company']]
                    if user['role']!='admin':
                        query+=' AND worker_id=?';params.append(user['id'])
                    assignments=[self.server.store.detail(db,user,r['id']) for r in db.execute(query+' ORDER BY promise_date,period,id',params)]
                    site_ids={a['siteId'] for a in assignments}
                    sites=[json.loads(r['data']) for r in db.execute('SELECT id,data FROM sites WHERE company=?',(user['company'],)) if user['role']=='admin' or r['id'] in site_ids]
                    workers=[dict(r) for r in db.execute("SELECT id,name FROM users WHERE company=? AND role='worker' AND active=1",(user['company'],))] if user['role']=='admin' else []
                    self.send(200,{'user':user,'csrf':session['csrf'],'sites':sites,'workers':workers,'assignments':assignments,'serverTime':now()})
                    return
                if path=='/api/sites' and mutate:
                    require(user['role']=='admin','관리자만 현장을 등록할 수 있어요.',403)
                    name=text(body.get('name',''),120)
                    labels=body.get('checklist')
                    require(name and isinstance(labels,list) and 1<=len(labels)<=30,'현장명과 1~30개 청소 항목을 입력해 주세요.')
                    checklist=[{'id':uid(),'label':text(v,120)} for v in labels]
                    require(all(v['label'] for v in checklist),'빈 청소 항목을 확인해 주세요.')
                    site={'id':uid(),'company':user['company'],'name':name,'address':text(body.get('address',''),500),'instructions':text(body.get('instructions',''),2000),'checklist':checklist,'requiredBefore':1,'requiredAfter':1}
                    for period in ('am','pm'):
                        start=body.get(period+'Start','05:00' if period=='am' else '19:00')
                        require(isinstance(start,str) and re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d',start),'현장 기본 시각을 확인해 주세요.')
                        minutes=body.get(period+'Minutes',120)
                        require(type(minutes)==int and 1<=minutes<=1440,'예상 소요시간은 1~1440분으로 입력해 주세요.')
                        site.update({period+'Start':start,period+'Minutes':minutes})
                    db.execute('INSERT INTO sites VALUES(?,?,?)',(site['id'],user['company'],dumps(site)))
                    self.send(201,site);return
                if path=='/api/assignments' and mutate:
                    result=self.server.store.create_assignment(db,user,body)
                    self.send(201,result);return
                match=re.fullmatch(r'/api/assignments/([A-Za-z0-9_-]+)(?:/([a-z]+))?',path)
                if match:
                    aid,action=match.groups()
                    if not mutate and not action:
                        result=self.server.store.detail(db,user,aid)
                    elif mutate and action=='photos':
                        result=self.server.store.photo(db,user,aid,body)
                    elif mutate and action:
                        result=self.server.store.mutate(db,user,aid,action,body)
                    else:
                        raise Problem('허용되지 않는 요청이에요.',405)
                    self.send(200,result);return
                match=re.fullmatch(r'/api/photos/([A-Za-z0-9_-]+)',path)
                if match and not mutate:
                    row=db.execute('SELECT * FROM photos WHERE id=?',(match[1],)).fetchone()
                    require(row,'없는 사진이에요.',404)
                    self.server.store.access(db,user,row['assignment_id'])
                    file=self.server.store.directory/'photos'/row['id']
                    require(file.exists(),'사진 원본을 찾을 수 없어요.',404)
                    self.send(200,file.read_bytes(),row['mime']);return
                raise Problem('없는 기능이에요.',404)
        except Problem as error:
            self.close_connection=True
            self.send(error.status,{'error':error.message,'code':error.code})
        except sqlite3.IntegrityError:
            self.close_connection=True
            self.send(409,{'error':'같은 현장·작업자·약속 구간의 배정이 이미 있어요.','code':'duplicate'})
        except (BrokenPipeError,ConnectionResetError):
            self.close_connection=True
        except Exception as error:
            self.close_connection=True
            print('Internal error:',type(error).__name__,str(error),flush=True)
            self.send(500,{'error':'서버 저장에 실패했어요. 기록을 다시 확인하고 재시도해 주세요.','code':'server_error'})

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=8791)
    parser.add_argument('--data',default=str(ROOT/'data'))
    args=parser.parse_args()
    store=Store(args.data)
    server=Server((args.host,args.port),store)
    print(f'ISOLATED TEST APP http://{args.host}:{server.server_port} · synthetic data only',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__=='__main__':
    main()
