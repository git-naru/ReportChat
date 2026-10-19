import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { imageSize } from 'image-size';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'ods', 'csv'];
const SLIDE_EXT = ['pptx', 'ppt', 'odp'];
const WORD_EXT = ['docx', 'doc', 'odt', 'rtf', 'txt'];
const OFFICE_EXT = [...SLIDE_EXT, ...WORD_EXT, ...SHEET_EXT];

export const MAX_PAGES = 200;
// 페이지 이미지의 긴 변 픽셀. 시트는 한 장에 담기므로 더 크게 렌더링한다.
const PAGE_PX = 2200;
const SHEET_PAGE_PX = 3200;
const OFFICE_TIMEOUT_MS = 180_000;
const IS_WINDOWS = process.platform === 'win32';

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

/** LibreOffice 실행 파일. Windows·macOS는 기본 설치 위치도 찾아본다. */
function findSoffice() {
  const candidates = IS_WINDOWS
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
      .filter(Boolean)
      // soffice.com은 변환이 끝날 때까지 기다리는 콘솔용 실행 파일이다
      .flatMap((dir) => [path.join(dir, 'LibreOffice', 'program', 'soffice.com'), path.join(dir, 'LibreOffice', 'program', 'soffice.exe')])
    : ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return candidates.find((p) => existsSync(p)) || 'soffice';
}
const SOFFICE = process.env.SOFFICE_PATH || findSoffice();

async function hasMsOffice() {
  if (!IS_WINDOWS) return false;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "'Word','PowerPoint','Excel' | Where-Object { [type]::GetTypeFromProgID(\"$_.Application\") } | ForEach-Object { $_ }"], { timeout: 20_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 문서 변환 도구 설치 여부 */
export async function checkTools() {
  const soffice = await run(SOFFICE, ['--version'], { timeout: 30_000 }).then(() => true, () => false);
  return { soffice, msOffice: await hasMsOffice() };
}

function imageDims(buf) {
  const d = imageSize(buf);
  // EXIF 회전(5~8)은 브라우저가 가로세로를 바꿔 표시하므로 크기도 맞춰 준다
  return d.orientation >= 5 ? { w: d.height, h: d.width } : { w: d.width, h: d.height };
}

// Office와 LibreOffice는 동시에 여러 변환을 돌리면 불안정하므로 한 번에 하나씩 처리한다
let officeQueue = Promise.resolve();
function enqueueOffice(task) {
  const next = officeQueue.then(task, task);
  officeQueue = next.catch(() => {});
  return next;
}

/** Windows에 설치된 Microsoft Office로 PDF를 만든다 */
async function msOfficeToPdf(srcPath, pdfPath) {
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(HERE, 'office2pdf.ps1'), '-In', srcPath, '-Out', pdfPath,
  ], { timeout: OFFICE_TIMEOUT_MS, windowsHide: true });
  await fs.access(pdfPath);
}

async function libreOfficeToPdf(srcPath, workDir, isSheet) {
  const profile = pathToFileURL(path.join(os.tmpdir(), 'reportchat-lo-profile')).href;
  // 시트마다 한 페이지로 내보내 표가 여러 장으로 잘리지 않게 한다
  const target = isSheet ? 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}' : 'pdf';
  await run(SOFFICE, [
    `-env:UserInstallation=${profile}`,
    '--headless', '--norestore', '--convert-to', target, '--outdir', workDir, srcPath,
  ], { timeout: OFFICE_TIMEOUT_MS, windowsHide: true });
  const pdf = path.join(workDir, path.basename(srcPath).replace(/\.[^.]+$/, '') + '.pdf');
  await fs.access(pdf);
  return pdf;
}

async function officeToPdf(srcPath, workDir, isSheet) {
  const tools = await toolsOnce();
  if (tools.msOffice) {
    const pdf = path.join(workDir, 'msoffice.pdf');
    try {
      await msOfficeToPdf(srcPath, pdf);
      return pdf;
    } catch (err) {
      if (!tools.soffice) {
        console.error('Office 변환 실패:', err.stderr || err.message);
        throw new ConvertError('Microsoft Office로 문서를 변환하지 못했습니다. 파일이 다른 프로그램에서 열려 있거나 암호가 걸려 있는지 확인하세요.');
      }
    }
  }
  if (!tools.soffice) {
    throw new ConvertError(IS_WINDOWS
      ? 'PPT·Word·Excel을 열려면 이 PC에 Microsoft Office나 LibreOffice가 설치되어 있어야 합니다.'
      : '서버에 LibreOffice가 설치되어 있지 않아 Office 문서를 변환할 수 없습니다.');
  }
  try {
    return await libreOfficeToPdf(srcPath, workDir, isSheet);
  } catch {
    throw new ConvertError('문서를 변환하지 못했습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.');
  }
}

let toolsPromise = null;
const toolsOnce = () => (toolsPromise ||= checkTools());

let pdfjsPromise = null;
async function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    const { createCanvas } = require('@napi-rs/canvas');
    // pdf.js는 '/'로 끝나는 경로만 받으므로 Windows에서도 슬래시로 바꿔 넘긴다
    const dir = path.dirname(require.resolve('pdfjs-dist/package.json')).split(path.sep).join('/');
    return { pdfjs, createCanvas, fonts: `${dir}/standard_fonts/`, cmaps: `${dir}/cmaps/` };
  })();
  return pdfjsPromise;
}

/** PDF 각 페이지를 PNG로 그린다 (pdf.js + 내장 캔버스, 외부 프로그램 불필요) */
async function pdfToPngs(pdfPath, outDir, prefix, px) {
  const { pdfjs, createCanvas, fonts, cmaps } = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(await fs.readFile(pdfPath)),
      standardFontDataUrl: fonts, cMapUrl: cmaps, cMapPacked: true, verbosity: 0,
    }).promise;
  } catch (err) {
    if (err?.name !== 'InvalidPDFException' && err?.name !== 'PasswordException') console.error('PDF 열기 실패:', err);
    throw new ConvertError('PDF를 읽지 못했습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.');
  }
  try {
    const pages = [];
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: px / Math.max(base.width, base.height) });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const file = `${prefix}-${i}.png`;
      await fs.writeFile(path.join(outDir, file), await canvas.encode('png'));
      pages.push({ file, w: canvas.width, h: canvas.height });
      page.cleanup();
    }
    if (pages.length === 0) throw new ConvertError('PDF에 페이지가 없습니다.');
    return pages;
  } finally {
    await doc.destroy();
  }
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
    try {
      return [{ file, ...imageDims(await fs.readFile(srcPath)) }];
    } catch {
      throw new ConvertError('이미지를 읽지 못했습니다.');
    }
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'reportchat-'));
  try {
    let pdf = srcPath;
    if (kind !== 'pdf') {
      // 변환 프로그램은 확장자로 형식을 판단하므로 원래 확장자를 붙인 사본을 넘긴다
      const src = path.join(work, `${prefix}.${extOf(name)}`);
      await fs.copyFile(srcPath, src);
      pdf = await enqueueOffice(() => officeToPdf(src, work, kind === 'sheet'));
    }
    return await pdfToPngs(pdf, outDir, prefix, kind === 'sheet' ? SHEET_PAGE_PX : PAGE_PX);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
