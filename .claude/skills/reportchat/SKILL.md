---
name: reportchat
description: ReportChat(공유 문서 필기 보드) 저장소에서 기능 추가, 버그 수정, Windows 패키지 빌드·배포, claude.ai 아티팩트 버전 수정을 할 때 사용한다. 필기 도구, WebSocket 프로토콜, 파일 변환(PDF·PPT·Word·Excel), Windows zip, GitHub Actions 빌드, artifact/reportchat.html 게시와 관련된 작업이면 이 스킬을 먼저 따른다.
---

# ReportChat 작업 가이드

문서·스크린샷을 페이지 이미지로 바꿔 띄우고, 그 위에 여러 명이 실시간으로 펜·텍스트 필기를 하는 웹 보드다. 자세한 사양은 `docs/PRD.md`, `docs/TRD.md`, `docs/DRD.md`, 현재 상태와 남은 일은 `docs/HANDOVER.md`에 있다. 작업 전에 HANDOVER의 "남은 일"과 "알려진 문제"를 확인한다.

## 구조 요약

- `server/index.js` Express + ws. 메시지: `join ops draft cursor view me delDoc` → `init users ops draft cursor view doc docRemoved`.
- `server/rooms.js` 상태·검증. **새 필드를 추가하면 `FIELDS` 검증기에 넣어야** 서버가 버리지 않는다.
- `server/convert.js` 이미지 복사 / PDF는 pdf.js + @napi-rs/canvas로 PNG / Office는 Windows MS Office(`office2pdf.ps1`) → LibreOffice 순.
- `public/app.js` 클라이언트. 좌표는 페이지 가로 1000 기준. 편집은 `commit(ops, undoOps)` 한 곳으로만.
- `artifact/reportchat.html` 서버 없는 claude.ai 버전 (db·room·assets·user·downloads capability). **서버 버전과 코드를 공유하지 않는다.** 필기 동작을 바꾸면 양쪽 반영 여부를 판단한다.

## 작업 순서

1. 변경 후 `npm test`로 단위 테스트(11개)를 돌린다.
2. 변환·업로드·서버 흐름을 건드렸으면 `npm run smoke`를 돌린다. Word까지 보려면 `SMOKE_DOCX=<docx 경로> npm run smoke`.
3. 화면을 바꿨으면 브라우저 두 개(Playwright 컨텍스트 2개 등)로 열어 동시 필기·되돌리기·함께 보기·PNG 저장을 확인한다. Playwright는 전역 설치본을 쓰고 `playwright install`은 하지 않는다.
4. 푸시하면 `.github/workflows/windows.yml`이 Windows에서 테스트 → 패키지 빌드 → 패키지 node.exe로 smoke → `windows-latest` 릴리스 교체를 한다. 실패하면 job 로그부터 본다.

## 지켜야 할 것

- `server/office2pdf.ps1`, `windows/ReportChat.cmd`는 **ASCII만** 쓴다 (Windows PowerShell 5.1은 BOM 없는 스크립트를 ANSI로 읽어 한글이 파싱을 깨뜨린다). 한글 안내는 `windows/사용법.txt`와 node가 출력하는 로그에 둔다.
- pdf.js의 `standardFontDataUrl`·`cMapUrl`은 `/`로 끝나는 경로로 넘긴다. `path.sep`을 붙이면 Windows에서 모든 PDF가 실패한다.
- Windows 경로·명령: `.cmd` 실행은 `shell: true`, LibreOffice는 `soffice.com`(완료까지 대기), 사용자 프로필은 `pathToFileURL(...).href`.
- 클라이언트 문자열은 `textContent`로만 넣는다. 서버는 `author`를 접속 정보로 덮어쓴다 — 클라이언트 값을 믿지 않는다.
- Office 변환은 큐로 한 번에 하나씩 돌린다 (`enqueueOffice`). 병렬로 바꾸지 않는다.
- 기존 사용자 데이터 호환: `room.json`의 객체 필드를 바꾸면 로드 시 기본값을 채운다.
- 사용자에게 보이는 문구는 한국어, 결과를 말하는 버튼 이름, 원인과 할 일을 함께 쓰는 오류 문구 (DRD 6장).

## 아티팩트 버전 수정·재게시

- 파일: `artifact/reportchat.html`, 게시 URL: `https://claude.ai/artifact/6NWViyRaLkEirqTPDw6ZSW`.
- 다른 대화에서 수정할 때는 Artifact 도구로 먼저 `read` 한 뒤 `url`을 넘겨 게시한다. capability는 생략하면 기존 선언이 유지된다. 바꿀 때는 전체를 다시 선언: `{"db": {}, "user": {"scopes": ["profile"]}, "room": {"topics": {"draft": "interact"}}, "assets": {}, "downloads": true}`.
- `alert/confirm/prompt`는 동작하지 않으므로 페이지 안의 확인 상자(`ask()`)를 쓴다. 다운로드는 `downloads.save`로만 된다.
- db는 문서마다 한 번에 하나의 쓰기만: `write(path, kind, data)` 큐를 통해서 쓴다.

## Windows 배포

- 릴리스 링크: `https://github.com/git-naru/ReportChat/releases/download/windows-latest/ReportChat-windows.zip` (약 56MB).
- 메일 첨부는 크기와 실행 파일 때문에 차단된다 — 사용자에게는 링크 공유를 안내한다.
- 패키지에 파일을 추가하면 `scripts/build-windows.mjs`의 복사 목록도 고친다.
