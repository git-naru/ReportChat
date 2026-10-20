# 인수인계 — ReportChat

작성일 2026-10-20 · 기준 커밋 `13b3a9f` (브랜치 `claude/quirky-galileo-7x9rmw`)

이 문서만 읽고 바로 이어서 작업할 수 있도록 현재 상태, 실행 방법, 남은 일, 주의할 점을 정리했다. 제품·기술·디자인 세부는 [PRD](PRD.md) · [TRD](TRD.md) · [DRD](DRD.md)를 본다.

## 1. 한 줄 요약

스크린샷·PDF·PPT·Excel·Word를 올리면 참여자 모두의 화면에 같은 페이지가 뜨고, 각자 다른 색 펜과 키보드 텍스트로 실시간으로 함께 필기하는 웹 보드. Node.js 서버 버전, Windows 포터블 버전, claude.ai 아티팩트 버전이 있다.

## 2. 현재 상태

| 산출물 | 위치 | 상태 |
|---|---|---|
| 서버 버전 | `server/`, `public/` | 완료. 2인 동시 브라우저 E2E 수동 검증 완료 (Linux) |
| Windows 포터블 | [릴리스 `windows-latest`](https://github.com/git-naru/ReportChat/releases/tag/windows-latest) `ReportChat-windows.zip` 56MB | CI(Windows)에서 빌드 + 패키지 node.exe로 이미지·PDF 업로드/변환 검증 통과 ([실행 기록](https://github.com/git-naru/ReportChat/actions/runs/39340183194)) |
| Docker | `Dockerfile` | 작성 완료. **이미지 빌드는 아직 해 보지 않음** |
| 아티팩트 버전 | `artifact/reportchat.html` → https://claude.ai/artifact/6NWViyRaLkEirqTPDw6ZSW | 게시 완료, 로컬 렌더링·db 응답 확인. **claude.ai 안에서 실제 업로드·2인 동시 필기는 미검증** |
| 문서 | `docs/`, `README.md`, `windows/사용법.txt` | 작성 완료 |
| PR | 없음 | 브랜치만 푸시됨. `main` 브랜치 없음 (저장소 첫 커밋부터 이 브랜치) |

## 3. 바로 실행하기

```bash
git clone -b claude/quirky-galileo-7x9rmw https://github.com/git-naru/ReportChat.git
cd ReportChat
npm install
npm start                 # http://localhost:3000 , 같은 네트워크 주소도 출력됨
npm test                  # 단위 테스트 11개
npm run smoke             # 서버 띄워 이미지·PDF 업로드 통합 확인 (SMOKE_DOCX=파일 로 Word도)
```

- Office 문서 변환: Linux/macOS는 LibreOffice 필요, Windows는 설치된 MS Office 우선.
- Windows 패키지 수동 빌드 (Windows에서): `npm ci && npm run build:windows` → `dist/ReportChat-windows.zip`.
- 아티팩트 수정 후 재게시: Claude Code에서 `artifact/reportchat.html`을 고치고 Artifact 도구로 위 URL(`url`)에 게시. capability 선언은 TRD 7장.

## 4. 주요 결정과 이유

| 결정 | 이유 |
|---|---|
| 모든 파일을 서버에서 **페이지 이미지(PNG)로 변환**해 그 위에 필기 | 형식과 상관없이 같은 방식으로 표시·필기·내보내기 가능. 원본 편집은 범위 밖 |
| 필기 좌표를 **페이지 가로 1000 기준**으로 저장 | 화면 크기·확대와 무관하게 모두 같은 위치 |
| 필기를 **객체 단위 연산(add/upd/del) + last-writer-wins** | 필기는 사람마다 따로 그리므로 충돌이 드묾. CRDT는 과함 |
| PDF 렌더링을 poppler에서 **pdf.js + @napi-rs/canvas**로 교체 | Windows에서 외부 프로그램 없이 동작. 플랫폼별 네이티브 바이너리는 npm이 받아 줌 |
| Windows Office 변환에 **PowerShell COM** | 사용자 PC에 대부분 MS Office가 있고, 변환 품질이 가장 좋음. 없으면 LibreOffice |
| Windows 배포를 **node.exe 포함 zip** | 설치 프로그램·서명 없이 더블클릭으로 실행. 대신 SmartScreen 경고가 뜰 수 있음 |
| Windows 빌드를 **GitHub Actions(windows-latest)** 에서 | 개발 환경이 Linux라 실제 Windows에서 빌드·검사하기 위해 |
| 아티팩트 버전에서 Office 미지원 | 브라우저 안에서 PPT·Word·Excel을 정확히 렌더링할 방법이 없음 → PDF로 저장 후 올리도록 안내 |

## 5. 남은 일 (우선순위 순)

1. **MS Office가 설치된 실제 Windows PC에서 PPT·Word·Excel 변환 확인.** CI 러너에는 Office가 없어 `server/office2pdf.ps1` 경로는 한 번도 실행되지 않았다. 확인할 것: 변환 성공, 변환 후 `POWERPNT.EXE`/`WINWORD.EXE`/`EXCEL.EXE` 프로세스가 남지 않는지, 파일이 Office에서 열려 있을 때의 오류 문구.
2. **아티팩트 버전 실사용 검증.** 편집자 2명으로 열어 스크린샷 붙여넣기, PDF 업로드, 동시 필기, 커서 표시, 함께 보기, PNG 저장을 확인.
3. **Docker 이미지 빌드·실행 확인** (`docker build -t reportchat .`).
4. **배포 공유 방법 정리.** zip이 56MB이고 실행 파일이 들어 있어 메일 첨부는 차단된다. 릴리스 링크로 공유 중. 필요하면 크기 줄이기(아래 6장) 또는 코드 서명 검토.
5. **PR 생성과 `main` 브랜치 정리.** 지금은 기능 브랜치만 있다. CI는 `main`과 `claude/**` 푸시에 돌고, 매번 `windows-latest` 릴리스를 덮어쓴다 — `main`이 생기면 릴리스는 `main`에서만 게시하도록 조건을 거는 것이 좋다.
6. P2 기능 (PRD 5장): 전체 페이지 PDF 내보내기, 보드 접근 권한, 채팅·댓글, HWP.

## 6. 알려진 문제와 주의점

| 구분 | 내용 | 비고 |
|---|---|---|
| 보안 | 인증 없음. 방 주소를 아는 사람은 누구나 읽고 쓴다 | 내부망 사용 권장 |
| Windows | 첫 실행 시 SmartScreen("추가 정보 → 실행"), 방화벽("액세스 허용") 창 | `사용법.txt`에 안내 |
| Windows | `office2pdf.ps1`과 `ReportChat.cmd`는 **ASCII만** 써야 함 | PowerShell 5.1이 BOM 없는 스크립트를 ANSI로 읽음 |
| Windows | pdf.js 글꼴·CMap 경로는 `/`로 끝나야 함 | `\`로 넘겨 모든 PDF가 실패했던 버그를 `13b3a9f`에서 수정 |
| 배포 | zip 56MB, 대부분 node.exe | 메일 첨부 불가 |
| 성능 | 문서 목록 썸네일이 원본 크기 이미지 | 페이지가 많은 PDF에서 무거움. 작은 썸네일 생성이 개선안 |
| 기능 | 되돌리기 기록은 새로고침하면 사라짐 | 클라이언트 메모리에만 있음 |
| 확장 | 단일 프로세스, 방 상태가 메모리에 있음 | 여러 서버로 늘리려면 상태 저장소 분리 필요 |
| 데이터 | 방과 파일을 지우는 정리 작업 없음 | `DATA_DIR`이 계속 커짐 |
| 아티팩트 | 참여자를 **편집자**로 이메일 초대해야 쓰기 가능. 업로드 도중 창을 닫으면 문서가 "올리는 중"으로 남음(삭제 가능) | 필기 1개 = db 문서 1개, 보드당 25,000개 한도 |
| CI | `actions/checkout@v4`, `setup-node@v4`가 Node 20 사용 경고 | 동작에는 문제 없음. v5로 올리면 해결 |

## 7. 파일 안내

| 파일 | 고칠 때 볼 곳 |
|---|---|
| `server/index.js` | 라우트, WebSocket 메시지 처리(`switch (msg.t)`), 변환 작업 `convert()`, 시작 로그 |
| `server/rooms.js` | 필드 추가 시 `FIELDS` 검증기, 한도 `LIMITS` |
| `server/convert.js` | 형식 추가 시 확장자 목록과 `kindOf`, 해상도 `PAGE_PX` |
| `public/app.js` | 도구 추가 시 `pointerdown`/`pointermove`/`endGesture`, 객체 그리기 `drawObj`, 되돌리기 `commit` |
| `artifact/reportchat.html` | 서버 버전과 같은 구조. 네트워크 부분만 `write()`(db), `room.emit`, `assets.upload`로 다름 |
| `scripts/build-windows.mjs` | 패키지에 파일 추가 시 |
| `.github/workflows/windows.yml` | 빌드·검사·릴리스 단계 |

서버 버전과 아티팩트 버전은 **코드를 공유하지 않는다**. 필기 기능을 고치면 두 곳 모두 반영할지 판단해야 한다.

## 8. 연락·이력

- 커밋 이력: `cbd99ea` 서버 버전 → `45d1d2b` 아티팩트 버전 → `76e1b6d` Windows 포터블 → `13b3a9f` Windows PDF 경로 수정 → (이 문서) 문서화.
- Claude Code에서 이어서 작업할 때는 `.claude/skills/reportchat/SKILL.md`가 자동으로 참고된다.
