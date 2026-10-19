// 패키지 동작 확인: 서버를 띄워 이미지·PDF(가능하면 Word도)를 올리고 페이지로 변환되는지 본다.
//   node scripts/smoke.mjs [패키지 폴더] [--node <실행할 node 경로>]
// 패키지 폴더를 생략하면 저장소 자체를 검사한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const nodeIdx = args.indexOf('--node');
const nodeBin = nodeIdx >= 0 ? path.resolve(args.splice(nodeIdx, 2)[1]) : process.execPath;
const appDir = path.resolve(args[0] || ROOT);
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-smoke-'));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function makePdf() {
  const content = 'BT /F1 48 Tf 72 700 Td (ReportChat) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const server = spawn(nodeBin, [path.join(appDir, 'server', 'index.js')], {
  cwd: appDir, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; process.stdout.write(`[server] ${d}`); });
server.stderr.on('data', (d) => { log += d; process.stderr.write(`[server] ${d}`); });

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  server.kill();
  process.exit(1);
}
setTimeout(() => fail('시간 초과'), 240_000).unref();

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch { /* 아직 안 뜸 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail('서버가 시작되지 않았습니다');
}

await waitReady();
console.log('✓ 서버 시작');
const page = await fetch(`${base}/`);
if (!(await page.text()).includes('ReportChat')) fail('첫 화면을 받지 못했습니다');
const { id: room } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const docs = new Map();
await new Promise((resolve, reject) => {
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, clientId: 'smoke1', name: '검사', color: '#2563eb' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'init') resolve();
    if (msg.t === 'doc') docs.set(msg.doc.name, msg.doc);
  });
  ws.on('error', reject);
});
console.log('✓ 실시간 연결');

const files = [['screen.png', PNG, 'image/png'], ['자료.pdf', makePdf(), 'application/pdf']];
const docxPath = process.env.SMOKE_DOCX;
if (docxPath && fs.existsSync(docxPath)) files.push(['보고서.docx', fs.readFileSync(docxPath), 'application/octet-stream']);
const form = new FormData();
for (const [name, buf, type] of files) form.append('files', new Blob([buf], { type }), name);
form.append('name', '검사');
const up = await fetch(`${base}/api/rooms/${room}/upload`, { method: 'POST', body: form });
if (!up.ok) fail(`업로드 실패: ${up.status} ${await up.text()}`);
console.log('✓ 업로드');

for (let i = 0; i < 1200; i++) {
  const done = files.every(([name]) => ['ready', 'error'].includes(docs.get(name)?.status));
  if (done) break;
  await new Promise((r) => setTimeout(r, 100));
}
for (const [name] of files) {
  const doc = docs.get(name);
  if (doc?.status !== 'ready') fail(`${name} 변환 실패: ${doc?.error || '응답 없음'}`);
  const img = await fetch(base + doc.pages[0].url);
  if (!img.ok) fail(`${name} 페이지 이미지를 받지 못했습니다`);
  console.log(`✓ ${name}: ${doc.pages.length}쪽, ${doc.pages[0].w}x${doc.pages[0].h}`);
}

ws.close();
server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\n모든 검사 통과');
process.exit(0);
