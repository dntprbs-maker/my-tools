from pathlib import Path
root=Path(__file__).resolve().parents[1]
index=root/'public/index.html'
html=index.read_text(encoding='utf-8').replace('href="/favicon.svg"','href="./favicon.svg"').replace('href="/styles.css"','href="./styles.css"').replace('src="/app.mjs"','src="./app.mjs"')
index.write_text(html,encoding='utf-8')
file=root/'public/app.mjs'
app=file.read_text(encoding='utf-8')
if 'const basePath=' in app:
 print('Already prepared');raise SystemExit(0)
app=app.replace("const main=document.querySelector('main');", "const basePath=new URL('.',import.meta.url).pathname.replace(/\\/$/,'');\nconst showcase=basePath!=='';\nconst main=document.querySelector('main');")
app=app.replace("const path=location.pathname.replace(/\\/$/,'')||'/';", "const path=showcase?('/'+(new URLSearchParams(location.search).get('page')||'')):(location.pathname.replace(/\\/$/,'')||'/');")
app=app.replace('function quotePage(){return intro(', "function quotePage(){if(showcase)return showcaseNotice('견적 신청');return intro(")
app=app.replace('function lookupPage(){return intro(', "function lookupPage(){if(showcase)return showcaseNotice('신청 내역 조회');return intro(")
notice='''function showcaseNotice(title){return intro('WEBSITE PREVIEW',title,'현재는 홈페이지 구성과 화면을 확인하는 미리보기입니다.')+`<section class="wrap narrow"><div class="info-box"><h2>실제 견적 접수는 준비 중이에요.</h2><p>이 웹 미리보기에서는 이름·연락처를 수집하거나 견적을 저장하지 않습니다. 신청 및 비밀키 조회 체험은 PC의 별도 로컬 서버에서 제공됩니다.</p><p>실제 상담 채널과 서비스 정책이 확정되면 접수 기능을 연결할 예정입니다.</p><a class="button" href="/services">서비스 안내 살펴보기 ↗</a></div></section>`;}
'''
app=app.replace('const pages=',notice+'const pages=')
app=app.replace('src="/assets/','src="${basePath}/assets/').replace('srcset="/assets/','srcset="${basePath}/assets/').replace(', /assets/',', ${basePath}/assets/').replace('`/assets/${c.space}-1600.webp`','`${basePath}/assets/${c.space}-1600.webp`')
portable='''if(showcase){
 document.querySelectorAll('a[href^="/"]').forEach(a=>{const u=new URL(a.getAttribute('href'),location.origin);const q=new URLSearchParams(u.search);const route=u.pathname.replace(/^\\/|\\/$/g,'');if(route)q.set('page',route);a.setAttribute('href',basePath+'/'+(q.size?'?'+q.toString():'')+u.hash);});
 document.querySelector('#notice p').textContent='실제 전화번호와 카카오톡 상담 채널은 준비 중입니다. 웹 미리보기에서는 개인정보를 수집하지 않습니다.';
 document.querySelector('#notice .button').textContent='견적 접수 안내 보기 ↗';
 document.querySelectorAll('nav a').forEach(a=>{if(('/'+(new URL(a.href).searchParams.get('page')||''))===path)a.setAttribute('aria-current','page');});
}
'''
app=app.replace("document.querySelectorAll('[data-brand]')",portable+"document.querySelectorAll('[data-brand]')")
file.write_text(app,encoding='utf-8');print('Portable showcase prepared')
