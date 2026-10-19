import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { imageSize } from 'image-size';

const run = promisify(execFile);

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'ods', 'csv'];
const OFFICE_EXT = ['pptx', 'ppt', 'odp', 'docx', 'doc', 'odt', 'rtf', 'txt', ...SHEET_EXT];

export const MAX_PAGES = 200;
// 페이지 이미지의 긴 변 픽셀. 시트는 한 장에 담기므로 더 크게 렌더링한다.
const PAGE_PX = 2200;
const SHEET_PAGE_PX = 3200;
const OFFICE_TIMEOUT_MS = 180_000;

export class ConvertError extends Error {}

export const ACCEPT_EXT = [...IMAGE_EXT, 'pdf', ...OFFICE_EXT];

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (SHEET_EXT.includes(ext)) return 'sheet';
  if (OFFICE_EXT.includes(ext)) return 'office';
  return null;
}

/** 외부 도구(LibreOffice, poppler) 설치 여부 */
export async function checkTools() {
  const has = async (cmd, args) => run(cmd, args, { timeout: 20_000 }).then(() => true, () => false);
  return {
    soffice: await has('soffice', ['--version']),
    pdftoppm: await has('pdftoppm', ['-v']),
  };
}

function imageDims(buf) {
  const d = imageSize(buf);
  // EXIF 회전(5~8)은 브라우저가 가로세로를 바꿔 표시하므로 크기도 맞춰 준다
  return d.orientation >= 5 ? { w: d.height, h: d.width } : { w: d.width, h: d.height };
}

// LibreOffice는 같은 사용자 프로필을 동시에 쓰지 못하므로 변환을 한 번에 하나씩 처리한다
let officeQueue = Promise.resolve();
function enqueueOffice(task) {
  const next = officeQueue.then(task, task);
  officeQueue = next.catch(() => {});
  return next;
}

async function officeToPdf(srcPath, workDir, isSheet) {
  const profile = path.join(os.tmpdir(), 'reportchat-lo-profile');
  // 시트마다 한 페이지로 내보내 표가 여러 장으로 잘리지 않게 한다
  const target = isSheet ? 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}' : 'pdf';
  try {
    await run('soffice', [
      `-env:UserInstallation=file://${profile}`,
      '--headless', '--norestore', '--convert-to', target, '--outdir', workDir, srcPath,
    ], { timeout: OFFICE_TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConvertError('서버에 LibreOffice가 설치되어 있지 않아 Office 문서를 변환할 수 없습니다.');
    throw new ConvertError('문서를 변환하지 못했습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.');
  }
  const pdf = path.join(workDir, path.basename(srcPath).replace(/\.[^.]+$/, '') + '.pdf');
  try {
    await fs.access(pdf);
  } catch {
    throw new ConvertError('문서를 PDF로 변환하지 못했습니다.');
  }
  return pdf;
}

async function pdfToPngs(pdfPath, outDir, prefix, px) {
  try {
    await run('pdftoppm', ['-png', '-scale-to', String(px), '-l', String(MAX_PAGES), pdfPath, path.join(outDir, prefix)], { timeout: OFFICE_TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConvertError('서버에 poppler(pdftoppm)가 설치되어 있지 않아 PDF를 변환할 수 없습니다.');
    throw new ConvertError('PDF를 읽지 못했습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.');
  }
  // pdftoppm은 페이지 수에 따라 prefix-1.png 또는 prefix-01.png 형태로 만든다
  const re = new RegExp(`^${prefix}-(\\d+)\\.png$`);
  const files = (await fs.readdir(outDir))
    .map((f) => [f, re.exec(f)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => f);
  if (files.length === 0) throw new ConvertError('변환된 페이지가 없습니다.');
  return files;
}

/**
 * 업로드된 파일을 페이지 이미지 목록으로 변환한다.
 * @returns {Promise<{file: string, w: number, h: number}[]>} outDir 안의 파일명과 픽셀 크기
 */
export async function convertToPages({ srcPath, name, outDir, prefix }) {
  const kind = kindOf(name);
  if (!kind) throw new ConvertError(`지원하지 않는 형식입니다: ${name}`);

  if (kind === 'image') {
    const file = `${prefix}-1.${extOf(name)}`;
    await fs.copyFile(srcPath, path.join(outDir, file));
    let dims;
    try {
      dims = imageDims(await fs.readFile(srcPath));
    } catch {
      throw new ConvertError('이미지를 읽지 못했습니다.');
    }
    return [{ file, ...dims }];
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'reportchat-'));
  try {
    let pdf = srcPath;
    if (kind !== 'pdf') {
      // LibreOffice는 확장자로 형식을 판단하므로 원래 확장자를 붙인 사본을 넘긴다
      const src = path.join(work, `${prefix}.${extOf(name)}`);
      await fs.copyFile(srcPath, src);
      pdf = await enqueueOffice(() => officeToPdf(src, work, kind === 'sheet'));
    }
    const files = await pdfToPngs(pdf, outDir, prefix, kind === 'sheet' ? SHEET_PAGE_PX : PAGE_PX);
    const pages = [];
    for (const file of files) pages.push({ file, ...imageDims(await fs.readFile(path.join(outDir, file))) });
    return pages;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
