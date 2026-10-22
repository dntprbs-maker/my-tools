const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#nav');
toggle.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  nav.classList.toggle('open', open);
});
nav.addEventListener('click', e => { if(e.target.closest('a') && toggle.getAttribute('aria-expanded') === 'true') toggle.click(); });
const dialog = document.querySelector('#estimate');
document.querySelectorAll('[data-estimate]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if(e.target === dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();} });
document.addEventListener('keydown', e => {if(e.key==='Escape' && toggle.getAttribute('aria-expanded')==='true'){toggle.click();toggle.focus();}});
const scope = {
  window: ['창틀·베란다', '레일의 분진부터, 틈새까지.', ['창틀과 레일의 먼지·이물질 제거','안전하게 접근 가능한 실내 유리','베란다 바닥과 배수구 커버'], '외창·방충망 탈거·고소 작업은 별도 협의가 필요합니다.'],
  kitchen: ['주방·수납장', '생활의 기름때와 안쪽 먼지까지.', ['싱크볼·수전·상판 표면','상·하부장 내부와 선반','후드 외부와 분리 가능한 필터'], '가전 내부 분해·배관 공사·상판 연마는 별도 협의 항목입니다.'],
  bath: ['욕실·배수구', '매일 닿는 곳을, 구역별로.', ['세면대·수전·거울의 표면 오염','변기·샤워 공간과 타일 표면','배수구 커버와 환풍구 외부'], '실리콘 교체·줄눈 시공·깊게 침투한 곰팡이 제거는 별도 협의합니다.'],
  floor: ['방·바닥', '발이 닿는 바닥과 손이 닿는 표면.', ['바닥·걸레받이·문틀','붙박이장 내부 선반','스위치·문손잡이 표면'], '벽지 세척·무거운 가구 이동·고가 조명 분해는 기본 범위에 포함하지 않습니다.']
};
const tabs=[...document.querySelectorAll('[role=tab]')];
function selectTab(tab) {
  tabs.forEach(b=>{b.setAttribute('aria-selected',String(b===tab));b.tabIndex=b===tab?0:-1;});
  const data=scope[tab.dataset.scope];
  document.querySelector('#scope-title').textContent=data[1];
  document.querySelector('#scope-name').textContent=data[0];
  const list=document.querySelector('#scope-list');list.replaceChildren(...data[2].map(s=>{const li=document.createElement('li');li.textContent=s;return li;}));
  document.querySelector('#scope-except').textContent=data[3];
  document.querySelector('#scope-panel').setAttribute('aria-labelledby',tab.id);
}
tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[n].focus();selectTab(tabs[n]);}});});
