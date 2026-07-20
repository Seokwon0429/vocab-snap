# WordLens — 사진으로 만드는 영어 단어장

책이나 프린트의 영어 문장을 사진으로 인식하고, 필요한 단어만 골라 개인 단어장과 카드 퀴즈로 학습하는 정적 웹 앱입니다. 서버, 유료 API, API 키가 필요하지 않습니다.

## 주요 기능

- 사진 선택, 드래그 앤 드롭, 모바일 후면 카메라 촬영
- Tesseract.js 영어 OCR 진행률 및 취소, 이미지 리사이즈·회색조·자동 대비 전처리
- 영어 단어 정규화·잡음 제거·중복 분류 (`don't`, `well-known` 지원)
- 저장 전 선택·해제·수정·삭제 검토 화면
- IndexedDB 단어장 CRUD, 검색·정렬·일괄 삭제
- JSON/CSV 전체 백업 및 다시 가져오기
- 기기에 설치된 영어 음성을 이용한 발음 듣기
- 뜻 맞히기 카드 퀴즈, 알아요/아직 몰라요 분류 및 누적 통계
- 모바일·태블릿·PC 반응형 UI와 키보드 조작

## 개인정보 보호 방식

- 사진 전처리와 OCR은 브라우저의 Canvas, Web Worker, WebAssembly 안에서 실행됩니다.
- OCR Worker, 엔진, 영어 모델은 빌드할 때 정적 파일에 포함되며 실행 중에는 배포 사이트와 같은 출처에서만 읽습니다.
- 단어와 학습 통계는 현재 브라우저의 IndexedDB에만 저장됩니다.
- 발음은 `localService`인 기기 내장 영어 음성만 사용합니다. 원격 음성은 선택하지 않습니다.
- Content Security Policy의 `connect-src 'self'`로 실행 중 외부 전송을 차단합니다.

브라우저 데이터를 삭제하면 단어장도 지워집니다. 중요한 단어는 내보내기 기능으로 JSON 또는 CSV 백업을 권장합니다.

## 로컬 실행

### 요구 사항

- Node.js `20.19+` 또는 `22.12+`
- pnpm 11 (Corepack 사용 권장)

### 단계

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm dev
```

터미널에 표시된 로컬 주소(기본값 `http://localhost:5173`)를 브라우저에서 엽니다.

첫 실행 또는 첫 빌드 때 공개 영어 OCR 모델을 한 번 내려받아 `public/ocr`에 준비합니다. 이 과정에는 사용자 사진이나 단어 데이터가 포함되지 않습니다. 생성된 OCR 자산은 Git에서 제외되며 빌드할 때 자동으로 다시 준비됩니다.

## 테스트와 빌드

```bash
pnpm lint
pnpm test
pnpm build
pnpm preview
```

- `pnpm lint`: React·TypeScript 정적 코드 검사
- `pnpm test`: 단어 추출, IndexedDB CRUD·퀴즈 통계, JSON/CSV 왕복, 주요 UI 흐름 테스트
- `pnpm build`: TypeScript 검사 후 `dist` 프로덕션 파일 생성
- `pnpm preview`: 프로덕션 빌드를 로컬에서 확인

## GitHub Pages 배포

1. 이 프로젝트를 GitHub 저장소의 `main` 또는 `master` 브랜치에 푸시합니다.
2. GitHub 저장소에서 **Settings → Pages**로 이동합니다.
3. **Build and deployment → Source**를 **GitHub Actions**로 선택합니다.
4. **Actions** 탭에서 `GitHub Pages 배포` 워크플로가 완료될 때까지 기다립니다.
5. 완료된 작업의 `deploy` 단계 또는 **Settings → Pages**에 표시된 주소로 접속합니다.

`.github/workflows/deploy.yml`이 설치, 자동 테스트, 빌드, Pages 업로드를 수행합니다. 별도 Secret이나 환경변수는 필요하지 않습니다.

### 경로와 새로고침 대응

- Vite의 `base`를 상대 경로(`./`)로 설정해 사용자 Pages와 프로젝트 Pages 모두에서 정적 파일 경로가 동작합니다.
- 메뉴는 URL 경로를 만들지 않는 단일 문서 탭 방식이므로 어떤 메뉴에서 새로고침해도 GitHub Pages의 라우팅 404가 발생하지 않습니다.
- OCR 정적 자산도 `document.baseURI` 기준으로 찾아 저장소 하위 경로 배포에 대응합니다.

## 데이터 가져오기 규칙

- JSON은 WordLens에서 내보낸 버전형 백업과 단순 단어 배열을 지원합니다.
- CSV는 WordLens 헤더와 일반적인 영문·한글 헤더를 인식하며 UTF-8 BOM, 쉼표, 따옴표, 여러 줄 메모를 처리합니다.
- **기존 단어와 합치기**는 중복 단어를 건너뜁니다.
- **전체 바꾸기**는 확인 후 현재 단어장을 원자적으로 교체합니다.

## 브라우저 참고 사항

- 최신 Chrome, Edge, Firefox, Safari를 권장합니다.
- 카메라 버튼의 실제 동작은 모바일 브라우저와 기기 설정에 따라 달라질 수 있습니다.
- 기기에 설치된 로컬 영어 음성이 없으면 개인정보 보호를 위해 발음 기능만 비활성화됩니다.
- HEIC 등 브라우저가 직접 디코딩하지 못하는 형식은 JPG, PNG 또는 WebP로 변환해 사용해 주세요.

## 기술 구성

- Vite 8, React 19, TypeScript
- Tesseract.js 7 (브라우저 OCR)
- IndexedDB, Canvas, Web Worker, WebAssembly, SpeechSynthesis
- Vitest, Testing Library, fake-indexeddb
