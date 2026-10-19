"""Real HTTP readback before/after the isolated test server restarts."""
import hashlib
import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.request

root=Path(__file__).resolve().parents[1]
jar=http.cookiejar.CookieJar()
client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def request(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:8791'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    with client.open(req,timeout=10) as response:
        raw=response.read()
        return json.loads(raw) if response.headers['Content-Type'].startswith('application/json') else raw
request('/api/login',{'username':'admin','password':'Admin-test-2026!'})
data=request('/api/bootstrap')
snapshot={}
for assignment in data['assignments']:
    if assignment['log']:
        snapshot[assignment['id']]={'promiseDate':assignment['promiseDate'],'period':assignment['period'],'log':assignment['log'],'audit':assignment['audit'],'photoHashes':{photo['id']:hashlib.sha256(request(photo['url'])).hexdigest() for photo in assignment['log']['photos']}}
target=root/'evidence'/'live-restart-before.json'
if sys.argv[1]=='before':
    target.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
else:
    previous=json.loads(target.read_text(encoding='utf-8'))
    for record in snapshot.values():
        if record['log']['status']=='working':
            record['log'].pop('elapsedSeconds',None)
    for record in previous.values():
        if record['log']['status']=='working':
            record['log'].pop('elapsedSeconds',None)
    assert snapshot==previous,'Restart changed stored records or original photo bytes'
    (root/'evidence'/'live-restart-result.json').write_text(json.dumps({'ok':True,'records':len(snapshot),'photos':sum(len(r['photoHashes']) for r in snapshot.values()),'verification':'real server process restart + HTTP readback + photo SHA-256'},indent=2),encoding='utf-8')
print(sys.argv[1],len(snapshot),'records')
