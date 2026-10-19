"""Negative authorization checks against the actual isolated HTTP server."""
import http.cookiejar
import json
from pathlib import Path
import urllib.error
import urllib.request

root=Path(__file__).resolve().parents[1]
assignment=json.loads((root/'evidence/phone-e2e.json').read_text(encoding='utf-8'))['assignment']['id']
checks=[]
def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def request(opener,path,body=None,csrf=None):
    headers={'Content-Type':'application/json'}
    if csrf: headers['X-CSRF-Token']=csrf
    req=urllib.request.Request('http://127.0.0.1:8791'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    try:
        with opener.open(req,timeout=10) as response:
            return response.status,json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code,json.loads(error.read())
def verify(label,actual,expected):
    assert actual==expected,(label,actual,expected)
    checks.append(label); print('PASS',label)
own=client();status,auth=request(own,'/api/login',{'username':'worker','password':'Worker-test-2026!'})
verify('본인 로그인',status,200)
status,detail=request(own,'/api/assignments/'+assignment);verify('본인 완료 기록 조회',status,200)
photo=detail['log']['photos'][0]['id']
anonymous=client();verify('비로그인 사진 직접 접근 차단',request(anonymous,'/api/photos/'+photo)[0],401)
outsider=client();verify('다른 회사 테스트 로그인',request(outsider,'/api/login',{'username':'other','password':'Other-test-2026!'})[0],200)
verify('다른 회사 일지 직접 접근 차단',request(outsider,'/api/assignments/'+assignment)[0],404)
verify('다른 회사 사진 직접 접근 차단',request(outsider,'/api/photos/'+photo)[0],404)
verify('비활성 계정 로그인 차단',request(client(),'/api/login',{'username':'inactive','password':'Inactive-test-2026!'})[0],401)
verify('잘못된 CSRF 쓰기 차단',request(own,'/api/assignments/'+assignment+'/save',{},'incorrect-token')[0],403)
verify('작업자 관리자 현장 생성 차단',request(own,'/api/sites',{'name':'unauthorized'},auth['csrf'])[0],403)
after=request(own,'/api/assignments/'+assignment)[1]
assert after['log']['status']=='reviewed' and len(after['log']['photos'])==2
verify('거부된 요청 이후 원본 완료기록 보존',after['log']['version'],detail['log']['version'])
(root/'evidence/live-security.json').write_text(json.dumps({'ok':True,'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
