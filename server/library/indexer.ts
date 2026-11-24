import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { BridgeError } from '../store.js';
import { blobKey } from './blob-store.js';
import { contentKey, processorVersion, type LibraryRegistry, type StateFileRow } from './registry.js';
import { detectEncoding, type TextIndexInput, type TextIndexResult } from './text-index.js';

/** Extensions read as text. Other files are tried as UTF-8 text when they contain no NUL bytes. */
const languages: Record<string, string> = {
  cs: 'csharp', vb: 'vb', fs: 'fsharp', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  sql: 'sql', xml: 'xml', xaml: 'xml', config: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', xsd: 'xml', json: 'json',
  md: 'markdown', txt: 'text', csv: 'csv', tsv: 'csv', yml: 'yaml', yaml: 'yaml', ini: 'ini', ps1: 'powershell', psm1: 'powershell', cmd: 'batch', bat: 'batch',
  sh: 'shell', py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', html: 'html', htm: 'html', css: 'css',
  scss: 'css', less: 'css', razor: 'razor', cshtml: 'razor', sln: 'text', log: 'text', rtf: 'text', proto: 'proto', graphql: 'graphql',
};
const binaryExtensions = new Set(['dll', 'exe', 'pdb', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'zip', '7z', 'rar', 'gz', 'tar', 'mp3', 'mp4', 'avi', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'so', 'dylib', 'class', 'jar', 'nupkg', 'mdb', 'accdb', 'sqlite', 'db']);
const unsupportedDocuments = new Set(['doc', 'xls', 'xlsb', 'xlsm', 'ppt', 'pptx', 'odt', 'ods']);
export function classify(path: string) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'xlsx') return { kind: 'xlsx' as const, language: 'table' };
  if (ext === 'pdf') return { kind: 'pdf' as const, language: 'document' };
  if (ext === 'docx') return { kind: 'docx' as const, language: 'document' };
  if (binaryExtensions.has(ext)) return { kind: 'binary' as const };
  if (unsupportedDocuments.has(ext)) return { kind: 'unsupported' as const };
  return { kind: 'text' as const, language: languages[ext] ?? 'text' };
}

export interface IndexerOptions {
  leaseMs?: number; pollMs?: number; maxAttempts?: number; extractionTimeoutMs?: number; workerId?: string;
  /** Time budget for text processing of one file in the index worker; on overrun the worker is terminated and the file gets state "timeout". */
  fileTimeoutMs?: number;
}

class IndexTimeout extends Error {}
/**
 * One persistent worker for CPU-bound text indexing, observed from the main thread. A file that exceeds the time budget or the memory
 * limits terminates the worker; the next file starts a fresh one. The main thread (heartbeat, HTTP) is never blocked by text processing.
 */
class TextIndexWorker {
  private seq = 0;
  private readonly pending = new Map<number, { worker: Worker; resolve: (r: TextIndexResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly timeoutMs: number) {}
  private worker?: { worker: Worker; ready: Promise<void> };
  private spawn() {
    const script = new URL(import.meta.url.endsWith('.ts') ? './index-worker.ts' : './index-worker.js', import.meta.url);
    const worker = new Worker(script, { resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
    let started!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { started = resolve; failed = reject; });
    worker.on('message', (message: { id?: number; ready?: true; result?: TextIndexResult; error?: string }) => {
      if (message.ready) { started(); return; }
      const entry = this.pending.get(message.id!);
      if (!entry) return;
      this.pending.delete(message.id!); clearTimeout(entry.timer);
      if (message.result) entry.resolve(message.result); else entry.reject(new Error(message.error ?? 'index worker error'));
    });
    const fail = (error: Error) => {
      failed(error);
      if (this.worker?.worker === worker) this.worker = undefined;
      for (const [id, entry] of this.pending) if (entry.worker === worker) { this.pending.delete(id); clearTimeout(entry.timer); entry.reject(error); }
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error('index worker exited ' + code)));
    ready.catch(() => {});
    return { worker, ready };
  }
  /** The time budget starts once the worker is up, so worker start-up does not count against a file. */
  async run(input: TextIndexInput): Promise<TextIndexResult> {
    const current = this.worker ??= this.spawn();
    // Referenced only while a file is processed, so an idle worker does not keep the process alive.
    current.worker.ref();
    try { await current.ready; }
    catch {
      if (this.worker === current) this.worker = undefined;
      throw new BridgeError('Обработчик индексации не запустился.', 503);
    }
    const { worker } = current;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.worker === current) this.worker = undefined;
        void worker.terminate();
        reject(new IndexTimeout());
      }, this.timeoutMs);
      this.pending.set(id, { worker, resolve, reject, timer });
      // The file bytes are copied: the caller's buffer may come from a shared pool.
      worker.postMessage({ id, input });
    }).finally(() => worker.unref()) as Promise<TextIndexResult>;
  }
  async close() { const current = this.worker; this.worker = undefined; await current?.worker.terminate(); }
}

const mediaTypes = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
type Processed = { state: string; encoding?: string; mediaType?: string; lines?: number; language?: string; textBlobId?: string; note?: string; rows?: TextIndexResult };

/**
 * Durable background processing of prepared library contents with lease and heartbeat. Work is done per content (SHA-256 and size): unchanged
 * files of an update, and identical files in several folders, are processed once. Results commit together with their index rows; when the last
 * content of a prepared state is processed, the state replaces the folder's current content.
 */
export class LibraryIndexer {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private processing?: Promise<boolean>;
  private stopped = true;
  readonly workerId: string;
  private batch: (() => void)[] = [];
  private readonly leaseMs: number; private readonly pollMs: number; private readonly maxAttempts: number; private readonly extractionTimeoutMs: number;
  private readonly fileTimeoutMs: number;
  private readonly textWorker: TextIndexWorker;
  /** Set once no current content needs a newer processing version; new contents are always processed with the current one. */
  private upgradesDone = false;
  constructor(private readonly registry: LibraryRegistry, options: IndexerOptions = {}) {
    this.workerId = options.workerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 60_000; this.pollMs = options.pollMs ?? 2000; this.maxAttempts = options.maxAttempts ?? 5;
    this.extractionTimeoutMs = options.extractionTimeoutMs ?? 60_000;
    this.fileTimeoutMs = options.fileTimeoutMs ?? 30_000;
    this.textWorker = new TextIndexWorker(this.fileTimeoutMs);
  }
  start() { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => {}); await this.textWorker.close(); }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.running = this.runOnce().then(() => undefined, () => undefined).finally(() => this.schedule(this.pollMs)); }, delay);
    this.timer.unref?.();
  }
  private get db() { return this.registry.db; }
  /** Drains the queue; used by tests and maintenance. */
  async drain(limit = 100) { for (let i = 0; i < limit; i++) if (!(await this.runOnce())) return; }
  /** Claims one job whose lease is free or expired. Returns false when the queue is empty. */
  runOnce(): Promise<boolean> {
    return this.processing ??= this.claimAndIndex().finally(() => { this.processing = undefined; });
  }
  private async claimAndIndex(): Promise<boolean> {
    const now = Date.now();
    const job = this.registry.tx(() => {
      const row = this.db.prepare(`SELECT * FROM index_jobs WHERE (status='queued' AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until<=?) ORDER BY created_at LIMIT 1`)
        .get(now, now) as { state_id: string; attempts: number } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE index_jobs SET status='running', lease_owner=?, lease_until=?, attempts=attempts+1 WHERE state_id=?").run(this.workerId, now + this.leaseMs, row.state_id);
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!job) return this.upgradeOne();
    const heartbeat = setInterval(() => {
      this.db.prepare('UPDATE index_jobs SET lease_until=? WHERE state_id=? AND lease_owner=?').run(Date.now() + this.leaseMs, job.state_id, this.workerId);
    }, Math.max(1000, this.leaseMs / 3));
    heartbeat.unref?.();
    try {
      await this.indexState(job.state_id);
    } catch (error) {
      const message = error instanceof BridgeError ? error.message : 'Сбой обработки';
      const final = job.attempts >= this.maxAttempts;
      this.registry.tx(() => {
        this.db.prepare('UPDATE index_jobs SET status=?, lease_owner=NULL, lease_until=?, last_error=? WHERE state_id=? AND lease_owner=?')
          .run(final ? 'failed' : 'queued', Date.now() + Math.min(300_000, 2000 * 2 ** job.attempts), message, job.state_id, this.workerId);
      });
      if (final) this.registry.failIndexing(job.state_id);
    } finally { clearInterval(heartbeat); }
    return true;
  }
  private owned(stateId: string) {
    const row = this.db.prepare('SELECT lease_owner FROM index_jobs WHERE state_id=?').get(stateId) as { lease_owner: string | null } | undefined;
    if (row?.lease_owner !== this.workerId) throw new BridgeError('Задание обработки передано другому обработчику.', 409);
  }
  private async indexState(stateId: string) {
    const state = this.registry.stateRow(stateId);
    if (!state || state.status !== 'preparing') { this.db.prepare('DELETE FROM index_jobs WHERE state_id=?').run(stateId); return; }
    // One file per distinct content; contents processed earlier (also in other folders) are skipped by pendingFiles.
    const signal = this.registry.external.has(state.folder_id) ? this.registry.external.signal(state.folder_id) : undefined;
    const seen = new Set<string>();
    const files = this.registry.pendingFiles(stateId).filter(f => { const key = contentKey(f.sha256, f.size); if (seen.has(key)) return false; seen.add(key); return true; });
    this.batch = [];
    const flush = () => {
      if (!this.batch.length) return;
      const work = this.batch; this.batch = [];
      this.registry.tx(() => { for (const write of work) write(); });
    };
    let lastFlush = Date.now();
    try {
      for (const file of files) {
        this.owned(stateId);
        if (this.registry.stateRow(stateId)?.status !== 'preparing') return;
        const result = await this.processFile(file, signal);
        signal?.throwIfAborted();
        const previousBatch = this.batch;
        this.queueResult(file, result, true);
        // Link already written chunks and derived objects before this drive can be disconnected.
        const needsCommit = signal && (result.textBlobId || previousBatch !== this.batch);
        if (needsCommit || this.batch.length >= 4000 || Date.now() - lastFlush > 2000) { flush(); lastFlush = Date.now(); }
      }
      flush();
    } finally { this.batch = []; }
    this.owned(stateId);
    this.registry.tx(() => {
      if (!this.registry.tryPublish(stateId)) {
        // Contents still missing (for example removed by a concurrent retry): process again.
        this.db.prepare("UPDATE index_jobs SET status='queued', lease_owner=NULL, lease_until=NULL WHERE state_id=? AND status='running'").run(stateId);
      }
    });
  }
  /** Marks the extracted text of the content's previous result for collection; the grace period covers answers still reading it. */
  private orphanText(file: Pick<StateFileRow, 'sha256' | 'size'>) {
    this.db.prepare(`UPDATE blobs SET state='orphan', orphaned_at=? WHERE state='verified' AND id=(SELECT text_blob_id FROM contents WHERE sha256=? AND size=?)`)
      .run(Date.now(), file.sha256, file.size);
  }
  /**
   * Brings one file of a current content up to the processing version its kind requires, in place: the folder keeps its content and
   * gains the new extraction (for example DOCX text or XLSX cell references). A failed upgrade keeps a previously readable result.
   */
  private async upgradeOne(): Promise<boolean> {
    if (this.upgradesDone) return false;
    const file = this.registry.outdatedFile();
    if (!file) { this.upgradesDone = true; return false; }
    const state = this.registry.stateRow(file.state_id);
    const signal = state && this.registry.external.has(state.folder_id) ? this.registry.external.signal(state.folder_id) : undefined;
    const result = await this.processFile(file, signal).catch(error => { if (!signal?.aborted) throw error; });
    if (!result || signal?.aborted) return true;
    this.batch = [];
    try {
      this.queueResult(file, result, false);
      this.registry.tx(() => { for (const write of this.batch) write(); });
    } finally { this.batch = []; }
    return true;
  }
  private queueResult(file: StateFileRow, result: Processed, commitEarly: boolean) {
    const previous = this.db.prepare('SELECT state FROM contents WHERE sha256=? AND size=?').get(file.sha256, file.size) as { state: string } | undefined;
    const usable = result.state === 'indexed' || result.state === 'limited';
    if (!usable && (previous?.state === 'indexed' || previous?.state === 'limited')) {
      this.batch.push(() => this.db.prepare('UPDATE contents SET processor=? WHERE sha256=? AND size=?').run(processorVersion, file.sha256, file.size));
      return;
    }
    const key = contentKey(file.sha256, file.size);
    this.batch.push(() => { this.registry.deleteContentIndex(key); this.orphanText(file); });
    if (result.rows && usable) this.writeRows(key, result.rows, commitEarly && !previous);
    this.batch.push(() => {
      this.db.prepare('INSERT OR REPLACE INTO contents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(file.sha256, file.size, processorVersion, result.state, result.mediaType ?? null,
        result.encoding ?? null, result.lines ?? null, result.language ?? null, result.textBlobId ?? null, result.note ?? null, Date.now());
      if (previous) this.registry.refreshCoverage(key);
    });
  }
  private async processFile(file: StateFileRow, signal?: AbortSignal): Promise<Processed> {
    const kind = classify(file.path);
    if (kind.kind === 'binary') return { state: 'unsupported_format', mediaType: 'application/octet-stream', note: 'Двоичный формат' };
    if (kind.kind === 'unsupported') return { state: 'unsupported_format', note: 'Формат документа пока не поддерживается' };
    const blob = this.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(file.blob_id) as { object_key: string };
    const store = this.registry.objectStore(blob.object_key);
    if (kind.kind === 'xlsx' || kind.kind === 'pdf' || kind.kind === 'docx') {
      if (file.size > 64 * 1024 * 1024) return { state: 'unsupported_format', note: 'Документ превышает 64 МиБ для извлечения' };
      const data = (await this.readObject(store, blob.object_key, signal))!;
      let text: string;
      try { text = await this.extract(kind.kind, data, signal); }
      catch (error) {
        signal?.throwIfAborted();
        return error instanceof Error && error.message === 'timeout'
          ? { state: 'timeout', note: `Извлечение текста превысило ${Math.ceil(this.extractionTimeoutMs / 1000)} с; повторите обработку.` }
          : { state: 'failed', note: 'Не удалось извлечь текст документа' };
      }
      const mediaType = mediaTypes[kind.kind];
      if (kind.kind === 'pdf' && !/[\p{L}\p{N}]/u.test(text.replace(/^# Страница \d+$/gm, ''))) {
        return { state: 'ocr_required', mediaType, note: 'В PDF нет текстового слоя. Требуется распознавание.' };
      }
      const derived = Buffer.from(text, 'utf8');
      const processed = await this.processText({ data: derived, mode: 'derived', indexTextBytes: this.registry.limits.indexTextBytes }, signal);
      if (!('chunks' in processed)) return processed;
      const textBlobId = await this.storeDerived(derived, blob.object_key, signal);
      return { state: 'indexed', mediaType, encoding: 'utf-8', lines: processed.lines, language: kind.language, textBlobId, rows: processed };
    }
    // Binary content without a known extension is recognised from the first bytes without downloading the rest.
    const data = await this.readObject(store, blob.object_key, signal, head => detectEncoding(head) === 'binary');
    if (!data) return { state: 'unsupported_format', note: 'Файл содержит двоичные данные' };
    const processed = await this.processText({ data, mode: 'object', indexTextBytes: this.registry.limits.indexTextBytes }, signal);
    if (!('chunks' in processed)) return processed;
    if (processed.state !== 'indexed' && processed.state !== 'limited') return { state: processed.state, encoding: processed.encoding, note: processed.note };
    const textBlobId = processed.derived ? await this.storeDerived(Buffer.from(processed.derived), blob.object_key, signal) : undefined;
    return { state: processed.state, encoding: processed.encoding, mediaType: processed.mediaType, lines: processed.lines, language: kind.language, textBlobId, note: processed.note, rows: processed };
  }
  /** Runs text processing in the index worker under the per-file time and memory budget. */
  private async processText(input: TextIndexInput, signal?: AbortSignal): Promise<TextIndexResult | { state: string; note: string }> {
    signal?.throwIfAborted();
    const abort = () => { void this.textWorker.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try { return await this.textWorker.run(input); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BridgeError) throw error;
      if (error instanceof IndexTimeout) return { state: 'timeout', note: `Обработка файла превысила ${Math.ceil(this.fileTimeoutMs / 1000)} с и прервана; повторите обработку.` };
      return { state: 'failed', note: 'Обработка файла прервана: превышен предел памяти или сбой обработчика.' };
    } finally { signal?.removeEventListener('abort', abort); }
  }
  /**
   * Reads a whole object. The response stream is always destroyed, also on early exit: an unconsumed S3 body keeps its pooled
   * connection, and enough of them exhaust the client's socket pool so that every further request waits.
   * `rejectHead` stops after the first 8 KiB (returns undefined) when the prefix shows the content is not worth reading.
   */
  private async readObject(store: ReturnType<LibraryRegistry['store']>, key: string, signal?: AbortSignal, rejectHead?: (head: Buffer) => boolean) {
    const stream = await store.stream(key, signal);
    try {
      const parts: Buffer[] = []; let size = 0, checked = !rejectHead;
      for await (const part of stream) {
        parts.push(part as Buffer); size += (part as Buffer).length;
        if (!checked && size >= 8192) { checked = true; if (rejectHead!(Buffer.concat(parts))) return undefined; }
      }
      const data = Buffer.concat(parts);
      if (!checked && rejectHead!(data)) return undefined;
      return data;
    } finally { stream.destroy(); }
  }
  /** Extracted text is stored once per content, outside any folder. */
  private async storeDerived(data: Buffer, originalKey: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const id = 'd_' + randomUUID().replaceAll('-', '');
    const key = blobKey(originalKey.startsWith('library/external_') ? 'external_derived' : 'derived', id);
    this.db.prepare("INSERT INTO blobs (id, folder_id, object_key, sha256, size, kind, state, created_at) VALUES (?,NULL,?,?,?,'derived','pending',?)")
      .run(id, key, createHash('sha256').update(data).digest('hex'), data.length, Date.now());
    try {
      await this.registry.objectStore(key).put(key, data);
      signal?.throwIfAborted();
    } catch (e) {
      this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=?").run(Date.now(), id);
      throw e;
    }
    this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(id);
    return id;
  }
  private extract(kind: 'xlsx' | 'pdf' | 'docx', input: Buffer, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const script = new URL(import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.js', import.meta.url);
    const worker = new Worker(script, { workerData: { kind, input }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 } });
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('timeout')); }, this.extractionTimeoutMs);
      const abort = () => { clearTimeout(timer); void worker.terminate(); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('exit', () => signal?.removeEventListener('abort', abort));
      worker.once('message', text => { clearTimeout(timer); void worker.terminate(); resolve(String(text)); });
      worker.once('error', error => { clearTimeout(timer); void worker.terminate(); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('exit ' + code)); });
    });
  }
  /** Queues the index rows of one processed content into the job batch; for prepared states large files commit part of the batch early to bound memory. */
  private writeRows(key: string, result: TextIndexResult, commitEarly = true) {
    const insertChunk = this.db.prepare('INSERT INTO chunks (content, start_line, text) VALUES (?,?,?)');
    const insertRef = this.db.prepare('INSERT INTO chunk_refs (content, chunk_rowid) VALUES (?,?)');
    const insertOffset = this.db.prepare('INSERT OR REPLACE INTO line_index VALUES (?,?,?)');
    const insertSection = this.db.prepare('INSERT OR REPLACE INTO sections VALUES (?,?,?)');
    const commit = () => {
      if (!commitEarly || this.batch.length < 4000) return;
      const work = this.batch; this.batch = [];
      this.registry.tx(() => { for (const write of work) write(); });
    };
    for (const [line, offset] of result.offsets) { this.batch.push(() => insertOffset.run(key, line, offset)); commit(); }
    for (const [start, text] of result.chunks) {
      this.batch.push(() => insertRef.run(key, insertChunk.run(key, start, text).lastInsertRowid));
      commit();
    }
    for (const [line, label] of result.sections) { this.batch.push(() => insertSection.run(key, line, label)); commit(); }
  }
}
