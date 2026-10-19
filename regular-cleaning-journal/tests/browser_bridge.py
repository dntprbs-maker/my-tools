"""Socket-free test transport, invoking real HTTP handler + persistent SQLite.

Only the automated browser test uses this adapter. The app has no bypass login.
This never opens a network connection or changes an operating-system permission.
"""
import base64
import io
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

store=server.Store(sys.argv[1])
app=SimpleNamespace(store=store,failures={},failure_lock=threading.Lock())
for line in sys.stdin:
    try:
        request=json.loads(line)
        handler=object.__new__(server.Handler)
        handler.server=app
        handler.command=request.get('method','GET')
        handler.path=request['path']
        handler.client_address=('browser-test',0)
        body=request.get('body','').encode()
        from email.message import Message
        headers=Message()
        for key,value in request.get('headers',{}).items():
            headers[key]=value
        headers['Host']='cleaning.test'
        headers['Content-Length']=str(len(body))
        handler.headers=headers
        handler.rfile=io.BytesIO(body)
        handler.wfile=io.BytesIO()
        handler.close_connection=True
        result={'headers':{}}
        def capture(status,data,mime='application/json; charset=utf-8',cookie=None):
            if status<400 and handler.request_db is not None:
                handler.request_db.commit()
            result.update(status=status,body=base64.b64encode(data if isinstance(data,bytes) else server.dumps(data).encode()).decode())
            result['headers']['content-type']=mime
            if cookie:
                result['headers']['set-cookie']=cookie
        handler.send=capture
        handler.handle_request(handler.command=='POST')
        print(json.dumps(result),flush=True)
    except Exception as error:
        print(json.dumps({'status':500,'headers':{'content-type':'application/json'},'body':base64.b64encode(json.dumps({'error':str(error)}).encode()).decode()}),flush=True)
