import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { BridgeError } from '../store.js';
import { blobKey } from './blob-store.js';
import type { SnapshotFileRow, SourceRegistry } from './registry.js';

/** Extensions read as text. Other files are tried as UTF-8 text when they contain no NUL bytes. */
const languages: Record<string, string> = {
  cs: 'csharp', vb: 'vb', fs: 'fsharp', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  sql: 'sql', xml: 'xml', xaml: 'xml', config: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', xsd: 'xml', json: 'json',
  md: 'markdown', txt: 'text', csv: 'csv', tsv: 'csv', yml: 'yaml', yaml: 'yaml', ini: 'ini', ps1: 'powershell', psm1: 'powershell', cmd: 'batch', bat: 'batch',
  sh: 'shell', py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', html: 'html', htm: 'html', css: 'css',
  scss: 'css', less: 'css', razor: 'razor', cshtml: 'razor', sln: 'text', log: 'text', rtf: 'text', proto: 'proto', graphql: 'graphql',
};
const binaryExtensions = new Set(['dll', 'exe', 'pdb', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'zip', '7z', 'rar', 'gz', 'tar', 'mp3', 'mp4', 'avi', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'so', 'dylib', 'class', 'jar', 'nupkg', 'mdb', 'accdb', 'sqlite', 'db']);
const unsupportedDocuments = new Set(['doc', 'docx', 'xls', 'xlsb', 'xlsm', 'ppt', 'pptx', 'odt', 'ods']);
export function classify(path: string) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'xlsx') return { kind: 'xlsx' as const, language: 'table' };
  if (ext === 'pdf') return { kind: 'pdf' as const, language: 'document' };
  if (binaryExtensions.has(ext)) return { kind: 'binary' as const };
  if (unsupportedDocuments.has(ext)) return { kind: 'unsupported' as const };
  return { kind: 'text' as const, language: languages[ext] ?? 'text' };
}

/** Heuristic symbol definitions. Languages are not confirmed on a real Fastkore sample; tools label results as heuristic. */
const symbolRules: Record<string, [RegExp, string][]> = {
  csharp: [
    [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|file)\s+)*(class|interface|struct|enum|record)\s+([\p{L}_][\p{L}\p{N}_]*)/u, '$1'],
    [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial|extern|new|unsafe)\s+)+(?!class\b|interface\b|struct\b|enum\b|record\b|return\b|new\b)[\w<>[\],.?\s]+?\s+([\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^>]*>)?\s*\(/u, 'method'],
  ],
  vb: [[/^\s*(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|Partial)\s+)*(Class|Module|Interface|Structure|Enum)\s+([\p{L}_][\p{L}\p{N}_]*)/iu, '$1'],
    [/^\s*(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|Async)\s+)*(?:Sub|Function|Property)\s+([\p{L}_][\p{L}\p{N}_]*)/iu, 'method']],
  typescript: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u, '$1'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\p{L}_$][\p{L}\p{N}_$]*)/u, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\p{L}_$][\p{L}\p{N}_$]*)\s*=>/u, 'function'],
    [/^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([\p{L}_$][\p{L}\p{N}_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/u, 'method'],
  ],
  sql: [[/^\s*create\s+(?:or\s+(?:alter|replace)\s+)?(procedure|proc|function|view|table|trigger)\s+([\w.[\]"]+)/iu, '$1']],
};
symbolRules.javascript = symbolRules.typescript;
const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'using', 'lock', 'foreach', 'return', 'new', 'else', 'do', 'try', 'function']);
export function symbolsOf(language: string, line: string) {
  const rules = symbolRules[language];
  if (!rules || line.length > 2000) return [];
  for (const [rule, kind] of rules) {
    const match = rule.exec(line);
    if (!match) continue;
    const name = (kind === '$1' ? match[2] : match[1])?.replace(/[[\]"]/g, '');
    if (!name || keywords.has(name)) continue;
    return [{ name, kind: kind === '$1' ? match[1].toLowerCase() : kind }];
  }
  return [];
}

type Decoded = { encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be'; bomBytes: number };
export function detectEncoding(head: Buffer): Decoded | 'binary' {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8-bom', bomBytes: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bomBytes: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bomBytes: 2 };
  if (head.subarray(0, 8192).includes(0)) return 'binary';
  return { encoding: 'utf-8', bomBytes: 0 };
}

const linesPerChunk = 40, chunkChars = 12_000, lineIndexStep = 200, maxIndexedLineChars = 4000;
export interface IndexerOptions { leaseMs?: number; pollMs?: number; maxAttempts?: number; extractionTimeoutMs?: number; workerId?: string }

/** Durable background indexing with lease/heartbeat, resumable per file, atomic generation switch. */
export class SourceIndexer {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private processing?: Promise<boolean>;
  private stopped = true;
  readonly workerId: string;
  private batch: (() => void)[] = [];
  private readonly leaseMs: number; private readonly pollMs: number; private readonly maxAttempts: number; private readonly extractionTimeoutMs: number;
  constructor(private readonly registry: SourceRegistry, options: IndexerOptions = {}) {
    this.workerId = options.workerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 60_000; this.pollMs = options.pollMs ?? 2000; this.maxAttempts = options.maxAttempts ?? 5;
    this.extractionTimeoutMs = options.extractionTimeoutMs ?? 60_000;
  }
  start() { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => {}); }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.running = this.runOnce().then(() => undefined, () => undefined).finally(() => this.schedule(this.pollMs)); }, delay);
    this.timer.unref?.();
  }
  private get db() { return this.registry.db; }
  /** Claims one job whose lease is free or expired. Returns false when the queue is empty. */
  runOnce(): Promise<boolean> {
    return this.processing ??= this.claimAndIndex().finally(() => { this.processing = undefined; });
  }
  private async claimAndIndex(): Promise<boolean> {
    const now = Date.now();
    const job = this.registry.tx(() => {
      const row = this.db.prepare(`SELECT * FROM index_jobs WHERE (state='queued' AND (lease_until IS NULL OR lease_until<=?)) OR (state='running' AND lease_until<=?) ORDER BY created_at LIMIT 1`)
        .get(now, now) as { snapshot_id: string; generation: number; attempts: number } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE index_jobs SET state='running', lease_owner=?, lease_until=?, attempts=attempts+1 WHERE snapshot_id=?").run(this.workerId, now + this.leaseMs, row.snapshot_id);
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!job) return false;
    const heartbeat = setInterval(() => {
      this.db.prepare('UPDATE index_jobs SET lease_until=? WHERE snapshot_id=? AND lease_owner=?').run(Date.now() + this.leaseMs, job.snapshot_id, this.workerId);
    }, Math.max(1000, this.leaseMs / 3));
    heartbeat.unref?.();
    try {
      await this.indexSnapshot(job.snapshot_id, job.generation);
    } catch (error) {
      const message = error instanceof BridgeError ? error.message : 'Сбой индексации';
      const final = job.attempts >= this.maxAttempts;
      this.registry.tx(() => {
        this.db.prepare("UPDATE index_jobs SET state=?, lease_owner=NULL, lease_until=?, last_error=? WHERE snapshot_id=? AND lease_owner=?")
          .run(final ? 'failed' : 'queued', Date.now() + Math.min(300_000, 2000 * 2 ** job.attempts), message, job.snapshot_id, this.workerId);
        if (final) this.db.prepare("UPDATE snapshots SET state='failed', failure='index_failed' WHERE id=? AND state='indexing'").run(job.snapshot_id);
      });
    } finally { clearInterval(heartbeat); }
    return true;
  }
  /** Drains the queue; used by tests and maintenance commands. */
  async drain(limit = 100) { for (let i = 0; i < limit; i++) if (!(await this.runOnce())) return; }
  private owned(snapshotId: string) {
    const row = this.db.prepare('SELECT lease_owner FROM index_jobs WHERE snapshot_id=?').get(snapshotId) as { lease_owner: string | null } | undefined;
    if (row?.lease_owner !== this.workerId) throw new BridgeError('Задание индексации передано другому обработчику.', 409);
  }
  private async indexSnapshot(snapshotId: string, generation: number) {
    const snapshot = this.registry.snapshotRow(snapshotId);
    if (!snapshot) throw new BridgeError('Снимок не найден.', 404);
    const files = this.db.prepare(`SELECT f.* FROM snapshot_files f WHERE f.snapshot_id=? AND NOT EXISTS (SELECT 1 FROM index_file_results r WHERE r.snapshot_id=f.snapshot_id AND r.generation=? AND r.file_id=f.file_id) ORDER BY path`)
      .all(snapshotId, generation) as SnapshotFileRow[];
    // Rows of files without a committed result (an interrupted run) are removed once; each file then commits with its result row.
    this.registry.tx(() => {
      for (const table of ['chunks', 'line_index', 'symbols']) this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id=? AND generation=? AND file_id NOT IN
        (SELECT file_id FROM index_file_results WHERE snapshot_id=? AND generation=?)`).run(snapshotId, generation, snapshotId, generation);
    });
    // Writes are batched across small files: index rows and the files' result rows commit in the same transaction.
    this.batch = [];
    const flush = () => {
      if (!this.batch.length) return;
      const work = this.batch; this.batch = [];
      this.registry.tx(() => {
        for (const write of work) write();
        this.db.prepare('UPDATE snapshots SET indexed_files=(SELECT count(*) FROM index_file_results WHERE snapshot_id=? AND generation=?) WHERE id=?').run(snapshotId, generation, snapshotId);
      });
    };
    const insertResult = this.db.prepare('INSERT OR REPLACE INTO index_file_results VALUES (?,?,?,?,?,?,?,?,?,?)');
    let lastFlush = Date.now();
    try {
      for (const file of files) {
        this.owned(snapshotId);
        const result = await this.indexFile(snapshot.source_id, snapshotId, generation, file);
        // A file that turned out unreadable part-way (for example invalid UTF-8 at the end) leaves no searchable rows.
        if (result.state !== 'indexed' && result.state !== 'limited') for (const table of ['chunks', 'line_index', 'symbols']) {
          this.batch.push(() => this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id=? AND generation=? AND file_id=?`).run(snapshotId, generation, file.file_id));
        }
        this.batch.push(() => insertResult.run(snapshotId, generation, file.file_id, result.mediaType ?? null, result.encoding ?? null,
          result.state, result.lines ?? null, result.language ?? null, result.textBlobId ?? null, result.note ?? null));
        if (this.batch.length >= 4000 || Date.now() - lastFlush > 2000) { flush(); lastFlush = Date.now(); }
      }
      flush();
    } finally { this.batch = []; }
    this.owned(snapshotId);
    this.switchGeneration(snapshotId, generation);
  }
  /** Activates the new generation atomically and removes rows of any other generation. */
  private switchGeneration(snapshotId: string, generation: number) {
    this.registry.tx(() => {
      this.owned(snapshotId);
      const snapshot = this.registry.snapshotRow(snapshotId)!;
      const previousText = (this.db.prepare('SELECT text_blob_id id FROM snapshot_files WHERE snapshot_id=? AND text_blob_id IS NOT NULL').all(snapshotId) as { id: string }[]).map(r => r.id);
      this.db.prepare(`UPDATE snapshot_files SET media_type=r.media_type, encoding=r.encoding, extraction_state=r.extraction_state, line_count=r.line_count, language=r.language,
        text_blob_id=r.text_blob_id, extraction_note=r.note FROM index_file_results r WHERE r.snapshot_id=snapshot_files.snapshot_id AND r.file_id=snapshot_files.file_id
        AND r.generation=? AND snapshot_files.snapshot_id=?`).run(generation, snapshotId);
      const counts = this.db.prepare(`SELECT sum(extraction_state IN ('indexed','limited')) n_indexed, sum(extraction_state IN ('unsupported_format','unsupported_encoding')) n_unsupported,
        sum(extraction_state='failed') n_failed FROM snapshot_files WHERE snapshot_id=?`).get(snapshotId) as { n_indexed: number | null; n_unsupported: number | null; n_failed: number | null };
      for (const table of ['chunks', 'line_index', 'symbols']) this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id=? AND generation<>?`).run(snapshotId, generation);
      this.db.prepare('DELETE FROM index_file_results WHERE snapshot_id=?').run(snapshotId);
      const failed = counts.n_failed ?? 0;
      const state = failed && !snapshot.coverage_accepted_by ? 'failed' : 'ready';
      this.db.prepare('UPDATE snapshots SET state=?, failure=?, index_generation=?, indexed_files=?, unsupported_files=?, extraction_errors=? WHERE id=?')
        .run(state, state === 'failed' ? 'partial_index' : null, generation, counts.n_indexed ?? 0, counts.n_unsupported ?? 0, failed, snapshotId);
      this.db.prepare("UPDATE index_jobs SET state='done', lease_owner=NULL, lease_until=NULL, last_error=NULL WHERE snapshot_id=?").run(snapshotId);
      const keep = new Set((this.db.prepare('SELECT text_blob_id id FROM snapshot_files WHERE text_blob_id IS NOT NULL').all() as { id: string }[]).map(r => r.id));
      for (const id of previousText) if (!keep.has(id)) this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=? AND state='verified'").run(Date.now(), id);
      this.registry.bumpBindingsForSource(snapshot.source_id);
    }, () => [{ actorId: 'system', action: 'source.snapshot.indexed', targetId: snapshotId, details: { objectIds: { generation: String(generation) } } }]);
  }
  /** Requeues a failed snapshot with a new generation; the previous active generation stays usable until the switch. */
  requeue(snapshotId: string) {
    return this.registry.tx(() => {
      const snapshot = this.registry.snapshotRow(snapshotId);
      if (!snapshot || !['failed', 'ready'].includes(snapshot.state)) throw new BridgeError('Снимок нельзя переиндексировать в текущем состоянии.', 409);
      const generation = snapshot.index_generation + 1;
      if (snapshot.state === 'failed') this.db.prepare("UPDATE snapshots SET state='indexing', failure=NULL WHERE id=?").run(snapshotId);
      this.db.prepare(`INSERT INTO index_jobs (snapshot_id, generation, state, attempts, created_at) VALUES (?,?,'queued',0,?)
        ON CONFLICT(snapshot_id) DO UPDATE SET generation=excluded.generation, state='queued', attempts=0, lease_owner=NULL, lease_until=NULL, last_error=NULL`).run(snapshotId, generation, Date.now());
      return generation;
    });
  }
  private async indexFile(sourceId: string, snapshotId: string, generation: number, file: SnapshotFileRow): Promise<{ state: string; encoding?: string; mediaType?: string; lines?: number;
    language?: string; textBlobId?: string; note?: string }> {
    const kind = classify(file.path);
    if (kind.kind === 'binary') return { state: 'unsupported_format', mediaType: 'application/octet-stream', note: 'Двоичный формат' };
    if (kind.kind === 'unsupported') return { state: 'unsupported_format', note: 'Формат документа пока не поддерживается' };
    const store = this.registry.storage.store;
    if (!store) throw new BridgeError('Хранилище источников недоступно.', 503);
    const blob = this.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(file.blob_id) as { object_key: string };
    if (kind.kind === 'xlsx' || kind.kind === 'pdf') {
      if (file.size > 64 * 1024 * 1024) return { state: 'unsupported_format', note: 'Документ превышает 64 МиБ для извлечения' };
      const data = await this.readAll(store, blob.object_key);
      let text: string;
      try { text = await this.extract(kind.kind, data); }
      catch { return { state: 'failed', note: 'Не удалось извлечь текст документа' }; }
      const derived = Buffer.from(text, 'utf8');
      const textBlobId = await this.storeDerived(sourceId, derived);
      const lines = this.indexText(snapshotId, generation, file.file_id, derived, 0, kind.language!);
      return { state: 'indexed', mediaType: kind.kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', encoding: 'utf-8', lines, language: kind.language, textBlobId };
    }
    const stream = await store.stream(blob.object_key);
    const head: Buffer[] = []; let headBytes = 0;
    const chunks: AsyncIterator<Buffer> = stream[Symbol.asyncIterator]();
    let first = await chunks.next();
    while (!first.done && headBytes < 8192) { head.push(first.value); headBytes += first.value.length; if (headBytes < 8192) first = await chunks.next(); else break; }
    const prefix = Buffer.concat(head);
    const detected = detectEncoding(prefix);
    if (detected === 'binary') { stream.destroy(); return { state: 'unsupported_format', note: 'Файл содержит двоичные данные' }; }
    const remaining = async function* () { yield prefix; if (!first.done) for (let next = await chunks.next(); !next.done; next = await chunks.next()) yield next.value; };
    if (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be') {
      if (file.size > this.registry.limits.indexTextBytes * 2) { stream.destroy(); return { state: 'unsupported_format', encoding: detected.encoding, note: 'UTF-16 файл превышает предел извлечения' }; }
      const parts: Buffer[] = [];
      for await (const part of remaining()) parts.push(part);
      let text: string;
      try { text = new TextDecoder(detected.encoding, { fatal: true }).decode(Buffer.concat(parts).subarray(detected.bomBytes)); }
      catch { return { state: 'unsupported_encoding', encoding: detected.encoding, note: 'Некорректная последовательность UTF-16' }; }
      const derived = Buffer.from(text, 'utf8');
      const textBlobId = await this.storeDerived(sourceId, derived);
      const lines = this.indexText(snapshotId, generation, file.file_id, derived, 0, kind.language!);
      return { state: 'indexed', encoding: detected.encoding, mediaType: 'text/plain', lines, language: kind.language, textBlobId };
    }
    return this.indexUtf8Stream(snapshotId, generation, file, remaining(), detected, kind.language!);
  }
  private async readAll(store: NonNullable<SourceRegistry['storage']['store']>, key: string) {
    const parts: Buffer[] = [];
    for await (const part of await store.stream(key)) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }
  private async storeDerived(sourceId: string, data: Buffer) {
    const id = 'd_' + randomUUID().replaceAll('-', '');
    const key = blobKey(sourceId, id);
    this.db.prepare("INSERT INTO blobs (id, source_id, object_key, sha256, size, kind, state, created_at) VALUES (?,?,?,?,?,'derived','pending',?)")
      .run(id, sourceId, key, createHash('sha256').update(data).digest('hex'), data.length, Date.now());
    await this.registry.storage.store!.put(key, data);
    this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(id);
    return id;
  }
  private extract(kind: 'xlsx' | 'pdf', input: Buffer) {
    const script = new URL(import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.js', import.meta.url);
    const worker = new Worker(script, { workerData: { kind, input }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 } });
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('timeout')); }, this.extractionTimeoutMs);
      worker.once('message', text => { clearTimeout(timer); void worker.terminate(); resolve(String(text)); });
      worker.once('error', error => { clearTimeout(timer); void worker.terminate(); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('exit ' + code)); });
    });
  }
  /** Indexes UTF-8 text from memory (derived documents). Offsets refer to the given buffer. */
  private indexText(snapshotId: string, generation: number, fileId: string, data: Buffer, offset: number, language: string) {
    const writer = this.writer(snapshotId, generation, fileId, language);
    let start = offset;
    for (let i = offset; i <= data.length; i++) {
      if (i === data.length || data[i] === 0x0a) {
        if (i === data.length && start === data.length) break;
        writer.line(data.subarray(start, i).toString('utf8'), start);
        start = i + 1;
      }
    }
    return writer.finish();
  }
  private async indexUtf8Stream(snapshotId: string, generation: number, file: SnapshotFileRow, source: AsyncIterable<Buffer>, detected: Decoded, language: string) {
    const writer = this.writer(snapshotId, generation, file.file_id, language);
    const validator = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0), position = 0, lineStart = detected.bomBytes, indexedBytes = 0, limited = false, skipped = detected.bomBytes;
    try {
      for await (const raw of source) {
        let chunk = raw;
        if (skipped) { const cut = Math.min(skipped, chunk.length); chunk = chunk.subarray(cut); skipped -= cut; position += cut; if (!chunk.length) continue; }
        validator.decode(chunk, { stream: true });
        let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const base = position - pending.length;
        let from = 0;
        for (let i = buffer.indexOf(0x0a); i >= 0; i = buffer.indexOf(0x0a, from)) {
          const text = buffer.subarray(from, i).toString('utf8');
          indexedBytes += i - from + 1;
          if (indexedBytes > this.registry.limits.indexTextBytes) limited = true;
          writer.line(text, base + from, limited);
          from = i + 1;
          lineStart = base + from;
        }
        pending = Buffer.from(buffer.subarray(from));
        buffer = Buffer.alloc(0);
        position += chunk.length;
        if (pending.length > 64 * 1024 * 1024) throw new Error('line too long');
      }
      validator.decode();
    } catch {
      return { state: 'unsupported_encoding', encoding: 'unknown', note: 'Файл не является корректным UTF-8. Укажите кодировку явно или преобразуйте файл.' };
    }
    if (pending.length) writer.line(pending.toString('utf8'), lineStart, limited);
    const lines = writer.finish();
    return { state: limited ? 'limited' : 'indexed', encoding: detected.encoding, mediaType: 'text/plain', lines, language,
      note: limited ? `Полнотекстовый индекс ограничен первыми ${Math.round(this.registry.limits.indexTextBytes / 1048576)} МиБ; чтение строк доступно полностью.` : undefined };
  }
  private writer(snapshotId: string, generation: number, fileId: string, language: string) {
    const insertChunk = this.db.prepare('INSERT INTO chunks (snapshot_id, generation, file_id, start_line, text) VALUES (?,?,?,?,?)');
    const insertOffset = this.db.prepare('INSERT OR REPLACE INTO line_index VALUES (?,?,?,?,?)');
    const insertSymbol = this.db.prepare('INSERT INTO symbols VALUES (?,?,?,?,?,?,?,?)');
    let line = 0, chunkStart = 1, buffer: string[] = [], size = 0;
    // Rows are buffered and written in short synchronous transactions; no transaction stays open across awaits.
    // Rows go to the job batch; a very large file flushes the batch itself so memory stays bounded.
    const indexer = this;
    const pending = { push: (write: () => void) => indexer.batch.push(write), get length() { return indexer.batch.length; } };
    const commit = () => {
      if (indexer.batch.length < 4000) return;
      const work = indexer.batch; indexer.batch = [];
      indexer.registry.tx(() => { for (const write of work) write(); });
    };
    const flush = () => {
      if (!buffer.length) return;
      const text = buffer.join('\n'), start = chunkStart;
      pending.push(() => insertChunk.run(snapshotId, generation, fileId, start, text));
      buffer = []; size = 0; chunkStart = line + 1;
      commit();
    };
    return {
      line(text: string, offset: number, skipIndex = false) {
        line++;
        const clean = text.endsWith('\r') ? text.slice(0, -1) : text;
        const current = line;
        if ((current - 1) % lineIndexStep === 0) pending.push(() => insertOffset.run(snapshotId, generation, fileId, current, offset));
        if (skipIndex) { flush(); chunkStart = line + 1; commit(); return; }
        if (!buffer.length) chunkStart = line;
        buffer.push(clean.length > maxIndexedLineChars ? clean.slice(0, maxIndexedLineChars) : clean);
        size += Math.min(clean.length, maxIndexedLineChars);
        for (const symbol of symbolsOf(language, clean)) pending.push(() => insertSymbol.run(snapshotId, generation, fileId, symbol.name, symbol.kind, current, null, language));
        if (buffer.length >= linesPerChunk || size >= chunkChars) flush();
      },
      finish() { flush(); return line; },
    };
  }
}
