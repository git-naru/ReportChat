# TRD — ReportChat 기술 요구사항

| 항목 | 내용 |
|---|---|
| 문서 버전 | 1.0 (2026-10-20) |
| 대상 커밋 | `13b3a9f` 이후 |
| 관련 문서 | [PRD](PRD.md) · [DRD](DRD.md) · [인수인계](HANDOVER.md) |

## 1. 시스템 구성

```
브라우저 (public/)                     Node.js 서버 (server/)
┌─────────────────────┐   HTTP      ┌──────────────────────────────┐
│ index.html / app.js │ ─────────▶ │ Express                       │
│  - 페이지 이미지     │  업로드     │  POST /api/rooms/:id/upload   │──▶ convert.js ──▶ DATA_DIR/rooms/<id>/files/*.png
│  - SVG 필기 레이어   │  파일       │  GET  /files/:room/:file      │      ├ 이미지: 복사
│  - 텍스트 편집기     │             │                               │      ├ PDF: pdf.js + @napi-rs/canvas → PNG
│                     │  WebSocket  │ ws (/ws)                      │      └ Office: MS Office(Win) / LibreOffice → PDF
│                     │ ◀────────▶ │  join/ops/draft/cursor/view   │
└─────────────────────┘             │ rooms.js: 상태·검증·저장      │──▶ DATA_DIR/rooms/<id>/room.json
                                    └──────────────────────────────┘
```

- 서버는 단일 Node.js 프로세스. 방(보드) 상태를 메모리에 두고 1초 디바운스로 디스크에 저장한다.
- 빌드 단계 없음. 클라이언트는 순수 ES 모듈 JavaScript.
- 별도 산출물: `artifact/reportchat.html` (claude.ai 아티팩트 버전, 서버 없음 — 7장).

## 2. 기술 스택

| 구분 | 사용 | 비고 |
|---|---|---|
| 런타임 | Node.js ≥ 20 (CI·Windows 패키지는 22) | ES 모듈 (`"type": "module"`) |
| HTTP | express 5 | |
| 업로드 | multer 2 (디스크 임시 저장) | 파일명은 latin1 → UTF-8 변환 |
| 실시간 | ws 8 | 경로 `/ws`, 최대 메시지 4MB, 30초 ping |
| 이미지 크기 | image-size 2 | EXIF 회전 5~8은 가로세로 교체 |
| PDF 렌더링 | pdfjs-dist 5 (legacy build) + @napi-rs/canvas | 외부 프로그램 불필요, 플랫폼별 네이티브 바이너리 |
| Office → PDF | Windows: PowerShell COM (`server/office2pdf.ps1`) → 실패 시 LibreOffice / 그 외: LibreOffice | `soffice --headless --convert-to pdf` |
| 테스트 | `node --test` | `test/*.test.js` |

## 3. 디렉터리

```
server/index.js        HTTP 라우트, WebSocket 처리, 변환 작업, 시작 로그(LAN 주소)
server/rooms.js        Room / RoomStore, 객체·패치 검증(sanitize), 디스크 저장
server/convert.js      파일 종류 판별, 변환 파이프라인, 도구 감지
server/office2pdf.ps1  Windows MS Office 변환 (ASCII 전용 — 4.4 참고)
public/                index.html, app.js, styles.css
artifact/              claude.ai 아티팩트 단일 파일 버전
windows/               Windows 패키지용 ReportChat.cmd, 사용법.txt
scripts/               build-windows.mjs, smoke.mjs
test/                  rooms.test.js, convert.test.js
.github/workflows/     windows.yml (Windows 빌드·검사·릴리스)
```

## 4. 서버

### 4.1 HTTP API

| 메서드·경로 | 설명 | 응답 |
|---|---|---|
| `GET /` , `GET /r/:room` | 클라이언트 페이지 | index.html |
| `GET /api/config` | 허용 확장자, 업로드 한도 | `{accept, maxFileMB, pageWidth}` |
| `POST /api/rooms` | 새 방 id 발급 (방은 첫 접속 때 생성) | `{id}` |
| `POST /api/rooms/:room/upload` | multipart `files[]`, `name` | `{docs:[{id,name,kind,status}\|{name,error}]}` |
| `GET /files/:room/:file` | 페이지 이미지 (7일 캐시, immutable) | 이미지 |

- 방 id: `^[A-Za-z0-9_-]{6,40}$`, 파일명: `^[A-Za-z0-9_-]+\.[a-z]+$`. 경로 조작 차단.
- 업로드 응답은 변환 완료를 기다리지 않는다. 변환 결과는 WebSocket `doc` 메시지로 알린다.

### 4.2 WebSocket 프로토콜 (`/ws`, JSON)

클라이언트 → 서버

| `t` | 필드 | 설명 |
|---|---|---|
| `join` | `room, clientId, name, color` | 첫 메시지. 이전 메시지는 무시 |
| `ops` | `ops: Op[]` | 편집 연산 (4.3) |
| `draft` | `id, pageId, tool, color, width, points, reset` | 그리는 중인 선 조각. 저장 안 함, 점 2000개 이하 |
| `cursor` | `pageId\|null, x, y` | 커서 위치 (페이지 좌표) |
| `view` | `pageId` | 함께 보기 페이지 변경 |
| `me` | `name, color` | 이름·색 변경 |
| `delDoc` | `docId` | 문서와 그 필기 삭제 |

서버 → 클라이언트

| `t` | 필드 | 설명 |
|---|---|---|
| `init` | `you, room{docs,objects,view}, users` | 접속 직후 전체 상태 |
| `users` | `users[]` | 접속자 변경 |
| `ops` | `ops, by` | 다른 사람의 반영된 연산 (보낸 사람 제외) |
| `draft` / `cursor` | | 다른 사람에게만 중계 |
| `view` | `pageId, by` | 함께 보기 페이지 |
| `doc` | `doc` | 문서 추가·변환 완료·실패 |
| `docRemoved` | `docId, view, by` | 문서 삭제 |

### 4.3 데이터 모델

좌표계: **페이지 가로 = 1000**, 세로 = `1000 × h / w`. 화면 크기·확대와 무관하게 같은 위치.

```js
Doc    { id, name, kind: 'image'|'pdf'|'office'|'sheet', status: 'converting'|'ready'|'error',
         error?, pages: [{ id: `${docId}_${n}`, url, w, h }], by, createdAt }
Stroke { id, type: 'stroke', pageId, tool: 'pen'|'highlighter', color: '#rrggbb', width,
         points: [[x,y],...], tx, ty, author, authorName }
Text   { id, type: 'text', pageId, x, y, size, color, text, author, authorName }
Op     { k: 'add', obj } | { k: 'upd', id, patch } | { k: 'del', id }
```

- 서버 검증(`rooms.js` `sanitizeObject`/`sanitizePatch`): 허용 필드만, 색 `#rrggbb`, 좌표 ±100000, 점 1~20000개(소수 1자리로 반올림), 텍스트 10000자, 굵기 0.2~200, 글자 크기 4~400. 실패한 연산은 버린다.
- `author`·`authorName`은 서버가 접속 정보로 덮어쓴다 (클라이언트 값 무시).
- `add`는 존재하지 않는 페이지, 이미 있는 id, 방당 100,000개 초과면 거부.
- 동시성: 객체 단위 last-writer-wins. 텍스트 입력 중 원격 `upd`의 `text`는 무시해 입력 중인 내용을 지킨다.

### 4.4 변환 파이프라인 (`convert.js`)

| 종류 | 확장자 | 처리 |
|---|---|---|
| image | png jpg jpeg gif webp bmp | 그대로 복사, 크기 측정 |
| pdf | pdf | pdf.js로 쪽마다 PNG, 긴 변 2200px, 최대 200쪽 |
| office | pptx ppt odp docx doc odt rtf txt | → PDF → PNG (2200px) |
| sheet | xlsx xlsm xls ods csv | 시트당 한 페이지로 PDF → PNG (3200px) |

- Office 변환은 큐로 **한 번에 하나씩** (Office/LibreOffice 동시 실행 불안정), 제한 시간 180초.
- Windows: `checkTools()`가 PowerShell로 `Word/PowerPoint/Excel.Application` ProgID를 확인. 있으면 `office2pdf.ps1` (PowerPoint `SaveAs 32`, Word `ExportAsFixedFormat 17`, Excel `FitToPages 1×1` 후 `ExportAsFixedFormat 0`). 실패하면 LibreOffice로 재시도.
- LibreOffice 위치: `SOFFICE_PATH` 환경 변수 → Windows `Program Files\LibreOffice\program\soffice.com`(완료까지 기다리는 콘솔용) → macOS `/Applications/LibreOffice.app/...` → `PATH`의 `soffice`. 사용자 프로필은 `file://` URL로 지정.
- **주의**: `office2pdf.ps1`은 ASCII만 쓴다. Windows PowerShell 5.1은 BOM 없는 스크립트를 ANSI로 읽어 한글이 깨지고 따옴표가 어긋날 수 있다.
- **주의**: pdf.js의 `standardFontDataUrl`·`cMapUrl`은 `/`로 끝나야 한다. Windows에서도 경로를 `/`로 바꿔 넘긴다 (커밋 `13b3a9f`).

### 4.5 저장과 수명

- `DATA_DIR/rooms/<id>/room.json` (임시 파일에 쓰고 rename), 페이지 이미지는 `files/`.
- 접속자도 변환 작업도 없는 방은 10분 뒤 저장 후 메모리에서 내린다. 변환 중인 방은 내리지 않는다.
- 서버 재시작 시 `converting` 상태였던 문서는 `error`로 바꾼다.
- `SIGINT`/`SIGTERM` 시 대기 중인 저장을 마치고 종료.

### 4.6 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 포트 |
| `DATA_DIR` | `./data` | 저장 위치 |
| `MAX_FILE_MB` | 100 | 파일당 업로드 한도 |
| `OPEN_BROWSER` | (없음) | `1`이면 시작 후 브라우저 열기 (Windows 런처가 사용) |
| `SOFFICE_PATH` | (자동) | LibreOffice 실행 파일 경로 지정 |

## 5. 클라이언트 (`public/app.js`)

- 렌더링: `<img>`(페이지) 위에 `<svg viewBox="0 0 1000 H">`. 선은 2차 베지어로 부드럽게 한 `path`, 형광펜은 불투명도 0.38. 텍스트는 `text`+`tspan`, 흰 외곽선(`paint-order: stroke`)으로 어떤 배경에서도 읽히게.
- 입력: Pointer Events (마우스·터치·펜), `getCoalescedEvents`로 촘촘하게. 화면상 0.8px 미만 이동은 버림.
- 전송 주기: draft 40ms, 커서 50ms, 이동 60ms, 텍스트 120ms (throttle).
- 되돌리기: 클라이언트 스택(최대 300개), 항목은 `{undo: Op[], redo: Op[]}`. 내 작업만 되돌린다. 새로고침하면 사라진다.
- 재연결: 지수 백오프(최대 10초). 끊긴 동안의 `ops`는 큐에 모았다가 `init` 뒤 전송·재적용.
- 맞히기(hit test): 선은 선분까지 거리, 텍스트는 `getBBox`. 지우개 반경 화면 9px.
- PNG 내보내기: 원본 크기 캔버스에 페이지 이미지 + SVG 직렬화 이미지를 겹쳐 그림.
- 저장: `localStorage`에 clientId, 이름, 색, 함께 보기 설정.

## 6. Windows 패키지

- `scripts/build-windows.mjs`: `dist/ReportChat/`에 server·public·package 파일 복사 → `node.exe` 복사 → `npm ci --omit=dev --os=win32 --cpu=x64` → `@napi-rs/canvas-win32-x64-msvc` 확인 → zip.
- `.cmd`·`.ps1`·안내문은 CRLF로 변환, 안내문은 UTF-8 BOM.
- `windows/ReportChat.cmd`: `chcp 65001`, `OPEN_BROWSER=1`, `node\node.exe server\index.js`.
- CI `.github/workflows/windows.yml` (`windows-latest`): `npm ci` → `npm test` → 패키지 빌드 → `scripts/smoke.mjs`로 **패키지 안의 node.exe**를 띄워 이미지·PDF 업로드와 변환 확인 → artifact 업로드 → `windows-latest` 프리릴리스 교체 게시.
- 결과물: `https://github.com/git-naru/ReportChat/releases/download/windows-latest/ReportChat-windows.zip` (약 56MB).

## 7. claude.ai 아티팩트 버전 (`artifact/reportchat.html`)

서버 없이 claude.ai의 런타임 기능으로 같은 경험을 제공한다. 게시 URL: `https://claude.ai/artifact/6NWViyRaLkEirqTPDw6ZSW`.

| 서버 버전 | 아티팩트 버전 |
|---|---|
| WebSocket `ops` | `db` 문서 쓰기 (`pages/{pageId}/objs/{objId}`), `onSnapshot` 구독 |
| `draft` / `cursor` | `room.emit('draft')` (점 150개씩 조각), `room.presence({cur, col})` |
| `view` | `db.doc('live/state')` `{view, at}` |
| 문서 목록 | `files/{docId}` `{name, kind, status, pages:[{id, asset, w, h}], by, createdAt}` |
| 페이지 이미지 | `assets.upload` → `/_blob/<assetId>` |
| 이름·색 | `user.me()` / `user.profiles()` (저장은 id만) |
| PNG 저장 | `downloads.save` |
| Office 변환 | 불가 — PDF로 저장 후 올리도록 안내 |
| PDF 변환 | 브라우저에서 pdf.js 3.11.174(cdnjs) → webp/png |

- 게시 시 capability: `db {}`, `user {scopes:["profile"]}`, `room {topics:{draft:"interact"}}`, `assets {}`, `downloads true`.
- 문서별 쓰기 큐: 한 문서에 한 번에 하나의 쓰기, 밀린 `update`는 합친다.
- 권한: 쓰기 실패(`invalid_argument`)나 `can("data.write") === false`면 보기 전용. 업로드는 편집자만 (`assets` 기본값).
- 한도: db 문서 25,000개(필기 1개 = 문서 1개), 문서 256KiB (선은 점 5000개까지), 에셋 파일당 20MiB.

## 8. 보안

- 인증 없음. 방 주소(무작위 11자 base64url)를 아는 사람은 누구나 읽고 쓴다.
- 모든 편집 연산·파일명·방 id를 서버에서 검증. 작성자 정보는 서버가 부여.
- 업로드 파일은 생성 id로 저장 (원래 이름으로 경로 구성하지 않음). SVG 업로드는 허용하지 않음.
- 클라이언트는 사용자 문자열을 `textContent`로만 넣는다.
- 외부 공개 시 HTTPS 리버스 프록시(WebSocket 포함) 뒤에 둘 것.

## 9. 테스트

| 종류 | 명령 | 내용 |
|---|---|---|
| 단위 | `npm test` | 검증·연산 적용·문서 삭제·저장/복원, 이미지·PDF·CSV(도구 있을 때) 변환, 잘못된 PDF 오류 |
| 통합 | `npm run smoke [폴더] [--node 경로]` | 서버 실행 → 방 생성 → WebSocket 접속 → 이미지·PDF 업로드 → 변환 완료·이미지 응답 확인. `SMOKE_DOCX=경로`면 Word도 |
| Windows | GitHub Actions | 위 두 가지를 Windows에서, 패키지 node.exe로 |
| 수동 E2E | Playwright 2개 브라우저 | 동시 필기·되돌리기·동기화·내보내기·새로고침 유지 (자동화 스크립트는 저장소에 없음) |

## 10. 알려진 제약

- 수평 확장 불가 (방 상태가 프로세스 메모리에 있음).
- 썸네일이 원본 크기 이미지를 그대로 씀 (페이지 많은 문서에서 무거움).
- 되돌리기 기록은 새로고침하면 사라짐.
- Windows MS Office 변환 경로는 Office가 설치된 실제 PC에서 아직 검증하지 않음 (CI 러너에 Office 없음).
