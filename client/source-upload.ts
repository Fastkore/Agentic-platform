import { Sha256 } from '../shared/sha256';
import { excluded, pathProblem, suspiciousSecret, type ManifestEntry, type UploadFileStatus, type UploadSummary } from '../shared/sources';

export type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export interface ScannedFile { path: string; file: File; size: number; sha256?: string; secretFindings?: string[] }
export interface ScanResult {
  root: string; files: ScannedFile[]; excluded: { path: string; rule: string }[]; problems: { path: string; problem: string }[];
  secrets: ScannedFile[]; bytes: number; types: Record<string, number>; topFolders: Record<string, number>;
}
const textLike = /\.(cs|vb|ts|tsx|js|jsx|json|xml|config|ini|yml|yaml|env|txt|md|sql|ps1|sh|properties|settings|cshtml|razor|py|java)$/i;

/** True where the browser can pick a whole folder with relative paths (Chromium and WebView2). */
export function directoryPickerSupported() {
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
}
/** Builds the file list from <input webkitdirectory>. Absolute paths never leave the browser. */
export function collect(list: FileList, rules: string[], limits: { maxFileBytes: number; maxPathLength: number; maxDepth: number }): ScanResult {
  const files: ScannedFile[] = [], skipped: ScanResult['excluded'] = [], problems: ScanResult['problems'] = [];
  let root = '';
  const types: Record<string, number> = {}, topFolders: Record<string, number> = {};
  let bytes = 0;
  for (const file of Array.from(list)) {
    const relative = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
    const slash = relative.indexOf('/');
    root ||= slash > 0 ? relative.slice(0, slash) : '';
    const path = (slash > 0 ? relative.slice(slash + 1) : relative).normalize('NFC');
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
    const sample = new Uint8Array(await item.file.slice(0, sampleLimit).arrayBuffer());
    const decoder = new TextDecoder();
    const serverSample = sample.subarray(0, 256 * 1024);
    const findings = new Set(!serverSample.includes(0) ? suspiciousSecret(decoder.decode(serverSample)) : []);
    if (!sample.includes(0) && sample.length > serverSample.length) for (const found of suspiciousSecret(decoder.decode(sample))) findings.add(found);
    item.secretFindings = findings.size ? [...findings] : undefined;
    for (let offset = 0; offset < item.size || offset === 0; offset += partBytes) {
      const chunk = new Uint8Array(await item.file.slice(offset, offset + partBytes).arrayBuffer());
      hash.update(chunk);
      done += chunk.length;
      progress(done, scan.bytes);
      if (item.size === 0) break;
    }
    item.sha256 = hash.digest();
  }
  scan.secrets = scan.files.filter(f => f.secretFindings?.length);
}
export interface UploadOptions { label: string; validFrom?: string; validTo?: string; baseSnapshotId?: string; skipUnchanged?: boolean; exclusions: string[]; includeSecrets: Set<string> }
interface SavedUpload { uploadId: string; label: string; manifestHash?: string; options?: Omit<UploadOptions, 'includeSecrets'> & { includeSecrets: string[] } }
const storageKey = (sourceId: string) => 'bridge-source-upload:' + sourceId;
export function pendingUpload(sourceId: string): SavedUpload | undefined {
  try { const value = localStorage.getItem(storageKey(sourceId)); return value ? JSON.parse(value) : undefined; } catch { return undefined; }
}
function rememberUpload(sourceId: string, value?: SavedUpload) {
  try { if (value) localStorage.setItem(storageKey(sourceId), JSON.stringify(value)); else localStorage.removeItem(storageKey(sourceId)); } catch { /* storage unavailable */ }
}
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

/** Creates the session and sends the manifest. Returns server status with diff and reuse counts for confirmation. */
export async function prepareUpload(request: Request, sourceId: string, scan: ScanResult, options: UploadOptions, resumeId?: string) {
  const files = scan.files.filter(f => !f.secretFindings?.length || options.includeSecrets.has(f.path));
  const manifest = new Sha256();
  const encoder = new TextEncoder();
  for (const file of files) manifest.update(encoder.encode(JSON.stringify([file.path, file.size, file.sha256, file.secretFindings]) + '\n'));
  const manifestHash = manifest.digest();
  const saved = resumeId ? pendingUpload(sourceId) : undefined;
  if (saved?.uploadId === resumeId && saved?.manifestHash && saved.manifestHash !== manifestHash) {
    throw new Error('Содержимое выбранной папки изменилось. Отмените незавершённую загрузку и начните новую.');
  }
  const base = `/api/admin/sources/${encodeURIComponent(sourceId)}/uploads`;
  const upload = resumeId ? { id: resumeId } : await request<UploadSummary>(base, { method: 'POST', body: JSON.stringify({
    idempotencyKey: key(), label: options.label, validFrom: options.validFrom || undefined, validTo: options.validTo || undefined, baseSnapshotId: options.baseSnapshotId,
    totalFiles: files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), exclusions: options.exclusions, skipUnchanged: options.skipUnchanged,
  }) });
  rememberUpload(sourceId, { uploadId: upload.id, label: options.label, manifestHash, options: { ...options, includeSecrets: [...options.includeSecrets] } });
  const url = `${base}/${upload.id}`;
  type Status = { upload: UploadSummary; files: (UploadFileStatus & { secretFindings?: string[]; secretDecision?: string })[];
    next?: number; diff?: { added: number; changed: number; removed: number } };
  const pageSize = 1000;
  for (let page = 0; page * pageSize < files.length; page++) {
    const entries: (ManifestEntry & { secretFindings?: string[] })[] = files.slice(page * pageSize, (page + 1) * pageSize)
      .map(f => ({ path: f.path, size: f.size, sha256: f.sha256!, ...(f.secretFindings?.length ? { secretFindings: f.secretFindings } : {}) }));
    await request(`${url}/manifest`, { method: 'PUT', body: JSON.stringify({ page, last: (page + 1) * pageSize >= files.length, entries }) });
  }
  const status = await request<Status>(url);
  if (options.includeSecrets.size) {
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
export async function transferUpload(request: Request, sourceId: string, uploadId: string, scan: ScanResult, progress: (summary: UploadSummary) => void, signal: AbortSignal,
  concurrency = 3) {
  const base = `/api/admin/sources/${encodeURIComponent(sourceId)}/uploads/${uploadId}`;
  const byPath = new Map(scan.files.map(f => [f.path, f]));
  let cursor = -1;
  for (;;) {
    signal.throwIfAborted();
    const status = await request<{ upload: UploadSummary; files: (UploadFileStatus & { failure?: string })[]; next?: number }>(`${base}?cursor=${cursor}`);
    progress(status.upload);
    if (!status.upload.manifestComplete) throw new Error('Список файлов не отправлен полностью. Подготовьте загрузку заново.');
    const tasks: (() => Promise<void>)[] = [];
    for (const file of status.files) {
      const local = byPath.get(file.path);
      if (!local) throw new Error(`Файл «${file.path}» не найден в выбранной папке. Выберите ту же папку или начните новую загрузку.`);
      if (local.size !== file.size || (local.sha256 && local.sha256 !== file.sha256)) throw new Error(`Файл «${file.path}» изменился после проверки. Начните новую загрузку.`);
      for (let part = 1; part <= file.partsTotal; part++) {
        if (file.partsReceived.includes(part)) continue;
        tasks.push(async () => {
          const start = (part - 1) * status.upload.partBytes;
          const body = await local.file.slice(start, start + status.upload.partBytes).arrayBuffer();
          const digest = new Sha256().update(new Uint8Array(body)).digest();
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            try {
              await request(`${base}/files/${file.fileId}/parts/${part}`, { method: 'PUT', body, signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': digest } });
              return;
            } catch (error) {
              const status = (error as { status?: number }).status;
              if (attempt < 4 && (status === 429 || status === 503 || status === undefined)) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
              throw error;
            }
          }
        });
      }
    }
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (index < tasks.length) await tasks[index++]();
    }));
    if (status.next === undefined) {
      const after = await request<{ upload: UploadSummary; files: UploadFileStatus[] }>(`${base}?cursor=-1`);
      progress(after.upload);
      if (!after.files.length) return after.upload;
      if (after.files.every(f => f.state === 'failed')) throw new Error('Часть файлов не прошла проверку на сервере: ' + after.files.slice(0, 3).map(f => f.path).join(', '));
      cursor = -1;
      continue;
    }
    cursor = status.next;
  }
}
export async function completeUpload(request: Request, sourceId: string, uploadId: string) {
  const result = await request<UploadSummary>(`/api/admin/sources/${encodeURIComponent(sourceId)}/uploads/${uploadId}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey: 'complete-' + uploadId.slice(0, 18) }) });
  rememberUpload(sourceId);
  return result;
}
export async function cancelUpload(request: Request, sourceId: string, uploadId: string) {
  await request(`/api/admin/sources/${encodeURIComponent(sourceId)}/uploads/${uploadId}/cancel`, { method: 'POST', body: '{}' });
  rememberUpload(sourceId);
}
export const formatBytes = (n: number) => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КиБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МиБ' : (n / 1073741824).toFixed(2) + ' ГиБ';
