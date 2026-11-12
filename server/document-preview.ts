import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { zipSync } from 'fflate';
import readExcelFile from 'read-excel-file/node';
import { Open } from 'unzipper-esm';

const MiB = 1024 * 1024;
async function xlsxText(archive: Buffer) {
  const directory = await Open.buffer(archive);
  if (directory.files.length > 256 || directory.files.reduce((sum, file) => sum + file.uncompressedSize, 0) > 24 * MiB) {
    throw new Error('XLSX archive exceeds preview limits');
  }
  const xml: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const file of directory.files) {
    if (file.type === 'Directory' || !/\.(?:xml|rels)$/i.test(file.path)) continue;
    if (file.uncompressedSize > 8 * MiB || Object.hasOwn(xml, file.path)) throw new Error('Invalid XLSX entry');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream()) {
      size += chunk.length;
      total += chunk.length;
      if (size > file.uncompressedSize || total > 24 * MiB) throw new Error('XLSX expansion exceeds preview limits');
      chunks.push(chunk as Buffer);
    }
    if (size !== file.uncompressedSize) throw new Error('Invalid XLSX archive');
    xml[file.path] = Buffer.concat(chunks, size);
  }
  // Parse a fresh ZIP built from the bounded XML, so both readers see the same entries and sizes.
  const sheets = await readExcelFile(Buffer.from(zipSync(xml, { level: 0 })));
  return sheets.slice(0, 6).map(sheet => {
    const rows = sheet.data.slice(0, 25).map(row => row.slice(0, 16).map(cell => String(cell ?? '').slice(0, 250)).join(' | '));
    return `Лист: ${sheet.sheet}\n${rows.join('\n')}`;
  }).join('\n\n').slice(0, 8000);
}

async function pdfText(data: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');
  const task = getDocument({
    data, useSystemFonts: false, maxImageSize: 4_000_000,
    standardFontDataUrl: pdfRoot + '/standard_fonts/', cMapUrl: pdfRoot + '/cmaps/', wasmUrl: pdfRoot + '/wasm/',
  });
  try {
    const doc = await task.promise;
    let text = '';
    for (let page = 1; page <= Math.min(5, doc.numPages); page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      text += `Страница ${page}\n` + content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n';
      if (text.length >= 8000) break;
    }
    return text.slice(0, 8000);
  } finally { await task.destroy(); }
}
const { kind, input } = workerData as { kind: 'pdf' | 'xlsx'; input: Uint8Array };
const text = kind === 'pdf' ? await pdfText(input) : await xlsxText(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
parentPort!.postMessage(text);
