import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { LibraryIndexer } from '../server/library/indexer.js';
import { inspectPublicationFile } from '../server/library/publication-file.js';
import { LibraryReader } from '../server/library/reader.js';
import { admin, current, libraryFixture, upload } from './library-helpers.js';

const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` : ''}${run(text)}</w:p>`;
const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`;

/** A Word document: localized heading style ids, a table with a nested table, a tab and entities in text. */
export function docx() {
  const body = [
    para('Регламент планирования', 'a3'),
    para('Общие положения', '1'),
    para('Планировщик учитывает график работы &amp; перерывы.'),
    `<w:p>${run('Колонки')}<w:r><w:tab/></w:r>${run('через табуляцию')}</w:p>`,
    para('# не заголовок, а текст'),
    para('Сроки', '2'),
    `<w:tbl><w:tr>${cell('Параметр')}${cell('Значение')}</w:tr><w:tr>${cell('Срок поставки')}${cell('10 рабочих дней')}</w:tr>`
      + `<w:tr>${cell('Вложенная')}<w:tc><w:tbl><w:tr>${cell('a')}${cell('b')}</w:tr></w:tbl></w:tc></w:tr></w:tbl>`,
    para('После таблицы'),
  ].join('');
  const styles = `${xmlHead}<w:styles ${w}><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style></w:styles>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    'word/document.xml': strToU8(`${xmlHead}<w:document ${w}><w:body>${body}</w:body></w:document>`),
    'word/styles.xml': strToU8(styles),
  }));
}

/** A workbook whose data starts at C3 with a title in A1 and a gap row. */
export function xlsx() {
  const s = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const sheet = `${xmlHead}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + `<row r="1">${s('A1', 'Прайс-лист')}</row><row r="3">${s('C3', 'Код')}${s('D3', 'Цена')}</row>`
    + `<row r="5">${s('C5', 'A-1')}<c r="E5"><v>42</v></c></row><row r="6">${s('C6', 'B-2')}<c r="D6"><v>1500</v></c></row></sheetData></worksheet>`;
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': strToU8(`${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`${xmlHead}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="Цены" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  }));
}

test('publication inspects the full Office container and preserves readable documents', async () => {
  const signal = AbortSignal.timeout(10000);
  for (const [name, data, expected] of [['quote.docx', docx(), 'После таблицы'], ['price.xlsx', xlsx(), '1500']] as const) {
    const checked = await inspectPublicationFile(name, data, signal);
    assert.ok(checked.text.includes(expected));
    assert.ok((await inspectPublicationFile(name, checked.contents, signal)).text.includes(expected));
  }
  const csv = Buffer.from('Reference,Cost\n'.repeat(1200) + 'Final row,12345');
  assert.match((await inspectPublicationFile('table.csv', csv, signal)).text, /Final row,12345$/);
  await assert.rejects(inspectPublicationFile('package.zip', docx(), signal));
});

test('DOCX: headings become sections, paragraphs and table rows are lines with table and row numbers; no pages are invented', async () => {
  const f = await libraryFixture({ limits: { partBytes: 8 * 1024 * 1024 } });
  const folder = f.registry.createFolder(admin, { name: 'Документы', profile: 'documents' });
  await upload(f, folder.id, { 'Регламент.docx': docx() });
  const state = current(f.registry, folder.id);
  const reader = new LibraryReader(f.registry);
  const file = reader.fileByPath(state.id, 'Регламент.docx')!;
  assert.equal(file.extraction_state, 'indexed');
  const read = await reader.readLines(state.id, file.file_id, 1, 50);
  assert.deepEqual(read.lines.map(l => l.text), [
    '# Регламент планирования',
    '# Общие положения',
    'Планировщик учитывает график работы & перерывы.',
    'Колонки\tчерез табуляцию'.replace('\t', ' '),
    '\\# не заголовок, а текст',
    '## Сроки',
    '[Таблица 1, строка 1] Параметр | Значение',
    '[Таблица 1, строка 2] Параметр: Срок поставки | Значение: 10 рабочих дней',
    '[Таблица 1, строка 3] Параметр: Вложенная | Значение: a | b',
    'После таблицы',
  ]);
  const hit = reader.search([{ stateId: state.id, folderId: folder.id }], '10 рабочих дней').hits[0];
  assert.deepEqual([hit.line, hit.section], [8, 'Сроки'], 'a table row is cited under its heading');
  assert.equal((await reader.readLines(state.id, file.file_id, 3, 1)).section, 'Общие положения');
  assert.ok(!read.lines.some(l => /Страница/.test(l.text)));
});

test('XLSX: each row is cited with sheet, cell range, column letters and header names; the header is found below a title', async () => {
  const f = await libraryFixture({ limits: { partBytes: 8 * 1024 * 1024 } });
  const folder = f.registry.createFolder(admin, { name: 'Таблицы', profile: 'documents' });
  await upload(f, folder.id, { 'Прайс.xlsx': xlsx(), 'Остатки.csv': 'Код;Склад;Остаток\nA-1;Север;10\nB-2;Юг;0\n' });
  const state = current(f.registry, folder.id);
  const reader = new LibraryReader(f.registry);
  const file = reader.fileByPath(state.id, 'Прайс.xlsx')!;
  const read = await reader.readLines(state.id, file.file_id, 1, 20);
  assert.deepEqual(read.lines.map(l => l.text), [
    '# Лист: Цены · строк 6',
    '[Цены!A1] A: Прайс-лист',
    '[Цены!C3:D3] Заголовки: Код (C) | Цена (D)',
    '[Цены!C5:E5] Код (C): A-1 | E: 42',
    '[Цены!C6:D6] Код (C): B-2 | Цена (D): 1500',
  ]);
  const hit = reader.search([{ stateId: state.id, folderId: folder.id }], '1500').hits[0];
  assert.deepEqual([hit.path, hit.section], ['Прайс.xlsx', 'Лист: Цены']);
  assert.match(hit.text, /^\[Цены!C6:D6\]/);
  // CSV keeps its rows as lines; a read that starts below the header also returns the header row.
  const csv = reader.fileByPath(state.id, 'Остатки.csv')!;
  const rows = await reader.readLines(state.id, csv.file_id, 3, 1);
  assert.deepEqual([rows.lines[0].n, rows.lines[0].text, rows.header], [3, 'B-2;Юг;0', 'Код;Склад;Остаток']);
  assert.equal((await reader.readLines(state.id, csv.file_id, 1, 1)).header, undefined);
});

test('documents processed by an older version are brought up to date in place: the folder keeps its content and gains the new extraction', async () => {
  const f = await libraryFixture({ limits: { partBytes: 8 * 1024 * 1024 } });
  const folder = f.registry.createFolder(admin, { name: 'Старые', profile: 'documents' });
  await upload(f, folder.id, { 'Регламент.docx': docx(), 'Прайс.xlsx': xlsx(), 'readme.md': '# Привет\n' });
  const state = current(f.registry, folder.id);
  // As left by version 1: DOCX unsupported, XLSX extracted without cell references.
  f.registry.tx(() => {
    for (const path of ['Регламент.docx', 'Прайс.xlsx']) {
      const row = f.registry.db.prepare('SELECT content FROM state_files WHERE state_id=? AND path=?').get(state.id, path) as { content: string };
      f.registry.db.prepare('UPDATE contents SET processor=1 WHERE sha256 || \':\' || size = ?').run(row.content);
      if (path.endsWith('.docx')) {
        f.registry.deleteContentIndex(row.content);
        f.registry.db.prepare("UPDATE contents SET state='unsupported_format', text_blob_id=NULL, line_count=NULL WHERE sha256 || ':' || size = ?").run(row.content);
      }
    }
    f.registry.db.prepare('UPDATE states SET indexed_files=2, unsupported_files=1 WHERE id=?').run(state.id);
  });
  const processedAt = () => (f.registry.db.prepare("SELECT c.processed_at t FROM contents c JOIN state_files s ON s.content = c.sha256 || ':' || c.size WHERE s.path='readme.md'").get() as { t: number }).t;
  const textProcessed = processedAt();
  const reader = new LibraryReader(f.registry);
  assert.equal(reader.fileByPath(state.id, 'Регламент.docx')!.extraction_state, 'unsupported_format');
  assert.equal(reader.search([{ stateId: state.id, folderId: folder.id }], 'Прайс-лист').hits.length, 1, 'old results stay readable until upgraded');
  const indexer = new LibraryIndexer(f.registry, { workerId: 'upgrade' });
  try { await indexer.drain(); } finally { await indexer.stop(); }
  assert.equal(current(f.registry, folder.id).id, state.id, 'no new content is published');
  assert.equal(reader.fileByPath(state.id, 'Регламент.docx')!.extraction_state, 'indexed');
  assert.equal(reader.search([{ stateId: state.id, folderId: folder.id }], 'Срок поставки').hits[0].section, 'Сроки');
  assert.match(reader.search([{ stateId: state.id, folderId: folder.id }], 'Прайс-лист').hits[0].text, /^\[Цены!A1\]/);
  assert.equal(f.registry.getFolder(admin, folder.id).current!.indexed, 3, 'coverage is recounted');
  assert.equal(processedAt(), textProcessed, 'text files are not processed again');
});
