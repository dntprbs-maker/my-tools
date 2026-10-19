# 구현·검증 보고 — 2026-10-19

## 판정

**최종 판정: 독립 테스트 웹앱 구현·실제 HTTP 접속·실제 Android 휴대폰 검증 완료.** 이후 23시 재개에서 승인 검토가 정상화됐고, 네이티브 앨범·실제 카메라 촬영·제출·관리자 확인·전송 실패 복구·저속 통신·EXIF 회전·서버 재시작 보존까지 직접 통과했다. 최신 상세 결과는 [실제 검증 보고](LIVE-VERIFICATION.md)를 따른다. 운영 배포·운영 연동·실데이터 이전은 실행하지 않았다.

아래는 **13시대의 중간 검증 이력**을 보존한 것이다. 당시 미완료·연결 실패·사용량 미반영 상태는 최종 상태가 아니다. 낮의 사용량 이력도 밤에 GitHub 복구 반영을 재조회했다.

## 기준과 격리

- 작업: `[master-project] 정기청소 현장 출퇴근·작업일지 독립 웹앱 개발`
- 작업 원장: https://app.notion.com/p/master-project-3fe2d174b03c813a8975d00973da12e5
- [기존 개발 계획서](https://docs.google.com/document/d/1tv1OU6QWWDM2QWtj4lum5MuTPWL0LTW1MdebAOOX1Xs/edit), [동일 계획서 PDF](https://drive.google.com/file/d/1jGTuC3QbszZX5E3SmBlwURKVyXhKp4Ev/view)의 본문을 Google Drive 연결 도구로 읽었다. 원본 변경 없음. PDF 시안의 이미지 단위 시각 대조는 미검증.
- 기존 Clean-Manager의 attendance `useWorkLog.js`, `ClockScreen.jsx`, `lib/db.js`, 본체 `pendingUploads.js`를 읽어 참고했다. 기존 DB·코드·인증·배포 변경 명령을 실행하지 않았다. Git 상태 명령은 디렉터리 접근 제한으로 실패해 기존 저장소 전체 diff 청결성을 주장하지 않는다. 읽은 `.git/HEAD`는 main이다. 최신 원격 배포·로그인·운영 화면 회귀는 미검증이다.
- 모든 새 파일은 `C:/Users/user/projects/기본작업/regular-cleaning-lab`에 있다. 신규 Git 저장소·클라우드 프로젝트·결제·운영 데이터 이전·운영 배포 없음. 테스트 DB와 사진은 이 폴더의 `data/`에 격리한다.
- 기술 선택: 별도 외부 서비스 없이 재현 가능한 Python 표준라이브러리 HTTP API + SQLite 트랜잭션 + 원본 사진 파일 + 모바일 웹 UI. API 경계를 분리했으며 기존 프로젝트의 평문 비밀번호 비교나 브라우저 역할값을 권한 근거로 재사용하지 않았다.

## 실제 통과한 검증

부모 덱스D가 최종 코드에서 다시 실행했다.

| 구분 | 결과 | 범위 |
|---|---|---|
| Store·HTTP 처리기 | 10/10 통과 | 회사/배정/역할, 상태, 멱등, 미종료, 버전 충돌, 제출 필수값, 사진 중복·형식·크기, 보완·정정 이력, 날짜경계, 재오픈 |
| HTTP wire 통합 | 2/2 통과 | 실제 HTTP 요청 바이트 파싱→로그인 쿠키→도착·시작·저장·사진·종료·제출→관리자 확인→SQLite/파일 재오픈. 실제 응답 헤더·직렬화·Content-Length·CSP·CSRF·Origin·비인가 접근 검사. **FakeSocket을 사용해 네트워크 연결은 하지 않음. Handler.send는 모킹하지 않음.** |
| 화면 로직 회귀 | 9/9 통과 | 실제 app.js Node VM + DOM 모의환경. 제출 버튼 바인딩, 자기 큐만 차단, 미저장 차단, 409 초안 보존, KST 3개 시간대 동일, 익일 배정, HTML escape, 지원 사진 형식·장수 |
| 문법 | 통과 | Python compile, node --check web/app.js |
| 백업 | 생성 후 별도 검증 | SQLite backup API + 사진 원본 사본. 복원 DB의 무결성/사용자/배정 수를 원본과 비교 |

실제 명령:

```text
python -m unittest discover -s tests -v
# Ran 12 tests in 5.933s — OK
node tests/test_frontend.cjs
# 9 frontend VM regression checks passed
node --check web/app.js
python -m py_compile server.py backup.py
```

세부 결과: `evidence/backend-tests.txt`, `evidence/http-wire-tests.txt`, `evidence/frontend-tests.txt`. 위 통과 결과를 실제 모바일 브라우저 또는 실기기 통과로 바꿔 해석하지 않는다.

## 발견하고 고친 오류

1. 사진 INSERT 열 수 불일치 수정.
2. DB 연결 종료 및 성공 응답 전 commit 보장.
3. 기기 시간대 의존을 제거하고 KST 표시·입력·UTC 전송 고정.
4. 현장 기본 소요시간으로 배정 종료시각 계산, 익일 종료 처리.
5. 제출 버튼의 실제 핸들러 연결 누락을 부모 검수에서 발견해 수정.
6. 미저장 입력·전송 대기/저장 중 사진 제출 차단.
7. 버전 충돌 때 초안을 버리지 않고 최신 서버본과 함께 재검토하도록 수정.
8. 서버가 받지 않는 SVG/HEIC 등의 사진을 대기열에 넣기 전에 거절. 서버+대기+선택 총12장 제한.

## 실제 실행 시도와 미검증

- 서버 bind와 `ISOLATED TEST APP http://127.0.0.1:8791` 기동 로그는 확인했다. 이 주소는 **로컬 개발 설정 주소**이며 정상 접속이 검증된 테스트 서비스 주소가 아니다.
- 셸의 로컬 HTTP 연결은 `WinError 10013`(접근 권한 제한), 인앱 브라우저와 Aside는 `ERR_CONNECTION_TIMED_OUT`으로 실패했다.
- 허용 범위의 로컬 HTTP 확인을 위해 권한 검토를 요청했으나 `Automatic approval review failed: Selected model is at capacity`로 명령 자체가 실행되지 않았다. 아빠는 네트워크 접근을 이미 승인했다. 중복 승인 부족이 아니라 자동 검토 인프라 오류이며 안전성 거절이라는 판정은 아니다. 보안·승인 설정을 바꾸거나 우회하지 않았다.
- 격리된 합성 UI 응답으로 실제 브라우저만 검증하려던 Aside 실행도 같은 자동 검토 오류로 미실행. 준비된 UI fixture/harness는 검증 통과 근거가 아니다.
- Headless Edge는 AppContainer named pipe/프로세스 기동 오류로 실패. 일반 temp와 작업 폴더 temp 모두 같은 결과.
- 실제 기기: ADB daemon 시작 실패로 연결하지 못함. Android Chrome/iPhone Safari 촬영·앨범·회전·저속 통신·브라우저 재시작·뷰포트 레이아웃·터치 대상·가로 넘침은 미검증.
- 13:55 KST 아빠가 무선 디버깅 연결을 완료했다고 알려준 직후 `adb devices -l`을 다시 실행했다. 여전히 ADB 서버 접근 실패. 기기 목록의 읽기 전용 권한 검토도 같은 `Selected model is at capacity`로 미실행. 아빠의 연결 미완료나 승인 부족으로 기록하지 않는다. 실행 환경의 권한 검토 오류가 남아 있다.
- 같은 연결 목표에 대해 인앱 브라우저·headless 브라우저·Aside의 서로 다른 경로까지만 확인했다. 권한 우회나 반복 무한 재시도는 하지 않았다.

## 남은 작업

1. 정상 권한 검토/실행 환경에서 서버 재시작 후 HTTP 접속을 확인한다. `Start-Lab.ps1`와 준비된 테스트를 재사용한다.
2. 실제 브라우저의 360/390/430px 및 데스크톱 화면, 로그인부터 관리자 확인 왕복을 실제 HTTP API로 검증한다.
3. 실제 작업자·관리자 휴대폰에서 사진 촬영/앨범·저속/실패재시도·새로고침/재실행·권한차단을 검증한다. 실제 기기를 에뮬레이션으로 대체 완료 처리하지 않는다.
4. 서버의 이미지 완전 디코딩 검증, 운영 인증·재설정·HTTPS·보관정책·기기 호환성을 운영 전에 보완한다. 현재 이미지 판별은 파일 바이트 헤더 제한이며 손상 이미지 완전 검사는 아니다.
5. 운영 환경 생성/배포·클린매니저 연결·실제 데이터 이전은 별도 승인 범위로 남긴다. 현재 작업에서 실행하지 않는다.

## 보조장치 오류와 사용량

시작/종료 usage_log.py는 GitHub 연결 실패로 원격 이력 append 미반영. rules-check CLI도 DNS/네트워크 오류로 실패했고 마지막 확인값을 mark하지 않았다. 자동 시작 게이트는 변경 없음으로 보고했으며 공식 메모리허브 MCP로 공용 규칙 문서 목록을 다시 읽었다. Telegram 알림 실패 여부도 실제 호출 결과로 구분한다.

시작 게이트(13:35 KST)는 5시간25%·주간8%. 종료 보조 조회(mcp get_usage_limits, 13:56:51 KST)는 5시간53%·주간12%, 초기화는 각각 2026-10-19 16:16:10 KST / 2026-10-25 17:39:29 KST. script --fresh 자체 측정은 실패했다. 최초 게이트와 종료 보조 조회는 경로가 다르고 계정 한도는 다른 대화·작업과 공유하므로 +28%p/+4%p를 이 작업만의 순수 사용량으로 단정하지 않는다. 실제 측정값만 `evidence/usage-recovery.jsonl`에 남기고 GitHub 동기화 성공으로 보고하지 않는다. Telegram 개입 알림도 실제 호출했지만 `notify failed — fetch failed`로 전송 실패했다. 정상완료 알림은 전체 작업이 미완료이므로 보내지 않았다.

검증에 사용한 테스트 서버는 최종 정리에서 중지했다. 재개할 때 같은 실행 스크립트로 시작한다. 외부 서비스 주소는 발급하지 않았다.
