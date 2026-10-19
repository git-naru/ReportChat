import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkTools, convertToPages, kindOf } from '../server/convert.js';

const tools = await checkTools();

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 글자 한 줄이 있는 최소 PDF를 만든다 (pages: 쪽 수) */
function makePdf(pages = 2) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-conv-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('kindOf: 확장자로 종류를 판별한다', () => {
  assert.equal(kindOf('캡처.PNG'), 'image');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('보고서.pptx'), 'office');
  assert.equal(kindOf('표.xlsx'), 'sheet');
  assert.equal(kindOf('a.exe'), null);
  assert.equal(kindOf('noext'), null);
});

test('이미지는 그대로 한 페이지가 된다', () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, PNG);
  const pages = await convertToPages({ srcPath: src, name: 'shot.png', outDir: dir, prefix: 'doc1' });
  assert.deepEqual(pages, [{ file: 'doc1-1.png', w: 1, h: 1 }]);
}));

test('PDF는 쪽마다 PNG가 된다', () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, makePdf(2));
  const pages = await convertToPages({ srcPath: src, name: '자료.pdf', outDir: dir, prefix: 'doc3' });
  assert.deepEqual(pages.map((p) => p.file), ['doc3-1.png', 'doc3-2.png']);
  // 긴 변이 2200px, 가로세로 비율은 Letter(612x792)
  assert.equal(pages[0].h, 2200);
  assert.equal(pages[0].w, Math.round(2200 * 612 / 792));
  const png = await fs.readFile(path.join(dir, 'doc3-1.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
}));

test('Office 문서(CSV)를 페이지 이미지로 변환한다', { skip: !(tools.soffice || tools.msOffice) && 'Office/LibreOffice 없음', timeout: 200_000 }, () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, 'name,qty\npump,2\nvalve,10\n');
  const pages = await convertToPages({ srcPath: src, name: 'list.csv', outDir: dir, prefix: 'doc2' });
  assert.equal(pages.length, 1);
  assert.match(pages[0].file, /^doc2-\d+\.png$/);
  assert.ok(pages[0].w > 100 && pages[0].h > 100);
}));

test('잘못된 PDF는 알기 쉬운 오류로 실패한다', () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, 'not a pdf');
  await assert.rejects(convertToPages({ srcPath: src, name: 'x.pdf', outDir: dir, prefix: 'd' }), /PDF를 읽지 못했습니다/);
}));
