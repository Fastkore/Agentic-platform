import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import readExcelFile from 'read-excel-file/node';

/**
 * Isolated extraction of tables and PDF text for project sources. Runs in a worker with memory limits and a timeout;
 * produces one line per table row (with sheet, row number and column headers) or per PDF text line, so tools can read by lines.
 */
async function xlsxLines(input: Buffer) {
  const sheets = await readExcelFile(input);
  const lines: string[] = [];
  for (const sheet of sheets) {
    const header = (sheet.data[0] ?? []).map((cell, i) => String(cell ?? '').trim() || `Колонка ${i + 1}`);
    lines.push(`# Лист: ${sheet.sheet} · строк ${sheet.data.length}`);
    sheet.data.forEach((row, index) => {
      if (index === 0) { lines.push(`[${sheet.sheet}:1] ` + header.join(' | ')); return; }
      const cells = row.map((cell, i) => cell === null || cell === undefined || cell === '' ? '' : `${header[i] ?? 'Колонка ' + (i + 1)}: ${String(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell)}`)
        .filter(Boolean);
      lines.push(`[${sheet.sheet}:${index + 1}] ` + cells.join(' | '));
    });
  }
  return lines.join('\n');
}
async function pdfLines(data: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');
  const task = getDocument({ data, useSystemFonts: false, maxImageSize: 1,
    standardFontDataUrl: pdfRoot + '/standard_fonts/', cMapUrl: pdfRoot + '/cmaps/', wasmUrl: pdfRoot + '/wasm/' });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      out.push(`# Страница ${page}`);
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { out.push(line); line = ''; } else line += ' ';
      }
      if (line.trim()) out.push(line);
    }
    return out.join('\n');
  } finally { await task.destroy(); }
}
const { kind, input } = workerData as { kind: 'pdf' | 'xlsx'; input: Uint8Array };
const text = kind === 'pdf' ? await pdfLines(input) : await xlsxLines(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
parentPort!.postMessage(text);
