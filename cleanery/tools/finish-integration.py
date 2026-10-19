from pathlib import Path
root=Path(__file__).resolve().parents[2]
appfile=root/'cleanery/public/app.mjs'
app=appfile.read_text(encoding='utf-8')
privacy="""function privacyPage(){if(showcase)return intro('PRIVACY','개인정보처리방침','웹 미리보기 안내')+'<section class="wrap narrow legal"><h2>개인정보를 수집하지 않는 미리보기</h2><p>이 웹 미리보기에는 고객 견적 입력·저장·조회 기능을 연결하지 않았습니다. 개인정보 입력, 외부 발송, 결제, 분석·광고 추적을 수행하지 않습니다.</p><h2>별도 로컬 체험</h2><p>PC의 별도 로컬 서버에서 사용하는 견적 저장·조회 체험은 해당 서버의 개인정보 안내를 따릅니다. 실제 운영 시 별도 보유기간·책임자·연락처·보안 정책을 확정해야 합니다.</p></section>';return intro("""
app=app.replace('function privacyPage(){return intro(',privacy)
appfile.write_text(app,encoding='utf-8')
index=root/'index.html';html=index.read_text(encoding='utf-8')
shortcut='<a class="app" href="./cleanery/"><div class="icon">🏡</div><div class="app-name">크리너리<br>입주청소</div></a>'
if 'href="./cleanery/"' not in html:html=html.replace('</section></main>',shortcut+'\n</section></main>')
index.write_text(html,encoding='utf-8')
readme=root/'README.md';text=readme.read_text(encoding='utf-8')
if '| 크리너리 입주청소 |' not in text:text=text.replace('## 관리 원칙','| 크리너리 입주청소 | [`cleanery/`](./cleanery/) | 입주청소 홈페이지 화면 미리보기 · 로컬 전체 기능 소스 | 연결 검증 중 |\n\n## 관리 원칙')
readme.write_text(text,encoding='utf-8');print('Shortcut and preview policy prepared')
