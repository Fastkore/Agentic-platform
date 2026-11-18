import { Sha256 } from '../shared/sha256';
import { excluded, pathProblem, suspiciousSecret, type ManifestEntry, type OperationMode, type OperationSummary, type UploadFileStatus } from '../shared/library';

export type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export interface ScannedFile { path: string; file: File; size: number; sha256?: string; secretFindings?: string[] }
export interface ScanResult {
  root: string; files: ScannedFile[]; excluded: { path: string; rule: string }[]; problems: { path: string; problem: string }[];
  secrets: ScannedFile[]; bytes: number; types: Record<string, number>; topFolders: Record<string, number>;
}
const textLike = /\.(cs|vb|ts|tsx|js|jsx|json|xml|config|ini|yml|yaml|env|txt|md|sql|ps1|sh|properties|settings|cshtml|razor|py|java)$/i;

async function readLocalFile(item: ScannedFile, start: number, end: number) {
  try {
    const bytes = await item.file.slice(start, end).arrayBuffer();
    if (bytes.byteLength !== Math.min(end, item.size) - start) throw new Error('Размер файла изменился.');
    return bytes;
  } catch (cause) {
    throw new Error(`Не удалось прочитать файл «${item.path}». Проверьте, что он доступен и не меняется во время загрузки.`, { cause });
  }
}

/** True where the browser can pick a whole folder with relative paths (Chromium-based browsers). */
export function directoryPickerSupported() {
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
}
/** Builds the file list from <input webkitdirectory>. Absolute paths never leave the browser. */
export function collect(list: FileList, rules: string[], limits: { maxFileBytes: number; maxPathLength: number; maxDepth: number }, target?: { prefix: string }): ScanResult {
  const files: ScannedFile[] = [], skipped: ScanResult['excluded'] = [], problems: ScanResult['problems'] = [];
  let root = '';
  const types: Record<string, number> = {}, topFolders: Record<string, number> = {};
  let bytes = 0;
  for (const file of Array.from(list)) {
    // Folder selection: the chosen folder itself is the root. Single files ("Добавить файлы"): the name inside the optional target folder.
    const relative = (target ? file.name : file.webkitRelativePath || file.name).replaceAll('\\', '/');
    const slash = target ? -1 : relative.indexOf('/');
    root ||= slash > 0 ? relative.slice(0, slash) : '';
    const name = slash > 0 ? relative.slice(slash + 1) : relative;
    const path = ((target?.prefix ? target.prefix.replace(/^\/+|\/+$/g, '') + '/' : '') + name).normalize('NFC');
    const rule = excluded(path, rules);
    if (rule) { skipped.push({ path, rule }); continue; }
    const problem = pathProblem(path, limits);
    if (problem) { problems.push({ path, problem }); continue; }
    if (file.size > limits.maxFileBytes) { problems.push({ path, problem: 'too_large' }); continue; }
    files.push({ path, file, size: file.size });
    bytes += file.size;
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '—';
    types[ext] = (types[ext] ?? 0) + 1;
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : '(корень)';
    topFolders[top] = (topFolders[top] ?? 0) + 1;
  }
  const keys = new Map<string, string>();
  for (const f of files) {
    const key = f.path.toLocaleLowerCase('en-US');
    const other = keys.get(key);
    if (other) problems.push({ path: f.path, problem: 'collision:' + other });
    else keys.set(key, f.path);
  }
  const colliding = new Set(problems.filter(p => p.problem.startsWith('collision:')).flatMap(p => [p.path, p.problem.slice(10)]));
  const kept = files.filter(f => !colliding.has(f.path));
  return { root, files: kept, excluded: skipped, problems, secrets: [], bytes: kept.reduce((s, f) => s + f.size, 0) || bytes, types, topFolders };
}
/** Hashes every file in parts and checks the same leading sample the server checks. */
export async function hashFiles(scan: ScanResult, partBytes: number, progress: (done: number, total: number) => void, signal: AbortSignal) {
  let done = 0;
  for (const item of scan.files) {
    signal.throwIfAborted();
    const hash = new Sha256();
    const sampleLimit = item.size <= 1024 * 1024 && textLike.test(item.path) ? 1024 * 1024 : 256 * 1024;
    const sample = new Uint8Array(await readLocalFile(item, 0, sampleLimit));
    const decoder = new TextDecoder();
    const serverSample = sample.subarray(0, 256 * 1024);
    const findings = new Set(!serverSample.includes(0) ? suspiciousSecret(decoder.decode(serverSample)) : []);
    if (!sample.includes(0) && sample.length > serverSample.length) for (const found of suspiciousSecret(decoder.decode(sample))) findings.add(found);
    item.secretFindings = findings.size ? [...findings] : undefined;
    for (let offset = 0; offset < item.size || offset === 0; offset += partBytes) {
      signal.throwIfAborted();
      const chunk = new Uint8Array(await readLocalFile(item, offset, offset + partBytes));
      hash.update(chunk);
      done += chunk.length;
      progress(done, scan.bytes);
      if (item.size === 0) break;
    }
    item.sha256 = hash.digest();
  }
  scan.secrets = scan.files.filter(f => f.secretFindings?.length);
}
export interface UploadOptions { mode: OperationMode; exclusions: string[]; includeSecrets: Set<string> }
interface SavedUpload { operationId: string; mode: OperationMode; manifestHash?: string; options?: Omit<UploadOptions, 'includeSecrets'> & { includeSecrets: string[] } }
const storageKey = (folderId: string) => 'bridge-library-upload:' + folderId;
export function pendingUpload(folderId: string): SavedUpload | undefined {
  try { const value = localStorage.getItem(storageKey(folderId)); return value ? JSON.parse(value) : undefined; } catch { return undefined; }
}
function rememberUpload(folderId: string, value?: SavedUpload) {
  try { if (value) localStorage.setItem(storageKey(folderId), JSON.stringify(value)); else localStorage.removeItem(storageKey(folderId)); } catch { /* storage unavailable */ }
}
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

const base = (folderId: string) => `/api/library/${encodeURIComponent(folderId)}/operations`;
type Status = { operation: OperationSummary; files: (UploadFileStatus & { secretFindings?: string[]; secretDecision?: string; failure?: string })[]; next?: number };
/** Creates the operation and sends the file list. Returns the server status with changes and reuse counts for confirmation. */
export async function prepareUpload(request: Request, folderId: string, scan: ScanResult, options: UploadOptions, resumeId?: string) {
  const files = scan.files.filter(f => !f.secretFindings?.length || options.includeSecrets.has(f.path));
  const manifest = new Sha256();
  const encoder = new TextEncoder();
  for (const file of files) manifest.update(encoder.encode(JSON.stringify([file.path, file.size, file.sha256, file.secretFindings]) + '\n'));
  const manifestHash = manifest.digest();
  const saved = resumeId ? pendingUpload(folderId) : undefined;
  if (saved?.operationId === resumeId && saved?.manifestHash && saved.manifestHash !== manifestHash) {
    throw new Error('Состав выбранной папки изменился. Отмените незавершённую загрузку и начните новую.');
  }
  const operation = resumeId ? { id: resumeId } : await request<OperationSummary>(base(folderId), { method: 'POST', body: JSON.stringify({
    idempotencyKey: key(), mode: options.mode, totalFiles: files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), exclusions: options.exclusions,
  }) });
  rememberUpload(folderId, { operationId: operation.id, mode: options.mode, manifestHash, options: { ...options, includeSecrets: [...options.includeSecrets] } });
  const url = `${base(folderId)}/${operation.id}`;
  const pageSize = 1000;
  for (let page = 0; page * pageSize < files.length; page++) {
    const entries: (ManifestEntry & { secretFindings?: string[] })[] = files.slice(page * pageSize, (page + 1) * pageSize)
      .map(f => ({ path: f.path, size: f.size, sha256: f.sha256!, ...(f.secretFindings?.length ? { secretFindings: f.secretFindings } : {}) }));
    await request(`${url}/manifest`, { method: 'PUT', body: JSON.stringify({ page, last: (page + 1) * pageSize >= files.length, entries }) });
  }
  const status = await request<Status>(url);
  if (status.operation.status === 'unchanged') rememberUpload(folderId);
  if (options.includeSecrets.size && status.operation.status === 'open') {
    let page = status;
    for (;;) {
      for (const file of page.files) if (file.secretFindings?.length && !file.secretDecision && options.includeSecrets.has(file.path)) {
        await request(`${url}/files/${file.fileId}/secret-decision`, { method: 'POST', body: '{}' });
      }
      if (page.next === undefined) break;
      page = await request<Status>(`${url}?cursor=${page.next}`);
    }
  }
  return status;
}
/** Transfers missing parts with bounded concurrency. Safe to call again after a disconnect with a re-picked folder. */
export async function transferUpload(request: Request, folderId: string, operationId: string, scan: ScanResult, progress: (summary: OperationSummary) => void, signal: AbortSignal,
  concurrency = 3) {
  const url = `${base(folderId)}/${operationId}`;
  const byPath = new Map(scan.files.map(f => [f.path, f]));
  let cursor = -1;
  for (;;) {
    signal.throwIfAborted();
    const status = await request<Status>(`${url}?cursor=${cursor}`);
    progress(status.operation);
    if (!status.operation.manifestComplete) throw new Error('Список файлов не отправлен полностью. Подготовьте загрузку заново.');
    const tasks: (() => Promise<void>)[] = [];
    for (const file of status.files) {
      const local = byPath.get(file.path);
      if (!local) throw new Error(`Файл «${file.path}» не найден в выбранной папке. Выберите ту же папку или начните новую загрузку.`);
      if (local.size !== file.size || (local.sha256 && local.sha256 !== file.sha256)) throw new Error(`Файл «${file.path}» изменился после проверки. Начните новую загрузку.`);
      for (let part = 1; part <= file.partsTotal; part++) {
        if (file.partsReceived.includes(part)) continue;
        tasks.push(async () => {
          const start = (part - 1) * status.operation.partBytes;
          signal.throwIfAborted();
          const body = await readLocalFile(local, start, start + status.operation.partBytes);
          const digest = new Sha256().update(new Uint8Array(body)).digest();
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            try {
              await request(`${url}/files/${file.fileId}/parts/${part}`, { method: 'PUT', body, signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': digest } });
              return;
            } catch (error) {
              signal.throwIfAborted();
              const status = (error as { status?: number }).status;
              if (attempt < 4 && (status === 429 || status === 503 || status === undefined)) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
              throw error;
            }
          }
        });
      }
    }
    let index = 0;
    let failure: { cause: unknown } | undefined;
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (!failure && index < tasks.length) {
        try { await tasks[index++](); } catch (cause) { failure ??= { cause }; }
      }
    }));
    if (failure) throw failure.cause;
    if (status.next === undefined) {
      const after = await request<Status>(`${url}?cursor=-1`);
      progress(after.operation);
      if (!after.files.length) return after.operation;
      if (after.files.every(f => f.state === 'failed')) throw new Error('Часть файлов не прошла проверку на сервере: ' + after.files.slice(0, 3).map(f => f.path).join(', '));
      cursor = -1;
      continue;
    }
    cursor = status.next;
  }
}
export async function completeUpload(request: Request, folderId: string, operationId: string) {
  const result = await request<OperationSummary>(`${base(folderId)}/${operationId}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey: 'complete-' + operationId.slice(0, 18) }) });
  rememberUpload(folderId);
  return result;
}
export async function cancelUpload(request: Request, folderId: string, operationId: string) {
  await request(`${base(folderId)}/${operationId}/cancel`, { method: 'POST', body: '{}' });
  rememberUpload(folderId);
}
export function forgetUpload(folderId: string) { rememberUpload(folderId); }
export const formatBytes = (n: number) => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КиБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МиБ' : (n / 1073741824).toFixed(2) + ' ГиБ';
