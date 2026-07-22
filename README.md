# WordLens — 사진으로 만드는 영어 단어장

[🌐 WordLens 바로 사용하기](https://seokwon0429.github.io/vocab-snap/)

책이나 프린트의 영어 문장을 사진으로 인식하고, 필요한 단어만 골라 개인 단어장과 카드 퀴즈로 학습하는 웹 앱입니다. 비로그인 상태에서는 브라우저에 저장하고, 로그인하면 사용자가 직접 운영하는 WordLens 서버에 사용자별로 저장합니다. 유료 OCR API나 API 키는 필요하지 않습니다.

## 주요 기능

- 사진 선택, 드래그 앤 드롭, 모바일 후면 카메라 촬영
- Tesseract.js 한국어·영어 혼합 OCR 진행률 및 취소, 이미지 리사이즈·회색조·자동 대비 전처리
- 같은 행의 영어 단어와 한국어 뜻·품사를 연결해 검토 화면에 표시하고, 내장 사전과 일치 여부 확인
- 정밀 인식 모드에서 페이지 방식·대비가 다른 두 결과를 비교하고 고유 단어 후보를 합쳐 누락 완화
- 영어 단어 정규화·잡음 제거·중복 분류 (`don't`, `well-known` 지원)
- 단어별 OCR 신뢰도 표시와 로컬 영어 사전 기반 교정 후보(자동 변경 없이 사용자 확인)
- 저장 전 선택·해제·수정·삭제 검토 화면
- 저장할 때 오프라인 한영 사전으로 한국어 뜻·품사 자동 제안
- IndexedDB 게스트 단어장과 로그인 계정별 SQLite 서버 단어장
- 회원가입·로그인·로그아웃과 사용자별 단어·폴더 격리
- 단어를 폴더로 드래그하거나 선택한 여러 단어를 한 번에 이동
- JSON/CSV 전체 백업 및 다시 가져오기
- 기기에 설치된 영어 음성을 이용한 발음 듣기
- 뜻 맞히기 카드 퀴즈, 알아요/아직 몰라요 분류 및 누적 통계
- 모바일·태블릿·PC 반응형 UI와 키보드 조작

## 개인정보 보호 방식

- 사진 전처리와 OCR은 브라우저의 Canvas, Web Worker, WebAssembly 안에서 실행됩니다.
- OCR Worker, 엔진, 한국어·영어 모델과 교정·한글 뜻 사전은 빌드할 때 정적 파일에 포함되며 실행 중에는 배포 사이트와 같은 출처에서만 읽습니다.
- 교정은 브라우저에서 `nspell`과 정적 `dictionary-en` 사전으로 실행되며, 인식된 문장을 외부 API로 보내지 않습니다.
- 자동 뜻·품사 채움도 첫 글자에 해당하는 정적 사전 조각만 브라우저에서 읽으며 단어를 외부 서비스에 전송하지 않습니다. 자동 제안은 문맥에 따라 직접 수정할 수 있습니다.
- 비로그인 단어와 학습 통계는 현재 브라우저의 IndexedDB에 저장됩니다.
- 로그인한 단어와 학습 통계만 사용자가 설정한 WordLens 서버로 전송되어 사용자별 SQLite 공간에 저장됩니다.
- 비밀번호는 scrypt 해시로 저장하고 로그인 세션 토큰은 SHA-256 해시만 서버에 저장합니다.
- 브라우저의 로그인 토큰은 현재 탭의 `sessionStorage`에만 두므로 새로고침에는 유지되지만 브라우저 창을 닫으면 다시 로그인해야 합니다.
- 발음은 `localService`인 기기 내장 영어 음성만 사용합니다. 원격 음성은 선택하지 않습니다.
- Content Security Policy는 같은 출처, 로컬 개발 서버, Tailscale `*.ts.net` HTTPS 서버 연결만 허용합니다.

게스트 단어장은 브라우저 데이터를 삭제하면 함께 지워집니다. 로그인 단어장은 서버의 SQLite 파일에 남습니다. 두 모드 모두 중요한 단어는 JSON 또는 CSV 백업을 권장합니다.

게스트 모드에는 앱 내부 단어 개수 상한이 없고 브라우저의 IndexedDB 용량을 사용합니다. 서버 모드는 기본적으로 계정 50개, 사용자당 단어 20,000개, 폴더 500개, 전체 SQLite 1GiB로 제한하며 `.env.server`에서 변경할 수 있습니다.

## 로컬 실행

### 요구 사항

- Node.js `22.13+` 또는 최신 LTS
- pnpm 11 (Corepack 사용 권장)

### 단계

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm server
```

다른 터미널에서 프론트엔드를 실행합니다.

```bash
pnpm dev
```

터미널에 표시된 로컬 주소(기본값 `http://localhost:5173`)를 브라우저에서 엽니다.

첫 실행 또는 첫 빌드 때 공개 한국어·영어 OCR 모델을 한 번 내려받아 `public/ocr`에 준비하고, 설치된 영어 교정 사전도 같은 폴더에 복사합니다. 한글 뜻 사전은 저장소에 포함된 정적 조각을 사용하며, 없을 때만 공개 Wiktionary 추출 데이터로 다시 생성합니다. 이 과정에는 사용자 사진이나 단어 데이터가 포함되지 않습니다. 생성된 OCR 자산은 Git에서 제외되며 빌드할 때 자동으로 다시 준비됩니다.

## 미니 서버 설정

서버는 기본적으로 `127.0.0.1:8787`에서만 수신하고 데이터는 `server/data/wordlens.sqlite`에 저장합니다.

```powershell
Copy-Item .env.server.example .env.server
pnpm server
```

- 기본값은 `invite` 모드입니다. 초대 코드를 비워 두면 서버를 시작할 때 임시 코드를 생성해 터미널에 표시합니다.
- 같은 초대 코드를 계속 쓰려면 `.env.server`의 `WORDLENS_INVITE_CODE`에 추측하기 어려운 긴 값을 넣습니다.
- 누구나 가입하게 하려면 `WORDLENS_REGISTRATION_MODE=open`, 신규 가입을 멈추려면 `closed`로 설정합니다. 공개 모드는 봇 가입 위험이 있으므로 상한과 서버 용량을 함께 관리해야 합니다.
- 서버 PC에서는 절전 모드를 끄고 가능하면 유선 네트워크를 사용합니다.
- Windows에서 직접 실행할 때는 `powershell -ExecutionPolicy Bypass -File scripts/start-wordlens-server.ps1`을 사용할 수 있습니다.
- 백업할 때는 서버를 종료한 뒤 `server/data/wordlens.sqlite`를 다른 저장장치에 복사합니다.

### Windows 서버 관리자

바탕화면의 **WordLens 서버 관리자** 바로가기 또는 프로젝트 루트의 `WordLens-Server-Manager.vbs`를 더블클릭하면 콘솔 창 없이 서버 관리자 창이 열립니다. 표시되는 Windows 관리자 권한 요청을 승인하면 다음 작업을 버튼으로 처리할 수 있습니다.

- 서버 상태와 로컬 API 응답 확인
- 서버 켜기, 끄기, 재시작
- WordLens 사이트와 서버 데이터 폴더 열기

관리자 창을 닫아도 서버는 계속 실행됩니다. 서버를 실제로 끄려면 창 안의 **서버 끄기** 버튼을 사용합니다. 이 프로그램은 정확히 `WordLens Server` 예약 작업만 제어하며 다른 Node.js 프로세스나 Tailscale 설정은 변경하지 않습니다.

### 관리자 계정과 통계

회원가입으로 만들어진 계정은 항상 일반 사용자입니다. 관리자 권한은 서버 PC에서 사용자 ID를 지정해 직접 부여합니다.

```powershell
pnpm server:set-role -- <userId> admin
```

권한을 회수할 때는 마지막 값을 `user`로 바꿉니다. 사용자 ID와 계정별 단어 수는 `pnpm server:data-view`로 만든 `server/data/wordlens-data-view.json`에서 확인할 수 있습니다. 이 조회 파일과 실제 SQLite DB는 Git에 포함되지 않습니다.

관리자 화면에는 전체 회원·폴더·단어 수와 계정별 개수만 표시됩니다. 비밀번호, 로그인 세션, 초대 코드, 다른 사용자의 단어 내용은 표시하지 않습니다. 관리자도 일반 단어장 API에서는 본인 계정의 폴더와 단어에만 접근할 수 있습니다.

외부 공개는 공유기 포트포워딩 대신 Tailscale Funnel을 권장합니다.

```powershell
tailscale funnel --bg http://127.0.0.1:8787
tailscale funnel status
```

표시된 `https://...ts.net` 주소 뒤에 `/api`를 붙인 값을 GitHub 저장소의 **Settings → Secrets and variables → Actions → Variables**에서 `VITE_API_URL`로 등록합니다. 예: `https://wordlens.example.ts.net/api`. 이후 `main` 브랜치를 다시 배포하면 GitHub Pages의 로그인 화면이 해당 서버에 연결됩니다.

## 테스트와 빌드

```bash
pnpm lint
pnpm test
pnpm build
pnpm preview
```

- `pnpm lint`: React·TypeScript 정적 코드 검사
- `pnpm test`: 브라우저 기능 테스트와 서버 인증·사용자 격리 API 테스트
- `pnpm build`: TypeScript 검사 후 `dist` 프로덕션 파일 생성
- `pnpm preview`: 프로덕션 빌드를 로컬에서 확인

## GitHub Pages 배포

1. 이 프로젝트를 GitHub 저장소의 `main` 또는 `master` 브랜치에 푸시합니다.
2. GitHub 저장소에서 **Settings → Pages**로 이동합니다.
3. **Build and deployment → Source**를 **GitHub Actions**로 선택합니다.
4. **Actions** 탭에서 `GitHub Pages 배포` 워크플로가 완료될 때까지 기다립니다.
5. 완료된 작업의 `deploy` 단계 또는 **Settings → Pages**에 표시된 주소로 접속합니다.

`.github/workflows/deploy.yml`이 설치, 자동 테스트, 빌드, Pages 업로드를 수행합니다. 로그인 기능을 배포하려면 Actions 변수 `VITE_API_URL`에 Tailscale Funnel API 주소를 등록해야 합니다. 이 주소는 공개 접속 주소이므로 Secret이 아니며, 인증은 각 사용자의 로그인 토큰으로 처리합니다.

GitHub의 프로젝트 Pages는 같은 사용자 아래의 다른 저장소 Pages와 Origin을 공유합니다. 로그인 토큰은 탭 단위로만 보관하지만, 같은 탭에서 신뢰할 수 없는 다른 Pages 앱을 열지 말고 다른 프로젝트에도 신뢰할 수 있는 스크립트만 배포하세요.

### 경로와 새로고침 대응

- Vite의 `base`를 상대 경로(`./`)로 설정해 사용자 Pages와 프로젝트 Pages 모두에서 정적 파일 경로가 동작합니다.
- 메뉴는 URL 경로를 만들지 않는 단일 문서 탭 방식이므로 어떤 메뉴에서 새로고침해도 GitHub Pages의 라우팅 404가 발생하지 않습니다.
- OCR 정적 자산도 `document.baseURI` 기준으로 찾아 저장소 하위 경로 배포에 대응합니다.

## 인식과 교정 방식

- 기본값인 **정밀 인식**은 같은 사진을 일반 페이지 방식과 흩어진 글자 탐색 방식으로 각각 전처리한 뒤, 한 개의 Tesseract Worker에서 순서대로 인식합니다.
- 페이지 신뢰도, 단어별 신뢰도, 인식 문자량을 함께 비교해 원문으로 보여 줄 결과 하나를 선택합니다. 문장은 섞지 않되, 다른 결과에서만 발견된 단어 상자는 검토 후보로 합칩니다.
- 긴 페이지는 최대 6MP 메모리 제한을 유지하면서 긴 변을 최대 4096px까지 보존해 작은 본문 글자의 손실을 줄입니다.
- 한글 조사와 붙어 인식된 `apple을`, `well-known이라는` 같은 형태에서도 영어 부분을 분리합니다.
- 숫자가 섞인 `w0rd`나 명백하지 않은 영문 조각도 버리지 않고 **추가 확인이 필요한 후보**에 미선택 상태로 표시합니다. 올바른 영어 단어로 수정해야 저장할 수 있습니다.
- 같은 단어가 페이지에 반복되면 고유 단어 한 항목으로 합치고 `여러 번 발견`으로 표시합니다.
- 신뢰도가 낮거나 사전에 없는 단어는 처음에 선택하지 않고 최대 3개의 후보를 표시합니다. 후보 적용, 원문 유지, 직접 수정 중 하나를 사용자가 선택해야 저장됩니다.
- 실제 영어 단어로 사전에 등록된 값은 문맥 없이 강제 교정하지 않습니다.

## 데이터 가져오기 규칙

- JSON은 WordLens에서 내보낸 버전형 백업과 단순 단어 배열을 지원합니다.
- JSON/CSV 백업에는 사용자 폴더와 단어의 폴더 배치도 함께 저장됩니다. 예전 백업은 모두 미분류 단어로 호환해 가져옵니다.
- 저장 단어 수가 많은 백업도 다시 가져올 수 있도록 파일 크기는 최대 100MB까지 지원합니다.
- CSV는 WordLens 헤더와 일반적인 영문·한글 헤더를 인식하며 UTF-8 BOM, 쉼표, 따옴표, 여러 줄 메모를 처리합니다.
- **기존 단어와 합치기**는 중복 단어를 건너뜁니다.
- **전체 바꾸기**는 확인 후 현재 단어장을 원자적으로 교체합니다.

## 브라우저 참고 사항

- 최신 Chrome, Edge, Firefox, Safari를 권장합니다.
- 카메라 버튼의 실제 동작은 모바일 브라우저와 기기 설정에 따라 달라질 수 있습니다.
- 기기에 설치된 로컬 영어 음성이 없으면 개인정보 보호를 위해 발음 기능만 비활성화됩니다.
- HEIC 등 브라우저가 직접 디코딩하지 못하는 형식은 JPG, PNG 또는 WebP로 변환해 사용해 주세요.
- 정밀 인식은 두 번 비교하므로 모바일 기기에서는 일반 인식보다 시간이 더 걸릴 수 있습니다. 사진 선택 후 정밀 인식 체크를 끌 수 있습니다.

## 기술 구성

- Vite 8, React 19, TypeScript
- Tesseract.js 7 (브라우저 한국어·영어 OCR)
- nspell 2.1.5, dictionary-en 4.0.0 (브라우저 로컬 교정)
- 한국어 위키낱말사전, Kaikki.org/Wiktextract (정적 한글 뜻·품사 제안)
- IndexedDB, Canvas, Web Worker, WebAssembly, SpeechSynthesis
- Vitest, Testing Library, fake-indexeddb

`dictionary-en`과 `nspell`의 라이선스 원문은 빌드 결과의 `ocr/dictionary/` 폴더에 함께 포함됩니다.

한글 뜻·품사 데이터는 한국어 위키낱말사전을 Kaikki.org/Wiktextract로 추출한 자료에서 정확히 일치하는 영어 표제어와 한국어 뜻을 선별·정규화한 2차 데이터입니다. 이 파생 데이터는 `CC BY-SA 4.0`을 선택해 배포하며, 자세한 출처·변경 사항·정적 스냅샷 시각·라이선스 링크는 빌드 결과의 `dictionary/ko-en/NOTICE.txt`에 포함됩니다.
