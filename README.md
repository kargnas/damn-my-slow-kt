# 🐌 damn-my-slow-kt

**KT 인터넷 요금 → 0원.** SLA 미달 속도를 자동으로 측정하고 요금 감면을 신청해주는 도구.

---

## 이게 뭔데

KT는 SLA 기준(계약 속도의 50%)을 미달하면 **측정한 날의 요금을 감면**해줘야 한다. 한 번 측정해서 한 달 치가 깎이는 게 아니다. **매일 측정해야 매일 감면된다.** 30일 매일 미달이면 전액 감면.

근데 그걸 누가 매일 직접 KT 홈페이지 들어가서 로그인하고, 25분 기다리고, 이의신청 버튼 누르냐? 아무도 안 한다. **이 도구는 그걸 대신 한다.**

```
📊 측정 결과
   계약 속도:  1,000 Mbps  (기가라이트)
   측정 속도:     64 Mbps  ← 계약의 6.4%
   → SLA 실패 → 이의신청 완료 → 당월 요금 감면
```

---

## 시작하기

### 1. Node.js 설치 (최초 1회)

이 README의 `npx ...` 명령어는 Node.js에 포함된 도구로 실행합니다. 먼저 터미널에서 설치 여부를 확인하세요.

```bash
node -v
npm -v
npx -v
```

`node -v`가 `v20...` 이상이면 다음 단계로 넘어가면 됩니다. 명령어가 없거나 버전이 낮으면 Node.js 20 이상을 설치하세요. 새로 설치한다면 최신 LTS를 권장합니다.

- **가장 쉬운 방법**: [Node.js 공식 다운로드](https://nodejs.org/en/download)에서 LTS 설치 파일을 받아 설치
  - macOS: `macOS Installer (.pkg)` 다운로드 후 실행
  - Windows: `Windows Installer (.msi)` 다운로드 후 실행
- **macOS (Homebrew를 이미 쓰는 경우)**:
  ```bash
  brew install node
  ```
- **Windows (winget을 이미 쓰는 경우, PowerShell)**:
  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

설치 후 새 터미널을 열고 다시 확인:

```bash
node -v
npx -v
```

### 2. KT 속도측정 프로그램 설치 (최초 1회)

SLA 측정을 위해 KT 공식 속도측정 프로그램이 필요합니다.

- **macOS**: [ktspeed.pkg 다운로드](https://speed.kt.com/file/ktspeed.pkg) 설치
- **Windows**: [speed.kt.com](https://speed.kt.com) → 속도측정 → 품질보증(SLA) 테스트 진입 후 안내에 따라 설치
- **Linux**: KT 속도측정 프로그램이 지원하지 않아 사용 불가

> ⚠️ **Windows는 아직 테스트되지 않았습니다.** macOS에서만 동작이 검증되었습니다.

<details>
<summary>macOS에서 설치 시 보안 경고가 뜨는 경우</summary>

ktspeed.pkg는 KT 공식 파일이지만, Apple 공증(Notarization)이 안 되어 있어 macOS에서 보안 경고가 뜰 수 있습니다.

**"Apple은 이 파일이 악성 소프트웨어인지 확인할 수 없습니다"** 라는 메시지가 나타나면:

1. **시스템 설정** → **개인정보 보호 및 보안** 으로 이동
2. 하단 **보안** 섹션에서 `"ktspeed.pkg" 차단됨` 메시지 확인
3. **"그래도 열기"** 버튼 클릭
4. 비밀번호 또는 Touch ID로 인증

> macOS Sequoia(15) 이후로는 Ctrl+클릭 우회가 제거되었습니다. 반드시 시스템 설정에서 허용해야 합니다.

</details>

### 3. 초기 설정

```bash
npx -y damn-my-slow-kt@latest init
```

KT 계정 입력하면 끝. 매일 자동으로 최대 10회 (2시간 간격) 측정하고, 미달이면 바로 감면 신청한다. 성공하면 나머지는 자동 스킵.

```
04:00  → 측정 → 속도 정상 → 종료
06:00  → 측정 → SLA 미달 → 감면 신청 성공!
08:00  → "오늘 이미 감면 성공" → 스킵
10:00  → 스킵
 ...
```

---

## 지금 바로 실행하기

스케줄을 기다리지 않고 직접 한 번 돌리고 싶을 때:

```bash
npx -y damn-my-slow-kt@latest run
```

약 25분(5회 측정) 걸리고, SLA 미달이면 자동으로 감면 신청까지 진행합니다.

- `--dry-run`: 측정만 하고 감면 신청은 생략
- `--force`: 오늘 이미 완료했어도 강제로 다시 실행
- `--debug`: 브라우저 창을 띄워 진행 과정을 직접 확인 (문제 진단용)

---

## 스케줄 해제하기

```bash
npx -y damn-my-slow-kt@latest schedule remove
```

---

## 설정 바꾸기

`~/.damn-my-slow-isp/config-kt.yaml` 파일을 직접 편집:

```yaml
schedule:
  max_attempts: 10       # 하루 최대 측정 횟수
  retry_interval_minutes: 120  # 측정 간격 (분)

notification:
  discord_webhook: ""    # Discord 알림 (선택)
  slack_webhook: ""      # Slack 알림 (선택, Incoming Webhook URL)
  telegram_bot_token: "" # Telegram 알림 (선택)
```

설정 변경 후 스케줄 재등록:
```bash
npx -y damn-my-slow-kt@latest schedule install
```

---

## 에러가 나면? (디버그 모드)

터미널에서 `run` 도중 에러가 발생하면 **"브라우저 창을 열어서 어디서 막혔는지 직접 확인해보시겠습니까?"** 라고 물어봅니다. 여기서 `Y`를 누르면 같은 흐름을 디버그 모드로 다시 실행합니다.

처음부터 디버그 모드로 돌리고 싶다면:

```bash
npx -y damn-my-slow-kt@latest run --debug
```

- `config-kt.yaml`의 `headless` 설정을 무시하고 이번 실행만 임시로 브라우저를 띄웁니다
- `slowMo: 250ms` + DevTools 자동 열림
- 에러 발생 시 브라우저를 바로 닫지 않고, Enter를 누를 때까지 대기합니다
- 측정 결과와 감면 신청은 일반 실행과 동일하게 저장/처리됩니다

자주 발생하는 원인 ([#3](https://github.com/kargnas/damn-my-slow-kt/issues/3)):
- KT 회선을 보유하지 않은 계정으로 로그인
- 속도측정 프로그램 미설치
- 새 기기 등록 화면이 뜸
- 다회선 계정에서 주소지 선택 화면이 추가로 뜸

---

## 업데이트

```bash
npx -y damn-my-slow-kt@latest init
```

새 버전에서 설정이 바뀌면 자동으로 안내해주고, 적용할지 물어본다.

---

## KT SLA 감면 기준

| | 한 번만 측정 | 매일 측정 |
|---|---|---|
| 감면 범위 | **하루분만** | **매일 하루분씩 → 최대 전액** |

- **판정**: 30분간 5회 측정, 60% 이상(3회 이상) 미달 → 감면 대상
- **보상**: 해당일 이용요금 감면
- **해약권**: 월 5일 이상 감면 시 **할인반환금 없이 해약** 가능
- **대상**: 유선(LAN) 연결만 (Wi-Fi 제외)
- **측정**: [speed.kt.com](https://speed.kt.com) KT 공식 SLA 서버 + KT 속도측정 프로그램 필수
- **공식 안내**: [KT 초고속 인터넷 품질보장제도(SLA)](https://ermsweb.kt.com/search/faq/faqAnswerM.do?kbId=KNOW0002301063&nodeId=NODE0000000255&parentNodeId=NODE0000000238)

### 상품별 최저보장속도 (약관 별표2)

| 상품명 | 계약 속도 | 최저보장속도 |
|--------|-----------|-------------|
| 인터넷 슈퍼프리미엄 | 10Gbps | 5Gbps |
| 인터넷 프리미엄플러스 | 5Gbps | 2.5Gbps |
| 인터넷 프리미엄 | 2.5Gbps | 1.25Gbps |
| 인터넷 에센스 (기가라이트 등) | 1Gbps | 500Mbps |
| 인터넷 베이직 | 500Mbps | 250Mbps |
| 인터넷 슬림플러스 | 200Mbps | 100Mbps |
| 스페셜 | 100Mbps | 50Mbps |

<details>
<summary>약관 원문 발췌 (2025년 3월 기준)</summary>

> **출처**: [KT 인터넷서비스 이용약관 (2025.03)](https://corp.kt.com/attach/board/BS00000005/70/(%EC%9D%B4%EC%9A%A9%EC%95%BD%EA%B4%80+%EC%A0%84%EB%AC%B8)+%EC%9D%B8%ED%84%B0%EB%84%B7%EC%84%9C%EB%B9%84%EC%8A%A4+%EC%9D%B4%EC%9A%A9%EC%95%BD%EA%B4%80_202503(1).pdf)

#### 별표2 — 초고속인터넷서비스 최저속도 보장제도

**라. 보상기준**
1. 측정서버: KT 속도측정서버(http://speed.kt.com)
2. 보상기준: 30분 동안 5회 이상 전송속도를 측정하여 측정횟수의 60% 이상이 최저속도에 미달할 경우 보상. 측정은 KT가 공급한 속도측정 프로그램을 사용하여야 함.
3. 보상금액: 해당일 이용요금을 감면
4. **월 5일 이상 감면을 받는 경우 할인반환금 없이 해약이 가능함**

#### 제13조 ⑦항 — 할인반환금 없이 해지 가능한 경우 (발췌)

> 5\. 케이티에 책임있는 사유로 "별표2" 제1항의 최저속도 보장제도에 미달하여 이용고객이 해지를 원하는 경우

#### 제19조 ⑤항 — 요금 감면

> 케이티는 KT internet 속도측정 결과 최저속도 미달 시(체크라인, 포스넷 제외) 이용요금을 감면합니다. 최저속도, 대상서비스, 보상기준 등은 "별표2"와 같습니다.

</details>

---

## ~~NAS / Docker에서 실행~~

> ⚠️ **현재 사용 불가** — KT 속도측정 프로그램이 macOS/Windows만 지원하므로, Linux 기반 Docker/NAS 환경에서는 SLA 측정이 불가능합니다.

<details>
<summary>참고: 이전 Docker 실행 방법 (KT가 Linux를 지원할 경우)</summary>

Synology NAS 등 시스템 라이브러리가 부족한 환경에서는 Playwright 공식 Docker 이미지를 사용:

```bash
# 1. 먼저 호스트에서 설정 파일 생성
npx -y damn-my-slow-kt@latest init

# 2. Docker로 실행
docker run --rm \
  -v ~/.damn-my-slow-isp:/root/.damn-my-slow-isp \
  mcr.microsoft.com/playwright:v1.52.0-noble \
  npx -y damn-my-slow-kt@latest run
```

cron으로 자동 실행하려면 `/etc/crontab`에 직접 등록:

```bash
# 매일 04:00, 06:00, ..., 22:00 (2시간 간격 10회)
0  4  * * * root  docker run --rm -v /var/services/homes/admin/.damn-my-slow-isp:/root/.damn-my-slow-isp mcr.microsoft.com/playwright:v1.52.0-noble npx -y damn-my-slow-kt@latest run >> /var/services/homes/admin/.damn-my-slow-isp/cron.log 2>&1
0  6  * * * root  docker run --rm -v /var/services/homes/admin/.damn-my-slow-isp:/root/.damn-my-slow-isp mcr.microsoft.com/playwright:v1.52.0-noble npx -y damn-my-slow-kt@latest run >> /var/services/homes/admin/.damn-my-slow-isp/cron.log 2>&1
```

</details>

---

## 테스트 완료 환경

| 환경 | OS | 상태 |
|------|-----|------|
| macOS (Apple Silicon) | macOS 15+ | ✅ 네이티브 실행 |
| Windows | Windows 10/11 | ⚠️ 미테스트 |
| GitHub Actions | Ubuntu (Node 20/22/24) | ✅ 웹페이지 로드 CI (속도테스트 프로그램 설치 불가로 속도 측정은 불가능) |

---

## 요구사항

- **macOS 또는 Windows** (KT 속도측정 프로그램 필수 — Linux 미지원)
- Node.js 20+ (`npx` 포함, 22+ 권장 — native SQLite 지원)
- KT 인터넷 계정
- 유선(LAN) 연결

---

## 개발 (Contributing)

### 기술 스택
| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ES2020, CommonJS, strict) |
| CLI | Commander + Inquirer + Chalk v4 |
| Browser | Playwright (headless Chromium) |
| Storage | node:sqlite (Node 22+) / JSON fallback |
| Config | YAML — `~/.damn-my-slow-isp/config-kt.yaml` |
| Lint | ESLint + typescript-eslint |
| Test | Vitest |
| CI | GitHub Actions (Node 20 + 22 matrix) |

### 개발 환경 설정

```bash
git clone https://github.com/kargnas/damn-my-slow-kt.git
cd damn-my-slow-kt
npm install
npx playwright install chromium
npm run build
```

### 명령어

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript 컴파일 |
| `npm run typecheck` | 타입 체크 (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm test` | Vitest 단위 테스트 |
| `npm run dev` | ts-node 개발 모드 |

### 기여 방법
1. 새 브랜치에서 작업: `git checkout -b feat/my-feature`
2. 커밋 전 반드시 확인: `npm run typecheck && npm run lint && npm run build && npm test`
3. PR 생성 (main 브랜치 대상)
4. 커밋 메시지: 한국어 conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

> AI 에이전트로 개발 환경을 구성하려면 [README.ai-ready.md](./README.ai-ready.md) 참고
