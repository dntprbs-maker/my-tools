# AI Usage Monitor (Windows)

이 PC에 로그인된 **Claude Code**와 **Codex** 계정의 실제 사용량(5시간·주간 한도)을 직접 읽어
독립된 Windows 창에 보여 주는 무설치 프로그램입니다. 화면은 `../ai-usage-calculator`의 UI를 그대로 재사용합니다.
(`ai-usage-calculator`와 `usage-history.jsonl`은 이 프로그램과 별개이며 건드리지 않습니다.)

## 사용법

- 바탕화면 `AI Usage Monitor` 바로가기(또는 `AI Usage Monitor.exe`)를 더블클릭 → 독립 창이 뜹니다.
- 실행하면 마지막으로 저장된 값을 먼저 보여 줍니다. 시간경과·남은시간은 현재 시각 기준으로 계산됩니다.
- **↻ 새로고침**을 누를 때만 Claude·Codex 서버에 조회합니다(자동 조회 없음).
- 한쪽 조회가 실패해도 다른 쪽 새 값은 저장되고, 실패한 쪽은 마지막 정상값과 ⚠ 상태가 표시됩니다.
- Claude가 429(요청 제한)를 주면 서버가 알려 준 대기시간 동안은 새로고침을 눌러도 Claude를 다시 부르지 않습니다.

## 구조

| 경로 | 역할 |
|---|---|
| `app/` | 화면(HTML/CSS/JS) — ai-usage-calculator 복사본, 데이터 출처만 로컬 서버로 변경 |
| `collector/collector.py` | Claude/Codex 사용량 조회, Claude 로그인 만료 시 안전 갱신, `usage.json` 저장 |
| `monitor.pyw` | 127.0.0.1 전용 로컬 서버(임의 포트) + WebView2 창(pywebview) |
| `build.bat` | PyInstaller로 `dist\AI Usage Monitor\AI Usage Monitor.exe` 빌드 |
| `data/usage.json` | 최신 조회 결과 1개(덮어쓰기). **Git 제외** |

## 조회 방식

- Claude: `~/.claude/.credentials.json`의 로그인으로 `GET https://api.anthropic.com/api/oauth/usage`.
  access token이 만료됐으면 refresh token으로 갱신해 같은 파일에 원자적으로 저장(직전본 `.bak-monitor` 1개 보관).
- Codex: `~/.codex/auth.json`의 로그인으로 `GET https://chatgpt.com/backend-api/wham/usage` (읽기 전용).

## 보안

- 토큰은 화면·로그·`usage.json` 어디에도 넣지 않습니다.
- 로컬 서버는 `127.0.0.1`에만 바인딩하고, 다른 Host/Origin 요청은 403으로 거부합니다.
- `data/`, 인증 파일, 백업, 빌드 산출물은 `.gitignore`로 차단합니다.

## 빌드

```bat
build.bat
```

필요: Python 3.13, WebView2 런타임(Windows 11 기본 포함). 결과 폴더 `dist\AI Usage Monitor`를 통째로 원하는 위치에 복사해 쓰면 됩니다
(이 PC 설치 위치: `%LOCALAPPDATA%\Programs\AI Usage Monitor`).
