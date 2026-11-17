import { createInterface } from 'node:readline';
import { toolLimits } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { contentKey, processorVersion, type LibraryFile, type LibraryRegistry } from './registry.js';

/** A content state of one folder the caller is already authorized to read; `allow` limits a grant to listed paths. */
export interface SearchTarget { stateId: string; folderId: string; allow?: ReadonlySet<string> }
export interface SearchHit { folderId: string; fileId: string; path: string; line?: number; section?: string; text: string }
const maxLineChars = 2000;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** Candidate query for the position-less trigram index: every trigram of every term must occur in the chunk. */
function trigramQuery(terms: string[]) {
  const grams = new Set<string>();
  for (const term of terms) {
    const chars = [...term.toLocaleLowerCase()];
    for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(''));
  }
  // Very long queries: a bounded, evenly spread subset keeps the query cheap; candidates are verified anyway.
  const list = [...grams];
  const step = Math.max(1, Math.ceil(list.length / 24));
  return list.filter((_, i) => i % step === 0).map(quote).join(' AND ');
}

/** Read side of the library index. Callers pass content states already authorized for the current scope. */
export class LibraryReader {
  constructor(private readonly registry: LibraryRegistry) {}
  private get db() { return this.registry.db; }
  file(stateId: string, fileId: string) {
    const row = this.registry.file(stateId, fileId);
    if (!row) throw new BridgeError('Файл не найден в папке.', 404);
    return row;
  }
  fileByPath(stateId: string, path: string) { return this.registry.fileByPath(stateId, path); }
  /** Section (page, sheet, heading) of an extracted document at the given line. */
  section(file: Pick<LibraryFile, 'sha256' | 'size'>, line: number) {
    const row = this.db.prepare('SELECT label FROM sections WHERE content=? AND line<=? ORDER BY line DESC LIMIT 1').get(contentKey(file.sha256, file.size), line) as { label: string } | undefined;
    return row?.label;
  }
  /** Reads a line range from the stored text (original UTF-8 or extracted text), starting near the requested line. */
  async readLines(stateId: string, fileId: string, startLine: number, lineCount: number, signal?: AbortSignal) {
    const file = this.file(stateId, fileId);
    if (!['indexed', 'limited'].includes(file.extraction_state)) throw new BridgeError('Файл не доступен для чтения как текст: ' + (file.extraction_note ?? file.extraction_state) + '.', 422);
    const count = Math.min(Math.max(1, lineCount), toolLimits.readLines);
    const start = Math.max(1, startLine);
    const anchor = this.db.prepare('SELECT line, offset FROM line_index WHERE content=? AND line<=? ORDER BY line DESC LIMIT 1')
      .get(contentKey(file.sha256, file.size), start) as { line: number; offset: number } | undefined;
    const blobId = file.text_blob_id ?? file.blob_id;
    const blob = this.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(blobId) as { object_key: string } | undefined;
    const store = this.registry.storage.store;
    if (!blob || !store) throw new BridgeError('Хранилище библиотеки недоступно.', 503);
    const stream = await store.stream(blob.object_key, signal, anchor?.offset ?? 0);
    const lines: { n: number; text: string }[] = [];
    let n = (anchor?.line ?? 1) - 1, bytes = 0, truncated = false;
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const raw of reader) {
        n++;
        if (n < start) continue;
        let text = n === 1 ? raw.replace(/^﻿/, '') : raw;
        if (text.length > maxLineChars) { text = text.slice(0, maxLineChars) + ' …[строка сокращена]'; truncated = true; }
        bytes += Buffer.byteLength(text) + 16;
        if (bytes > toolLimits.responseBytes - 2048) { truncated = true; break; }
        lines.push({ n, text });
        if (lines.length >= count) break;
      }
    } finally { reader.close(); stream.destroy(); }
    const last = lines.at(-1)?.n ?? start - 1;
    const total = file.line_count ?? undefined;
    return { file, startLine: start, lines, totalLines: total, nextLine: total === undefined || last < total ? last + 1 : undefined, truncated, bytes,
      section: lines.length && file.text_blob_id ? this.section(file, lines[0].n) : undefined };
  }
  /**
   * exact — substring (identifiers, error texts); fulltext — any of the words; files — file names and paths.
   * Search runs over the server index of each folder's current content; nothing is downloaded from storage.
   */
  search(targets: SearchTarget[], query: string, options: { mode?: 'exact' | 'fulltext' | 'files'; pathPrefix?: string; caseSensitive?: boolean; offset?: number; limit?: number } = {}) {
    const q = query.trim();
    if (!q || q.length > 300) throw new BridgeError('Укажите запрос до 300 символов.');
    const limit = Math.min(options.limit ?? toolLimits.searchMatches, toolLimits.searchMatches), offset = Math.max(0, options.offset ?? 0);
    const mode = options.mode ?? 'exact';
    const prefix = options.pathPrefix ? options.pathPrefix.replace(/\/?$/, '/') : undefined;
    const hits: SearchHit[] = [];
    let skipped = 0, more = false;
    if (mode === 'files') {
      for (const target of targets) {
        // Names are compared in JavaScript: SQLite lower() folds only ASCII, and file names are often Cyrillic.
        const needle = options.caseSensitive ? q : q.toLocaleLowerCase();
        const rows = this.db.prepare(`SELECT file_id, path FROM state_files WHERE state_id=? ${prefix ? 'AND path >= ? AND path < ?' : ''} ORDER BY path`)
          .all(target.stateId, ...(prefix ? [prefix, prefix + '￿'] : [])) as { file_id: string; path: string }[];
        for (const row of rows) {
          if (!(options.caseSensitive ? row.path : row.path.toLocaleLowerCase()).includes(needle)) continue;
          if (target.allow && !target.allow.has(row.path)) continue;
          if (skipped < offset) { skipped++; continue; }
          if (hits.length >= limit) { more = true; break; }
          hits.push({ folderId: target.folderId, fileId: row.file_id, path: row.path, text: row.path });
        }
        if (more) break;
      }
      return { hits, next: more ? offset + hits.length : undefined };
    }
    const terms = mode === 'fulltext' ? q.split(/\s+/).filter(Boolean).slice(0, 8) : [q];
    const longTerms = terms.filter(t => [...t].length >= 3);
    const lineMatches = (line: string) => {
      const hay = options.caseSensitive ? line : line.toLocaleLowerCase();
      return mode === 'exact' ? hay.includes(options.caseSensitive ? q : q.toLocaleLowerCase()) : terms.some(t => hay.includes(options.caseSensitive ? t : t.toLocaleLowerCase()));
    };
    for (const target of targets) {
      const params: (string | number)[] = [];
      // Search the FTS index once, then match its results to paths in this folder.
      const files = `CROSS JOIN state_files f ON f.content = c.content AND f.state_id=? JOIN contents x ON x.sha256=f.sha256 AND x.size=f.size AND x.processor=${processorVersion}`;
      let sql: string;
      if (longTerms.length) {
        sql = `SELECT f.file_id, f.path, f.sha256, f.size, x.text_blob_id, c.start_line, c.text FROM chunks c ${files}
          WHERE chunks MATCH ? ${prefix ? 'AND f.path >= ? AND f.path < ?' : ''} ORDER BY f.path, c.start_line LIMIT 2000`;
        params.push(target.stateId, trigramQuery(mode === 'exact' ? [q] : longTerms));
      } else {
        sql = `SELECT f.file_id, f.path, f.sha256, f.size, x.text_blob_id, c.start_line, c.text FROM chunks c ${files}
          WHERE instr(lower(c.text), lower(?))>0 ${prefix ? 'AND f.path >= ? AND f.path < ?' : ''} ORDER BY f.path, c.start_line LIMIT 2000`;
        params.push(target.stateId, terms[0]);
      }
      if (prefix) params.push(prefix, prefix + '￿');
      const rows = this.db.prepare(sql).all(...params) as { file_id: string; path: string; sha256: string; size: number; text_blob_id: string | null; start_line: number; text: string }[];
      for (const row of rows) {
        if (target.allow && !target.allow.has(row.path)) continue;
        const lines = row.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lineMatches(lines[i])) continue;
          if (skipped < offset) { skipped++; continue; }
          if (hits.length >= limit) { more = true; break; }
          const line = row.start_line + i;
          hits.push({ folderId: target.folderId, fileId: row.file_id, path: row.path, line, text: lines[i].trim().slice(0, 300),
            section: row.text_blob_id ? this.section(row, line) : undefined });
        }
        if (more) break;
      }
      if (more) break;
    }
    return { hits, next: more ? offset + hits.length : undefined };
  }
}
