"""Generate synthetic UI snapshots using the real Store; not HTTP verification."""
import base64
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

root=Path(__file__).resolve().parents[1]
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c2ioAAAAASUVORK5CYII=')
with tempfile.TemporaryDirectory(dir=root/'evidence') as tmp:
    store=server.Store(tmp)
    with store.connect() as db:
        worker=store.user(db,'w1');admin=store.user(db,'a1')
        fixture={'worker':worker,'admin':admin,'states':{},'png':base64.b64encode(png).decode()}
        fixture['sites']=[json.loads(r['data']) for r in db.execute('SELECT data FROM sites WHERE company=?',('lab-a',))]
        fixture['workers']=[{'id':'w1','name':worker['name']},{'id':'w2','name':store.user(db,'w2')['name']}]
        fixture['assignments']=[store.detail(db,worker,aid) for aid in ('demo-1','demo-2','demo-5')]
        fixture['states']['unwritten']=store.detail(db,worker,'demo-1')
        for action in ('arrive','start'):
            fixture['states'][action]=store.mutate(db,worker,'demo-1',action,{})
        log=fixture['states']['start']['log']
        fixture['states']['save']=store.mutate(db,worker,'demo-1','save',{'version':log['version'],'note':'모바일 검증 메모','checks':{k:{'status':'done','reason':''} for k in log['checks']}})
        for stage in ('before','after'):
            fixture['states'][stage]=store.photo(db,worker,'demo-1',{'uploadId':'fixture-photo-'+stage,'stage':stage,'name':stage+'.png','content':base64.b64encode(png).decode()})
        for action,user in [('stop',worker),('submit',worker),('review',admin)]:
            fixture['states'][action]=store.mutate(db,user,'demo-1',action,{})
    (root/'evidence'/'ui-fixtures.json').write_text(json.dumps(fixture,ensure_ascii=False),encoding='utf-8')
print('UI fixtures generated from real Store; transport/UI tests remain separate from real HTTP/device verification.')
