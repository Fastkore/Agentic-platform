import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { KnowledgeFile, KnowledgeOverview, KnowledgeSection } from '../shared/knowledge.js';
import { attachmentName, documentText, supportsDocumentText } from './documents.js';
import { maxUploadBytes } from './file-storage.js';
import { BridgeError } from './store.js';

type MetadataRow = Omit<KnowledgeFile, 'editable'> & { editable: number };
type DocumentRow = MetadataRow & { content: Uint8Array };
const metadataColumns = 'id, section, name, size, revision, updatedAt, editable, extraction';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const textFile = (name: string) => /\.(md|txt|json|xml|log|csv|tsv)$/i.test(name);
const defaultSummary = 'Fastkore — платформа корпоративных приложений. Business — конфигурация заказов, смет, склада, производства, документов и платежей. Вводная 00-Fastkore-for-Agent-Platform.md описывает сеанс сотрудника и контекст окна. Руководство Platform описывает схему, связи и разработку. Руководство CLI описывает команды. Руководство Business описывает предметные процессы. Доступные операции определяются инструментами текущего сеанса, схема и состояния объектов — целевой установкой.';

export class KnowledgeBase {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    const file = path.join(root, 'knowledge.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, summary TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, section TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, revision TEXT NOT NULL, updatedAt TEXT NOT NULL, editable INTEGER NOT NULL,
        extraction TEXT NOT NULL, content BLOB NOT NULL, UNIQUE(section, name));
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(documentId UNINDEXED, part UNINDEXED, title, text);`);
    // The seed marker and documents commit together. Local edits survive package upgrades.
    if (!this.db.prepare('SELECT id FROM sections WHERE id = ?').get('fastkore')) {
      const source = new URL('../knowledge/fastkore/', import.meta.url);
      const bundled = existsSync(source) ? source : new URL('../../knowledge/fastkore/', import.meta.url);
      const files = readdirSync(bundled).filter(name => name.endsWith('.md')).sort();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO sections VALUES (?, ?, ?)').run('fastkore', defaultSummary, randomUUID());
        this.db.prepare('INSERT INTO sections VALUES (?, ?, ?)').run('company', '', randomUUID());
        for (const name of files) {
          const content = readFileSync(path.join(fileURLToPath(bundled), name));
          this.write('fastkore', name, content, content.toString('utf8'), 'full');
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    }
  }
  private row(section: KnowledgeSection, id: string): DocumentRow {
    const row = this.db.prepare('SELECT * FROM documents WHERE section = ? AND id = ?').get(section, id) as DocumentRow | undefined;
    if (!row) throw new BridgeError('Документ базы знаний не найден.', 404);
    return row;
  }
  private metadata(row: MetadataRow): KnowledgeFile {
    const { id, section, name, size, revision, updatedAt, editable, extraction } = row;
    return { id, section, name, size, revision, updatedAt, editable: !!editable, extraction };
  }
  overview(section: KnowledgeSection): KnowledgeOverview {
    const config = this.db.prepare('SELECT summary, revision FROM sections WHERE id = ?').get(section) as { summary: string; revision: string };
    const files = this.db.prepare('SELECT ' + metadataColumns + ' FROM documents WHERE section = ? ORDER BY name').all(section) as MetadataRow[];
    return { ...config, files: files.map(row => this.metadata(row)) };
  }
  get(section: KnowledgeSection, id: string) {
    const row = this.row(section, id);
    return { file: this.metadata(row), content: Buffer.from(row.content) };
  }
  private checkRevision(actual: string, expected: string) {
    if (actual !== expected) throw new BridgeError('Документ уже обновлён. Скачайте свою версию и откройте актуальную перед сохранением.', 409);
  }
  summary(section: KnowledgeSection, summary: string, revision: string) {
    const current = this.overview(section);
    this.checkRevision(current.revision, revision);
    this.db.prepare('UPDATE sections SET summary = ?, revision = ? WHERE id = ?').run(summary, randomUUID(), section);
    return this.overview(section);
  }
  private write(section: KnowledgeSection, name: string, content: Buffer, text: string, extraction: KnowledgeFile['extraction'], id: string = randomUUID()) {
    const file: KnowledgeFile = { id, section, name, size: content.length, revision: randomUUID(),
      updatedAt: new Date().toISOString(), editable: textFile(name), extraction };
    this.db.prepare('INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, section, name, content.length, file.revision, file.updatedAt, Number(file.editable), extraction, content);
    this.db.prepare('DELETE FROM chunks WHERE documentId = ?').run(id);
    const insert = this.db.prepare('INSERT INTO chunks(documentId, part, title, text) VALUES (?, ?, ?, ?)');
    let part = 0;
    for (const sectionText of text.split(/\n(?=#{1,6} )/)) {
      const title = sectionText.match(/^#{1,6} (.+)/)?.[1]?.slice(0, 180) ?? name;
      for (let offset = 0; offset < sectionText.length; offset += 4000) insert.run(id, part++, title, sectionText.slice(offset, offset + 4000));
    }
    this.db.prepare('UPDATE sections SET revision = ? WHERE id = ?').run(randomUUID(), section);
    return file;
  }
  async upload(section: KnowledgeSection, name: string, content: Buffer, authorize: () => void, replacement?: { id: string; revision: string }) {
    authorize();
    if (content.length > maxUploadBytes) throw new BridgeError('Максимальный размер файла — 20 МБ.', 413);
    name = attachmentName(name);
    if (replacement) {
      const current = this.row(section, replacement.id);
      this.checkRevision(current.revision, replacement.revision);
      if (current.name === name && Buffer.from(current.content).equals(content)) return this.metadata(current);
    }
    let text = '', extraction: KnowledgeFile['extraction'] = 'unavailable';
    if (textFile(name)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { throw new BridgeError('Сохраните текстовый файл в UTF-8.'); }
      extraction = 'full';
    } else if (supportsDocumentText(name)) {
      try { text = await documentText(name, content); extraction = 'excerpt'; }
      catch { /* Keep the original downloadable even when extraction is unavailable. */ }
    }
    authorize();
    if (replacement) this.checkRevision(this.row(section, replacement.id).revision, replacement.revision);
    const duplicate = this.db.prepare('SELECT id FROM documents WHERE section = ? AND name = ?').get(section, name) as { id: string } | undefined;
    if (duplicate && duplicate.id !== replacement?.id) throw new BridgeError('Файл с таким именем уже есть. Используйте «Заменить».', 409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const file = this.write(section, name, content, text, extraction, replacement?.id);
      this.db.exec('COMMIT');
      return file;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  remove(section: KnowledgeSection, id: string, revision: string) {
    this.checkRevision(this.row(section, id).revision, revision);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM chunks WHERE documentId = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db.prepare('UPDATE sections SET revision = ? WHERE id = ?').run(randomUUID(), section);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  index(section: KnowledgeSection, id?: string, offset = 0) {
    if (id) {
      const file = this.metadata(this.row(section, id));
      const rows = this.db.prepare('SELECT part, title FROM chunks WHERE documentId = ? ORDER BY CAST(part AS INTEGER) LIMIT 41 OFFSET ?').all(id, offset);
      return { file, parts: rows.slice(0, 40), nextOffset: rows.length > 40 ? offset + 40 : null };
    }
    const overview = this.overview(section);
    return { summary: overview.summary, revision: overview.revision, files: overview.files.slice(offset, offset + 40),
      nextOffset: overview.files.length > offset + 40 ? offset + 40 : null };
  }
  search(section: KnowledgeSection, query: string) {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!words.length) return [];
    return this.db.prepare(`SELECT d.id, d.name, d.revision, d.extraction, chunks.part, chunks.title,
      snippet(chunks, 3, '', '', ' … ', 45) AS excerpt FROM chunks JOIN documents d ON d.id = chunks.documentId
      WHERE chunks MATCH ? AND d.section = ? ORDER BY rank LIMIT 5`).all(words.map(word => '"' + word + '"*').join(' OR '), section);
  }
  read(section: KnowledgeSection, id: string, revision: string, part: number) {
    const file = this.metadata(this.row(section, id));
    this.checkRevision(file.revision, revision);
    const row = this.db.prepare('SELECT title, text FROM chunks WHERE documentId = ? AND part = ?').get(id, part);
    if (!row) throw new BridgeError('Фрагмент недоступен. Проверьте оглавление и поддержку формата.', 404);
    const next = this.db.prepare('SELECT part FROM chunks WHERE documentId = ? AND part = ?').get(id, part + 1);
    return { file, part, ...row, nextPart: next ? part + 1 : null };
  }
  context() {
    const sections = (['fastkore', 'company'] as const).map(section => {
      const { summary, revision, files } = this.overview(section);
      return { section, summary, revision, files: files.slice(0, 12).map(({ id, name, revision }) => ({ id, name, revision })), totalFiles: files.length };
    });
    return { revision: digest(JSON.stringify(sections)), text: JSON.stringify(sections) };
  }
  close() { this.db.close(); }
}
