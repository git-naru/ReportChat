# ReportChat

스크린샷, PDF, PowerPoint, Excel, Word 파일을 올리면 참여한 모두가 같은 화면을 보며 **각자의 색 펜**과 **키보드 텍스트**로 함께 표시하는 실시간 공유 보드입니다.

## 기능

- **보드 만들기·초대**: 시작 화면에서 새 보드를 만들고 `초대 링크 복사`로 링크를 보내면 됩니다. 처음 들어올 때 이름과 펜 색을 정하고, 다른 사람이 이미 쓰는 색은 피해서 자동으로 정해집니다.
- **파일 올리기**: 버튼, 드래그&드롭, `Ctrl+V`로 스크린샷 붙여넣기를 지원합니다. 올린 파일은 페이지 이미지로 변환되어 모두의 화면에 바로 표시됩니다.
  - 이미지: png, jpg, gif, webp, bmp
  - PDF
  - PowerPoint(pptx, ppt, odp) · Word(docx, doc, odt, rtf, txt) · Excel(xlsx, xlsm, xls, ods, csv). Excel은 시트 하나가 한 페이지가 됩니다.
- **필기 도구**
  - 펜 / 형광펜: 색 9가지, 굵기 3단계. 그리는 중인 선도 다른 사람 화면에 실시간으로 보입니다.
  - 텍스트: 원하는 곳을 클릭하고 키보드로 입력합니다(여러 줄 가능). 입력하는 글자가 실시간으로 공유됩니다. 기존 텍스트를 클릭하면 수정합니다.
  - 선택·이동: 필기를 끌어서 옮기고 `Delete`로 지웁니다. 필기에 마우스를 올리면 작성자가 보입니다. 빈 곳을 끌면 화면이 이동합니다.
  - 지우개: 문지른 필기를 지웁니다.
  - 되돌리기/다시 실행(`Ctrl+Z` / `Ctrl+Shift+Z`): 내가 한 작업만 되돌립니다.
  - 페이지의 내 필기 또는 모든 필기 지우기, 필기를 포함한 페이지 PNG 저장.
- **함께 보기**: 켜 두면 누가 페이지를 넘기거나 새 파일을 올렸을 때 모두 같은 페이지로 이동합니다. 끄면 혼자 다른 페이지를 볼 수 있습니다. 다른 참여자의 마우스 위치가 이름표와 함께 보입니다.
- **확대/축소**: `Ctrl+휠`, `+`/`-`, `0`(맞춤). `Space`를 누른 채 끌면 화면이 이동합니다.
- **저장**: 보드 상태는 서버의 `DATA_DIR`에 저장되어 새로고침하거나 나중에 다시 들어와도 그대로 남습니다. 연결이 잠시 끊긴 동안 한 필기는 다시 연결되면 전송됩니다.

단축키: `V` 선택, `P` 펜, `H` 형광펜, `T` 텍스트, `E` 지우개, `PageUp`/`PageDown` 페이지 이동.

## Windows 버전 (설치 불필요)

[Windows 최신 빌드](https://github.com/git-naru/ReportChat/releases/tag/windows-latest)에서 `ReportChat-windows.zip`을 받아 압축을 풀고 `ReportChat.cmd`를 더블클릭하면 됩니다. Node.js가 함께 들어 있어 따로 설치할 것이 없고, 실행하면 브라우저가 열리며 검은 창에 같은 네트워크의 다른 사람이 접속할 주소가 나옵니다.

- PPT·Word·Excel은 PC에 설치된 Microsoft Office로 변환합니다. Office가 없으면 LibreOffice를 설치하면 됩니다.
- 처음 실행할 때 방화벽 창이 뜨면 **액세스 허용**을 눌러야 다른 사람이 접속할 수 있습니다.
- 자세한 내용은 압축 안의 `사용법.txt`를 보세요.

패키지는 GitHub Actions(`.github/workflows/windows.yml`)가 Windows에서 만들고, 패키지 안의 node.exe로 서버를 띄워 이미지·PDF 업로드와 변환을 확인한 뒤 릴리스에 올립니다. 직접 만들려면 Windows에서 `npm ci && npm run build:windows`를 실행하면 `dist/ReportChat-windows.zip`이 생깁니다.

## 실행

Node.js 20 이상이 필요합니다. 이미지와 PDF는 이것만으로 동작합니다. PPT·Word·Excel을 열려면 **LibreOffice**가 필요합니다(Windows에서는 설치된 **Microsoft Office**를 먼저 사용합니다).

```bash
# Ubuntu/Debian
sudo apt install libreoffice fonts-noto-cjk

npm install
npm start          # http://localhost:3000
```

Docker(변환 도구와 한글 글꼴 포함):

```bash
docker build -t reportchat .
docker run -p 3000:3000 -v reportchat-data:/data reportchat
```

같은 네트워크의 다른 사람은 `http://<서버 IP>:3000`으로 접속합니다. 외부에 공개할 때는 HTTPS 리버스 프록시(WebSocket `/ws` 포함) 뒤에 두세요.

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `DATA_DIR` | `./data` | 보드 상태와 페이지 이미지 저장 위치 |
| `MAX_FILE_MB` | `100` | 파일당 업로드 한도 |

## 구조

```
server/index.js    Express(업로드·파일 제공) + WebSocket(실시간 동기화)
server/rooms.js    보드 상태, 편집 연산 검증·적용, 디스크 저장
server/convert.js  파일 → 페이지 이미지 변환 (Office/LibreOffice → PDF → pdf.js로 PNG)
server/office2pdf.ps1  Windows에서 Microsoft Office로 PDF 저장
windows/           Windows 포터블 패키지의 실행 파일·안내문
scripts/           Windows 패키지 빌드, 동작 확인(smoke) 스크립트
public/            브라우저 클라이언트 (빌드 단계 없는 순수 JS)
test/              node --test 단위 테스트
```

- 필기는 페이지 가로를 1000으로 둔 좌표계에 저장하므로 화면 크기나 확대 배율과 관계없이 모두에게 같은 위치에 보입니다.
- 편집은 `add`/`upd`/`del` 연산으로 WebSocket을 통해 주고받습니다. 서버가 모든 연산을 검증한 뒤 반영하고 다른 참여자에게 전달합니다. 같은 객체를 동시에 고치면 나중에 도착한 것이 남습니다.
- 보드 주소를 아는 사람은 누구나 들어올 수 있습니다(주소는 추측하기 어려운 무작위 문자열). 로그인이나 권한 관리는 없으므로 민감한 문서는 내부망에서 사용하세요.

## 테스트

```bash
npm test
```

## claude.ai 아티팩트 버전 (설치 불필요)

`artifact/reportchat.html`은 서버 없이 claude.ai 아티팩트로 실행되는 버전입니다. 보드 데이터와 업로드한 파일은 아티팩트의 저장소에 남고, 접속자의 커서와 그리는 중인 선은 실시간으로 공유됩니다.

- 이미지와 PDF는 바로 올릴 수 있습니다. PDF는 브라우저에서 쪽마다 이미지로 바뀝니다.
- PPT, Word, Excel은 브라우저에서 변환할 수 없으므로 원본 프로그램에서 PDF로 저장한 뒤 올려야 합니다.
- 함께 필기하고 파일을 올리려면, 아티팩트의 공유 메뉴에서 참여자를 **편집자**로 초대해야 합니다. 보기 권한만 있는 사람은 보기만 할 수 있습니다.
- 게시할 때 선언하는 capability: `db`, `user`(profile), `room`(`draft` 주제를 interact에 개방), `assets`, `downloads`.
