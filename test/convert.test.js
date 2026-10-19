import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkTools, convertToPages, kindOf } from '../server/convert.js';

const tools = await checkTools();

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

test('Office 문서(CSV)를 페이지 이미지로 변환한다', { skip: !(tools.soffice && tools.pdftoppm) && 'LibreOffice/poppler 없음', timeout: 200_000 }, () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, 'name,qty\npump,2\nvalve,10\n');
  const pages = await convertToPages({ srcPath: src, name: 'list.csv', outDir: dir, prefix: 'doc2' });
  assert.equal(pages.length, 1);
  assert.match(pages[0].file, /^doc2-\d+\.png$/);
  assert.ok(pages[0].w > 100 && pages[0].h > 100);
}));

test('잘못된 PDF는 알기 쉬운 오류로 실패한다', { skip: !tools.pdftoppm && 'poppler 없음' }, () => withDir(async (dir) => {
  const src = path.join(dir, 'upload');
  await fs.writeFile(src, 'not a pdf');
  await assert.rejects(convertToPages({ srcPath: src, name: 'x.pdf', outDir: dir, prefix: 'd' }), /PDF를 읽지 못했습니다/);
}));
