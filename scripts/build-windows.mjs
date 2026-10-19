// Windows 포터블 패키지 만들기: dist/ReportChat/ 폴더와 dist/ReportChat-windows.zip
//   node scripts/build-windows.mjs [--node <node.exe 경로>] [--no-zip]
// Windows에서 실행하면 지금 쓰는 node.exe를 함께 넣는다. 다른 OS에서는 --node로 node.exe를 지정한다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'ReportChat');
const ZIP = path.join(DIST, 'ReportChat-windows.zip');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const nodeExe = opt('--node') || (process.platform === 'win32' ? process.execPath : null);
if (!nodeExe || !fs.existsSync(nodeExe)) {
  console.error('node.exe를 찾을 수 없습니다. Windows에서 실행하거나 --node <node.exe 경로>를 지정하세요.');
  process.exit(1);
}

const step = (msg) => console.log(`\n▶ ${msg}`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const toCrlf = (text) => text.replace(/\r?\n/g, '\r\n');

step('폴더 준비');
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(path.join(OUT, 'node'), { recursive: true });
for (const dir of ['server', 'public']) fs.cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(OUT, file));
// 배치 파일과 안내문은 Windows 줄바꿈으로 넣는다
fs.writeFileSync(path.join(OUT, 'ReportChat.cmd'), toCrlf(fs.readFileSync(path.join(ROOT, 'windows', 'ReportChat.cmd'), 'utf8')));
fs.writeFileSync(path.join(OUT, 'server', 'office2pdf.ps1'), toCrlf(fs.readFileSync(path.join(ROOT, 'server', 'office2pdf.ps1'), 'utf8')));
fs.writeFileSync(path.join(OUT, '사용법.txt'), '﻿' + toCrlf(fs.readFileSync(path.join(ROOT, 'windows', '사용법.txt'), 'utf8')));

step('실행 파일 복사 (node.exe)');
fs.copyFileSync(nodeExe, path.join(OUT, 'node', 'node.exe'));

step('라이브러리 설치 (Windows x64용)');
execFileSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--os=win32', '--cpu=x64'], {
  cwd: OUT, stdio: 'inherit', shell: process.platform === 'win32',
});
const canvasBin = path.join(OUT, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc');
if (!fs.existsSync(canvasBin)) {
  console.error('Windows용 캔버스 모듈(@napi-rs/canvas-win32-x64-msvc)이 설치되지 않았습니다.');
  process.exit(1);
}

if (!args.includes('--no-zip')) {
  step('압축');
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${OUT}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', ZIP, 'ReportChat'], { cwd: DIST, stdio: 'inherit' });
  }
  console.log(`\n완료: ${ZIP} (${(fs.statSync(ZIP).size / 1048576).toFixed(1)}MB)`);
} else {
  console.log(`\n완료: ${OUT}`);
}
