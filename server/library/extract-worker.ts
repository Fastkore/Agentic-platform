import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import readExcelFile from 'read-excel-file/node';
import { strFromU8, unzipSync } from 'fflate';
import { Parser } from 'saxen';

/**
 * Isolated extraction of tables, Word documents and PDF text for the project library. Runs in a worker with memory limits and a timeout;
 * produces one line per table row (with sheet, row number and column headers) or per PDF text line, so tools can read by lines.
 */
/** A line of extracted text never starts with "#" unless it is a section marker (page, sheet, heading). */
const plain = (line: string) => line.startsWith('#') ? '\\' + line : line;
/** Column letter of a zero-based column index: 0 → A, 26 → AA. */
export function columnLetter(index: number) {
  let n = index + 1, out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
const cellText = (cell: unknown) => cell === null || cell === undefined ? '' : String(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell).replace(/\s+/g, ' ').trim();

/**
 * One line per non-empty row: "[Лист!C5:E5] Код (C): A-1 | Цена (E): 42" — sheet, cell range, column letters and header names.
 * The header is the first row with at least two filled cells (rows above it, such as a title, are kept without header names).
 */
async function xlsxLines(input: Buffer) {
  const sheets = await readExcelFile(input, { trim: false });
  const lines: string[] = [];
  for (const sheet of sheets) {
    const rows = sheet.data.map(row => row.map(cellText));
    const filled = (row: string[]) => row.reduce((n, cell) => n + (cell ? 1 : 0), 0);
    let headerRow = rows.findIndex(row => filled(row) >= 2);
    if (headerRow < 0) headerRow = rows.findIndex(row => filled(row) > 0);
    lines.push(`# Лист: ${sheet.sheet} · строк ${rows.length}`);
    if (headerRow < 0) continue;
    const header = rows[headerRow];
    rows.forEach((row, index) => {
      const columns = row.map((cell, i) => cell ? i : -1).filter(i => i >= 0);
      if (!columns.length) return;
      const r = index + 1, first = columns[0], last = columns.at(-1)!;
      const range = `[${sheet.sheet}!${columnLetter(first)}${r}${last !== first ? ':' + columnLetter(last) + r : ''}]`;
      if (index === headerRow) { lines.push(`${range} Заголовки: ` + columns.map(i => `${row[i]} (${columnLetter(i)})`).join(' | ')); return; }
      const named = index > headerRow;
      lines.push(`${range} ` + columns.map(i => `${named && header[i] ? header[i] + ' (' + columnLetter(i) + ')' : columnLetter(i)}: ${row[i]}`).join(' | '));
    });
  }
  return lines.join('\n');
}

/** Heading level of paragraph styles: built-in "heading N" and "Title", or an outline level set in the style. */
function styleLevels(xml: string | undefined) {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  const parser = new Parser();
  let id: string | undefined;
  parser.on('openTag', (name, attrs, decode) => {
    if (name === 'w:style') { const a = attrs(); id = a['w:type'] === 'paragraph' && a['w:styleId'] ? decode(a['w:styleId']) : undefined; return; }
    if (!id) return;
    const val = attrs()['w:val'];
    if (val === undefined) return;
    if (name === 'w:name') {
      const styleName = decode(val).toLowerCase();
      const heading = /^heading\s*(\d)$/.exec(styleName);
      if (heading) levels.set(id, Number(heading[1])); else if (styleName === 'title') levels.set(id, 1);
    } else if (name === 'w:outlineLvl' && !levels.has(id) && Number(val) < 9) levels.set(id, Number(val) + 1);
  });
  parser.on('closeTag', name => { if (name === 'w:style') id = undefined; });
  parser.parse(xml);
  return levels;
}

type DocxTable = { rows: string[][]; row?: string[]; cell?: string[] };
/**
 * Headings ("#", "##", "###" — section markers used in citations), paragraphs and tables of the main document text. Tables give one line per
 * row: "[Таблица 2, строка 3] Параметр: Срок | Значение: 10 дней". Word has no stored pages, so none are invented.
 */
function docxLines(input: Uint8Array) {
  let unpacked = 0;
  const parts = unzipSync(input, { filter: file => {
    if (file.name !== 'word/document.xml' && file.name !== 'word/styles.xml') return false;
    unpacked += file.originalSize;
    if (unpacked > 256 * 1024 * 1024) throw new Error('DOCX text exceeds the extraction limit');
    return true;
  } });
  const documentXml = parts['word/document.xml'];
  if (!documentXml) throw new Error('word/document.xml is missing');
  const levels = styleLevels(parts['word/styles.xml'] ? strFromU8(parts['word/styles.xml']) : undefined);
  const out: string[] = [];
  const tables: DocxTable[] = [];
  let tableNumber = 0;
  let paragraph: { text: string; level?: number } | undefined;
  let runDepth = 0, inText = false;
  const emitTable = (table: DocxTable, number: number) => {
    const header = (table.rows[0] ?? []).map((cell, i) => cell || `Колонка ${i + 1}`);
    table.rows.forEach((row, index) => {
      if (!row.some(Boolean)) return;
      const label = `[Таблица ${number}, строка ${index + 1}] `;
      out.push(label + (index === 0 ? row.join(' | ') : row.map((cell, i) => cell ? `${header[i] ?? `Колонка ${i + 1}`}: ${cell}` : '').filter(Boolean).join(' | ')));
    });
  };
  const parser = new Parser();
  parser.on('openTag', (name, attrs, decode) => {
    switch (name) {
      case 'w:p': paragraph = { text: '' }; break;
      case 'w:r': runDepth++; break;
      case 'w:t': inText = runDepth > 0; break;
      case 'w:tab': case 'w:br': case 'w:cr': if (runDepth > 0 && paragraph) paragraph.text += name === 'w:tab' ? '\t' : ' '; break;
      case 'w:pStyle': { const val = attrs()['w:val']; if (paragraph && val !== undefined) paragraph.level = levels.get(decode(val)) ?? paragraph.level; break; }
      case 'w:outlineLvl': { const val = Number(attrs()['w:val']); if (paragraph && val < 9) paragraph.level = val + 1; break; }
      case 'w:tbl': tables.push({ rows: [] }); break;
      case 'w:tr': if (tables.length) tables.at(-1)!.row = []; break;
      case 'w:tc': if (tables.length) tables.at(-1)!.cell = []; break;
    }
  });
  parser.on('text', (value, decode) => { if (inText && paragraph) paragraph.text += decode(value); });
  parser.on('closeTag', name => {
    switch (name) {
      case 'w:t': inText = false; break;
      case 'w:r': runDepth = Math.max(0, runDepth - 1); break;
      case 'w:p': {
        const text = (paragraph?.text ?? '').replace(/\s+/g, ' ').trim();
        const table = tables.at(-1);
        if (text && table?.cell) table.cell.push(text);
        else if (text && !tables.length) out.push(paragraph?.level ? '#'.repeat(Math.min(3, paragraph.level)) + ' ' + text.slice(0, 200) : plain(text));
        paragraph = undefined; break;
      }
      case 'w:tc': { const table = tables.at(-1); if (table?.cell && table.row) table.row.push(table.cell.join(' ')); if (table) table.cell = undefined; break; }
      case 'w:tr': { const table = tables.at(-1); if (table?.row) table.rows.push(table.row); if (table) table.row = undefined; break; }
      case 'w:tbl': {
        const table = tables.pop()!;
        const outer = tables.at(-1);
        // A table inside a cell becomes text of that cell.
        if (outer?.cell) outer.cell.push(table.rows.map(row => row.filter(Boolean).join(' | ')).filter(Boolean).join('; '));
        else emitTable(table, ++tableNumber);
        break;
      }
    }
  });
  parser.on('error', error => { throw error ?? new Error('Invalid DOCX XML'); });
  parser.parse(strFromU8(documentXml));
  return out.join('\n');
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
        if (item.hasEOL) { out.push(plain(line)); line = ''; } else line += ' ';
      }
      if (line.trim()) out.push(plain(line));
    }
    return out.join('\n');
  } finally { await task.destroy(); }
}
const { kind, input } = workerData as { kind: 'pdf' | 'xlsx' | 'docx'; input: Uint8Array };
const text = kind === 'pdf' ? await pdfLines(input) : kind === 'docx' ? docxLines(input) : await xlsxLines(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
parentPort!.postMessage(text);
