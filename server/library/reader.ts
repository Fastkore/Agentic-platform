import { createInterface } from 'node:readline';
import { toolLimits } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { contentKey, type LibraryFile, type LibraryRegistry } from './registry.js';

/** A content state of one folder the caller is already authorized to read; `allow` limits a grant to listed paths. */
export interface SearchTarget { stateId: string; folderId: string; allow?: ReadonlySet<string> }
export interface SearchHit { folderId: string; fileId: string; path: string; line?: number; section?: string; text: string }
const maxLineChars = 2000;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** Trigrams of one term, all required: the candidate condition for the position-less trigram index. Candidates are verified line by line. */
function termQuery(term: string) {
  const chars = [...term.toLocaleLowerCase()];
  const grams = [...new Set(Array.from({ length: Math.max(0, chars.length - 2) }, (_, i) => chars.slice(i, i + 3).join('')))];
  // Very long terms: a bounded, evenly spread subset keeps the query cheap.
  const step = Math.max(1, Math.ceil(grams.length / 24));
  return grams.filter((_, i) => i % step === 0).map(quote).join(' AND ');
}
/** exact: the whole query; fulltext: any of the words (each word's trigrams together). */
function candidateQuery(terms: string[]) {
  return terms.length === 1 ? termQuery(terms[0]) : terms.map(t => '(' + termQuery(t) + ')').join(' OR ');
}
/** Chunks read per folder and matching lines considered per search; beyond that the result is marked limited. */
const chunkLimit = 2000, candidateLimit = 5000;
/** Read side of the library index. Callers pass content states already authorized for the current scope. */
export class LibraryReader {
  constructor(private readonly registry: LibraryRegistry) {
    this.db.function('library_casefold', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase());
  }
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
    // CSV rows are cited by line; the header row is returned with every read that does not start at it, so columns can be named.
    const header = file.language === 'csv' && lines.length && lines[0].n > 1 ? await this.firstLine(blob.object_key, signal) : undefined;
    return { file, startLine: start, lines, totalLines: total, nextLine: total === undefined || last < total ? last + 1 : undefined, truncated, bytes,
      section: lines.length && file.text_blob_id ? this.section(file, lines[0].n) : undefined, header };
  }
  private async firstLine(key: string, signal?: AbortSignal) {
    const stream = await this.registry.storage.store!.stream(key, signal, 0);
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const raw of reader) return raw.replace(/^\uFEFF/, '').slice(0, maxLineChars); }
    finally { reader.close(); stream.destroy(); }
    return undefined;
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
      return { hits, next: more ? offset + hits.length : undefined, limited: undefined as true | undefined, filesMatched: undefined as number | undefined };
    }
    const terms = mode === 'fulltext' ? [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 8) : [q];
    const longTerms = terms.filter(t => [...t].length >= 3);
    const fold = (value: string) => options.caseSensitive ? value : value.toLocaleLowerCase();
    const needles = terms.map(fold);
    /** Number of query words in the line; 0 — no match. */
    const score = (line: string) => { const hay = fold(line); return needles.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0); };
    type Candidate = SearchHit & { score: number; order: number; round: number; sha256: string; size: number; derived: boolean };
    const found: Candidate[] = [];
    let limited = false;
    collect: for (const target of targets) {
      if (target.allow?.size === 0) continue;
      const params: (string | number)[] = [];
      const columns = 'f.file_id, f.path, f.sha256, f.size, x.text_blob_id, c.start_line, c.text';
      const contents = 'JOIN contents x ON x.sha256=f.sha256 AND x.size=f.size';
      // Search the FTS index once, then match its results to paths in this folder.
      let sql: string;
      if (longTerms.length === terms.length) {
        sql = `SELECT ${columns} FROM chunks c CROSS JOIN state_files f ON f.content=c.content AND f.state_id=? ${contents} WHERE chunks MATCH ?`;
        params.push(target.stateId, candidateQuery(longTerms));
      } else {
        const text = options.caseSensitive ? 'c.text' : 'library_casefold(c.text)';
        sql = `SELECT ${columns} FROM state_files f JOIN chunk_refs r ON r.content=f.content
          CROSS JOIN chunks c ON c.rowid=r.chunk_rowid ${contents}
          WHERE f.state_id=? AND (${needles.map(() => `instr(${text}, ?)>0`).join(' OR ')})`;
        params.push(target.stateId, ...needles);
      }
      if (prefix) { sql += ' AND f.path >= ? AND f.path < ?'; params.push(prefix, prefix + '\uffff'); }
      if (target.allow) { sql += ' AND f.path IN (SELECT value FROM json_each(?))'; params.push(JSON.stringify([...target.allow])); }
      sql += ` ORDER BY f.path, c.start_line LIMIT ${chunkLimit + 1}`;
      const rows = this.db.prepare(sql).all(...params) as { file_id: string; path: string; sha256: string; size: number; text_blob_id: string | null; start_line: number; text: string }[];
      if (rows.length > chunkLimit) { rows.pop(); limited = true; }
      for (const row of rows) {
        const lines = row.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const s = mode === 'exact' ? (fold(lines[i]).includes(needles[0]) ? 1 : 0) : score(lines[i]);
          if (!s) continue;
          found.push({ folderId: target.folderId, fileId: row.file_id, path: row.path, line: row.start_line + i, text: lines[i].trim().slice(0, 300),
            score: s, order: found.length, round: 0, sha256: row.sha256, size: row.size, derived: !!row.text_blob_id });
          if (found.length >= candidateLimit) { limited = true; break collect; }
        }
      }
    }
    // At each relevance level, first show one line from each file.
    found.sort((a, b) => b.score - a.score || a.order - b.order);
    const seen = new Map<string, number>();
    for (const hit of found) {
      const key = hit.score + '\0' + hit.folderId + '\0' + hit.fileId;
      const n = seen.get(key) ?? 0; seen.set(key, n + 1);
      hit.round = n;
    }
    found.sort((a, b) => b.score - a.score || a.round - b.round || a.order - b.order);
    const page: SearchHit[] = found.slice(offset, offset + limit).map(h => ({ folderId: h.folderId, fileId: h.fileId, path: h.path, line: h.line, text: h.text,
      section: h.derived ? this.section(h, h.line!) : undefined }));
    const filesMatched = new Set(found.map(h => h.folderId + '\0' + h.fileId)).size;
    return { hits: page, next: offset + limit < found.length ? offset + page.length : undefined, limited: limited || undefined, filesMatched };
  }
}
