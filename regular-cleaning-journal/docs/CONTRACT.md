# 정기청소 독립 테스트 앱

계획서/PDF(2026-10-17)와 작업 원장(2026-10-19)을 구현 기준으로 한다. 운영 시스템과 연동하지 않는 합성 데이터 전용 로컬 테스트 환경. 외부 의존성 없는 Python HTTP + SQLite + 정적 HTML/CSS/JS. 파일은 이 폴더 안에서만 변경한다. 배포/운영 데이터 이전/기존 프로젝트 변경 금지.

## 서버 계약
- 쿠키 세션, 모든 쓰기(로그인 제외)에 `X-CSRF-Token`. GET /api/me -> {user:{id,name,role,company},csrf}; POST /api/login {username,password} -> 같은 형태. POST /api/logout.
- 테스트 계정 worker / Worker-test-2026!, admin / Admin-test-2026!, worker2 / Worker2-test-2026!, other / Other-test-2026!, inactive / Inactive-test-2026! (테스트 로그인 화면에 worker/admin 안내). 역할 선택으로 로그인하지 않음.
- GET /api/bootstrap -> {user,csrf,sites,workers,assignments,serverTime}. assignments 각 원소는 아래 상세와 동일. workers는 관리자만. workers 원소 {id,name}.
- assignment: {id,company,siteId,siteName,workerId,workerName,promiseDate,period:'AM'|'PM',promiseVersion,plannedStart,plannedEnd,occurrenceId,siteSnapshot:{address,instructions,checklist:[{id,label}],requiredBefore:1,requiredAfter:1},log:null|{id,status,arrivedAt,startedAt,endedAt,submittedAt,reviewedAt,version,note,checks:{[itemId]:{status:'pending'|'done'|'skipped',reason}},photos:[{id,stage,name,size,url,itemId}],elapsedSeconds},audit:[{id,at,actor,action,reason,before,after}]}
- GET /api/assignments/:id -> assignment. GET /api/photos/:id -> 인증/회사/배정 검증 후 이미지.
- POST /api/assignments/:id/arrive, /start, /stop body {}. 서버 시각 사용, 중복 생성/미종료 중복 시작 차단. arrive -> arrived, start -> working, stop -> ended.
- POST /api/assignments/:id/save {version,note,checks} -> assignment. 버전 충돌 409. note/checks 변경 원본 보존.
- POST /api/assignments/:id/photos {uploadId:UUID,stage:'before'|'after',name,content:base64,itemId?:string} -> assignment. 사진당 5MB, 총 12장. 재시도 uploadId 중복 방지. 원본 저장/대기열은 브라우저 IndexedDB에 사용자+배정으로 분리. 실패는 대기, 서버 성공 후에만 큐 제거. 제출 전 서버 사진과 필수 항목 검사.
- POST /api/assignments/:id/submit {} -> assignment. ended/revision_requested -> submitted. POST /review {reason?:string} 관리자 -> reviewed. POST /return {reason} 관리자 -> revision_requested.
- POST /api/sites {name,address,instructions,checklist:[string],amStart:'05:00',amMinutes:150,pmStart:'19:00',pmMinutes:120} -> site.
- POST /api/assignments {siteId,workerId,promiseDate,period,plannedStart,plannedEnd} -> assignment. plannedStart/End ISO datetime timezone 필수. 관리자만, occurrence UUID 서버 생성. 약속 날짜/구간/현장/작업자 중복 방지.
- POST /api/assignments/:id/adjust {kind:'schedule'|'promise',plannedStart,plannedEnd,promiseDate?,period?,reason,customer:{confirmed:boolean,name,method,at,evidence}} -> assignment. 관리자만. promise는 고객확인 필수, 버전 증가. schedule은 약속 유지, 고객 확인 여부 이력 보존(미확인을 양해 완료로 표시 금지).
- POST /api/assignments/:id/correct {startedAt,endedAt,reason} 관리자. 시각 역전 차단, 원본과 이력 보존.
- 응답 오류 {error:쉬운한국어,code}; HTTP 400/401/403/404/409/413/429. 데이터는 {..} envelope 없이 직접 반환.

## 화면
차분한 청록/남색, 모바일 우선 360px 이상, 읽기 좋은 타이포와 큰 터치 영역. 로그인, 약속날짜 필터와 모든기록, 배정현장 카드(약속/실제 구분), 상세의 도착/시작/종료, 체크리스트 처리/미실시 사유, 전후사진 촬영/앨범과 전송 대기·재시도, 메모 저장, 종료 후 제출, 상태/서버접수시각 표시. 관리자 현황 필터(미작성/미시작/작업중/제출대기/검토대기/확인완료), 현장/배정 생성, 일지 검토/보완요청, 시각정정과 일정조정/약속변경, 펼칠 수 있는 수정이력. 삭제 버튼 없음. 저장/전송 실패를 성공으로 표시하지 않음. 모바일 하단 안전여백, 가로 스크롤 없음. 실제 운영과 무관한 테스트 데이터 배지 상시 표시.

## 검증
합성 데이터로 API 권한/상태/동시성/시간 경계/영구보존과 사진 재시도 테스트. 브라우저 데스크톱·모바일 viewport 왕복 기능/레이아웃/오프라인 복구 검증. 실제 휴대폰 연결 가능하면 기기 검증, 불가능하면 에뮬레이션과 구분해 미검증으로 기록.
