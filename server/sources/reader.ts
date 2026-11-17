import { createInterface } from 'node:readline';
import { toolLimits } from '../../shared/sources.js';
import { BridgeError } from '../store.js';
import type { SnapshotFileRow, SourceRegistry } from './registry.js';

export interface SearchTarget { snapshotId: string; generation: number; bindingId?: string }
export interface SearchHit { snapshotId: string; fileId: string; path: string; line: number; text: string; bindingId?: string }
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

/** Read-side of the source index. Callers must pass snapshots already authorized for the current scope. */
export class SourceReader {
  constructor(private readonly registry: SourceRegistry) {}
  private get db() { return this.registry.db; }
  file(snapshotId: string, fileId: string) {
    const row = this.registry.snapshotFile(snapshotId, fileId);
    if (!row) throw new BridgeError('Файл не найден в выбранном снимке.', 404);
    return row;
  }
  fileByPath(snapshotId: string, path: string) {
    return this.db.prepare('SELECT * FROM snapshot_files WHERE snapshot_id=? AND path=?').get(snapshotId, path) as SnapshotFileRow | undefined;
  }
  /** Reads a line range from the stored text (original UTF-8 or derived text), starting near the requested line. */
  async readLines(snapshotId: string, fileId: string, startLine: number, lineCount: number, signal?: AbortSignal) {
    const file = this.file(snapshotId, fileId);
    if (!['indexed', 'limited'].includes(file.extraction_state)) throw new BridgeError('Файл не доступен для чтения как текст: ' + (file.extraction_note ?? file.extraction_state) + '.', 422);
    const count = Math.min(Math.max(1, lineCount), toolLimits.readLines);
    const start = Math.max(1, startLine);
    const snapshot = this.registry.snapshotRow(snapshotId)!;
    const anchor = this.db.prepare('SELECT line, offset FROM line_index WHERE snapshot_id=? AND generation=? AND file_id=? AND line<=? ORDER BY line DESC LIMIT 1')
      .get(snapshotId, snapshot.index_generation, fileId, start) as { line: number; offset: number } | undefined;
    const blobId = file.text_blob_id ?? file.blob_id;
    const blob = this.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(blobId) as { object_key: string } | undefined;
    const store = this.registry.storage.store;
    if (!blob || !store) throw new BridgeError('Хранилище источников недоступно.', 503);
    const stream = await store.stream(blob.object_key, signal, anchor?.offset ?? 0);
    const lines: { n: number; text: string }[] = [];
    let n = (anchor?.line ?? 1) - 1, bytes = 0, truncated = false;
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const raw of reader) {
        n++;
        if (n === 1 && raw.charCodeAt(0) === 0xfeff) { /* BOM */ }
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
    return { path: file.path, startLine: start, lines, totalLines: total, nextLine: total === undefined || last < total ? last + 1 : undefined, truncated, bytes };
  }
  /** Exact (substring) or full-text (all terms) search over the active index generation of each snapshot. */
  search(targets: SearchTarget[], query: string, options: { mode?: 'exact' | 'fulltext'; pathPrefix?: string; caseSensitive?: boolean; offset?: number; limit?: number } = {}) {
    const q = query.trim();
    if (!q || q.length > 300) throw new BridgeError('Укажите запрос до 300 символов.');
    const limit = Math.min(options.limit ?? toolLimits.searchMatches, toolLimits.searchMatches), offset = Math.max(0, options.offset ?? 0);
    const mode = options.mode ?? 'exact';
    const terms = mode === 'fulltext' ? q.split(/\s+/).filter(Boolean).slice(0, 8) : [q];
    const longTerms = terms.filter(t => [...t].length >= 3);
    const lineMatches = (line: string) => {
      const hay = options.caseSensitive ? line : line.toLocaleLowerCase();
      return mode === 'exact' ? hay.includes(options.caseSensitive ? q : q.toLocaleLowerCase()) : terms.some(t => hay.includes(options.caseSensitive ? t : t.toLocaleLowerCase()));
    };
    const hits: SearchHit[] = [];
    let skipped = 0, more = false;
    const prefix = options.pathPrefix ? options.pathPrefix.replace(/\/?$/, '/') : undefined;
    for (const target of targets) {
      const params: (string | number)[] = [];
      let sql: string;
      if (longTerms.length) {
        const match = trigramQuery(mode === 'exact' ? [q] : longTerms);
        sql = `SELECT c.file_id, c.start_line, c.text, f.path FROM chunks c JOIN snapshot_files f ON f.snapshot_id=c.snapshot_id AND f.file_id=c.file_id
          WHERE chunks MATCH ? AND c.snapshot_id=? AND c.generation=? ${prefix ? 'AND f.path >= ? AND f.path < ?' : ''} ORDER BY f.path, c.start_line LIMIT 2000`;
        params.push(match, target.snapshotId, target.generation);
      } else {
        sql = `SELECT c.file_id, c.start_line, c.text, f.path FROM chunks c JOIN snapshot_files f ON f.snapshot_id=c.snapshot_id AND f.file_id=c.file_id
          WHERE c.snapshot_id=? AND c.generation=? AND instr(lower(c.text), lower(?))>0 ${prefix ? 'AND f.path >= ? AND f.path < ?' : ''} ORDER BY f.path, c.start_line LIMIT 2000`;
        params.push(target.snapshotId, target.generation, terms[0]);
      }
      if (prefix) params.push(prefix, prefix + '￿');
      const rows = this.db.prepare(sql).all(...params) as { file_id: string; start_line: number; text: string; path: string }[];
      for (const row of rows) {
        const lines = row.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lineMatches(lines[i])) continue;
          if (skipped < offset) { skipped++; continue; }
          if (hits.length >= limit) { more = true; break; }
          hits.push({ snapshotId: target.snapshotId, bindingId: target.bindingId, fileId: row.file_id, path: row.path, line: row.start_line + i, text: lines[i].trim().slice(0, 300) });
        }
        if (more) break;
      }
      if (more) break;
    }
    return { hits, next: more ? offset + hits.length : undefined };
  }
  symbols(targets: SearchTarget[], name: string, limit = toolLimits.searchMatches) {
    if (!/^[\p{L}_$][\p{L}\p{N}_$.]{0,199}$/u.test(name)) throw new BridgeError('Укажите имя символа.');
    const out: (SearchHit & { kind: string; language: string })[] = [];
    for (const target of targets) {
      const rows = this.db.prepare(`SELECT s.file_id, s.line, s.kind, s.language, f.path FROM symbols s JOIN snapshot_files f ON f.snapshot_id=s.snapshot_id AND f.file_id=s.file_id
        WHERE s.snapshot_id=? AND s.generation=? AND (s.name=? OR s.name LIKE ?) ORDER BY f.path, s.line LIMIT ?`).all(target.snapshotId, target.generation, name, '%.' + name, limit) as
        { file_id: string; line: number; kind: string; language: string; path: string }[];
      for (const row of rows) out.push({ snapshotId: target.snapshotId, bindingId: target.bindingId, fileId: row.file_id, path: row.path, line: row.line, text: '', kind: row.kind, language: row.language });
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }
  /** Textual references with identifier boundaries. Dynamic calls are not resolved; results are labelled as heuristic. */
  references(targets: SearchTarget[], name: string, offset = 0) {
    if (!/^[\p{L}_$][\p{L}\p{N}_$]{0,199}$/u.test(name)) throw new BridgeError('Укажите идентификатор.');
    const boundary = new RegExp('(^|[^\\p{L}\\p{N}_$])' + name.replace(/[$]/g, '\\$') + '($|[^\\p{L}\\p{N}_$])', 'u');
    const found = this.search(targets, name, { mode: 'exact', caseSensitive: true, offset, limit: toolLimits.searchMatches });
    return { hits: found.hits.filter(hit => boundary.test(hit.text)), next: found.next };
  }
}
