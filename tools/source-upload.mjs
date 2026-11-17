#!/usr/bin/env node
/**
 * Fastkore Agent Platform · local upload utility for project sources (second client of the same upload API).
 *
 *   node source-upload.mjs --server https://agents.example --source src_… --label 27.0.48 [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--base snp_…] [--exclude RULE]… [--include-secret PATH]… [--dry-run] [--wait] [--report report.json] [--state state.json]
 *        [--token-file token.txt] [--new-session] <folder>
 *
 * The token is a short-lived source upload token («Настройки → Источники → источник → Токен для утилиты»). It is read from the
 * FASTKORE_SOURCES_TOKEN environment variable or --token-file and never accepted as an argument or printed.
 * The utility never follows symlinks, junctions or reparse points and never leaves the selected folder. The server re-checks every path,
 * size and hash; this client is not trusted. It only opens the folder given on the command line.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Same list as shared/sources.ts defaultExclusions (checked by tests). */
export const DEFAULT_EXCLUSIONS = [
  '.git/', '.svn/', '.hg/', 'node_modules/', 'bin/', 'obj/', '.vs/', '.idea/', '__pycache__/', '.cache/', 'packages/',
  '.gradle/', '.pytest_cache/', '.mypy_cache/', '.next/', '.nuxt/', '.output/', 'dist/', 'build/', 'out/', 'target/', 'artifacts/', 'coverage/', 'TestResults/',
  '*.dll', '*.exe', '*.pdb', '*.so', '*.so.*', '*.dylib', '*.a', '*.lib', '*.o', '*.obj', '*.class', '*.pyc', '*.pyo', '*.wasm',
  '*.nupkg', '*.nupkg.sha512', '.nupkg.metadata', '.signature.p7s', '*.snupkg', '*.jar', '*.war', '*.ear', '*.whl', '*.msi', '*.msix', '*.appx', '*.deb', '*.rpm',
  '*.tsbuildinfo', '*.js.map', '*.mjs.map', '*.cjs.map', '*.css.map', '*.suo', '*.csproj.user', '*.vbproj.user',
  '*.tmp', '*.temp', '~$*', '*.swp', 'Thumbs.db', '.DS_Store',
  '.env', '.env.*', '*.pfx', '*.p12', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.kdbx',
  '*.bak', '*.backup', '*.zip', '*.7z', '*.rar', '*.tar', '*.gz',
];
const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['token', /\b(?:ghp|gho|github_pat|glpat|xox[bpas])[-_][A-Za-z0-9_]{16,}/],
  ['api_key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['password_assignment', /(?:password|passwd|pwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['connection_string', /(?:Password|Pwd)\s*=\s*[^;"'\s]{6,}\s*;/i],
];
const TEXT_LIKE = /\.(cs|vb|ts|tsx|js|jsx|json|xml|config|ini|yml|yaml|env|txt|md|sql|ps1|sh|properties|settings|cshtml|razor|py|java)$/i;

export function excludedBy(relPath, rules) {
  const segments = relPath.split('/'), name = segments.at(-1);
  for (const rule of rules) {
    if (rule.endsWith('/')) { const dir = rule.slice(0, -1).toLowerCase(); if (segments.slice(0, -1).some(s => s.toLowerCase() === dir)) return rule; continue; }
    const pattern = new RegExp('^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    if (rule.includes('/') ? pattern.test(relPath) : pattern.test(name)) return rule;
  }
  return undefined;
}
function pathProblem(p) {
  if (!p || p.length > 1024) return 'length';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return 'control';
  if (p.split('/').length > 64) return 'too_deep';
  if (p.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s))) return 'segment';
  return undefined;
}
async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Scans the folder: no symlink/junction/reparse point is followed, nothing outside the root is read. */
export async function scan(root, { exclusions = DEFAULT_EXCLUSIONS, maxFileBytes = 100 * 1024 * 1024, includeSecrets = [] } = {}) {
  const base = await realpath(root);
  const files = [], skipped = [], keys = new Map();
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relPath = ((rel ? rel + '/' : '') + entry.name).normalize('NFC');
      const absolute = path.join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { skipped.push({ path: relPath, reason: 'symlink' }); continue; }
      if (info.isDirectory()) {
        const rule = excludedBy(relPath + '/x', exclusions);
        if (rule) { skipped.push({ path: relPath + '/', reason: 'excluded:' + rule }); continue; }
        const real = await realpath(absolute);
        if (real !== base && !real.startsWith(base + path.sep)) { skipped.push({ path: relPath, reason: 'outside_root' }); continue; }
        await walk(absolute, relPath);
        continue;
      }
      if (!info.isFile()) { skipped.push({ path: relPath, reason: 'special' }); continue; }
      const rule = excludedBy(relPath, exclusions);
      if (rule) { skipped.push({ path: relPath, reason: 'excluded:' + rule }); continue; }
      const problem = pathProblem(relPath);
      if (problem) { skipped.push({ path: relPath, reason: problem }); continue; }
      if (info.size > maxFileBytes) { skipped.push({ path: relPath, reason: 'too_large' }); continue; }
      const key = relPath.toLocaleLowerCase('en-US');
      if (keys.has(key)) { skipped.push({ path: relPath, reason: 'case_collision:' + keys.get(key) }); continue; }
      keys.set(key, relPath);
      const sampleLimit = info.size <= 1024 * 1024 && TEXT_LIKE.test(relPath) ? 1024 * 1024 : 256 * 1024;
      const handle = await open(absolute, 'r');
      let sample;
      try {
        const bytes = Buffer.alloc(Math.min(info.size, sampleLimit));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        sample = bytes.subarray(0, bytesRead);
      } finally { await handle.close(); }
      const serverSample = sample.subarray(0, 256 * 1024);
      const samples = [serverSample, ...(sample.length > serverSample.length ? [sample] : [])].filter(data => !data.includes(0)).map(data => data.toString('utf8'));
      const found = SECRET_PATTERNS.filter(([, re]) => samples.some(text => re.test(text))).map(([id]) => id);
      const secretFindings = found.length ? found : undefined;
      if (secretFindings && !includeSecrets.includes(relPath)) { skipped.push({ path: relPath, reason: 'secret:' + secretFindings.join(',') }); continue; }
      files.push({ path: relPath, absolute, size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256File(absolute), secretFindings });
    }
  }
  await walk(base, '');
  const manifestHash = createHash('sha256').update(files.map(f => `${f.path}\0${f.size}\0${f.sha256}\n`).join('')).digest('hex');
  return { root: base, files, skipped, bytes: files.reduce((s, f) => s + f.size, 0), manifestHash };
}

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
function client(server, token) {
  const origin = new URL(server).origin;
  return async function request(method, url, body, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(origin + url, { method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
          headers: { authorization: 'Bearer ' + token, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers } });
      } catch {
        if (attempt < 5) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
        throw new ApiError('Сервер недоступен.', 0);
      }
      if ((response.status === 429 || response.status === 503) && attempt < 6) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
      const text = await response.text();
      let value; try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
      if (!response.ok) throw new ApiError(value?.error ?? `HTTP ${response.status}`, response.status);
      return value;
    }
  };
}
const defaultState = (sourceId, root) => path.join(os.tmpdir(), 'fastkore-source-upload-' + createHash('sha256').update(sourceId + '\0' + root).digest('hex').slice(0, 16) + '.json');

/** Runs dry-run or upload. Returns the report object (also written to --report). */
export async function run(options) {
  const exclusions = [...DEFAULT_EXCLUSIONS, ...(options.exclude ?? [])];
  const scanned = await scan(options.folder, { exclusions, includeSecrets: options.includeSecret ?? [] });
  const report = { root: path.basename(scanned.root), files: scanned.files.length, bytes: scanned.bytes, manifestHash: scanned.manifestHash,
    skipped: scanned.skipped, secretsIncluded: scanned.files.filter(f => f.secretFindings).map(f => f.path) };
  if (options.dryRun) return { ...report, dryRun: true };
  if (!scanned.files.length) throw new Error('Нет файлов для загрузки.');
  const request = client(options.server, options.token);
  const statePath = options.state ?? defaultState(options.source, scanned.root);
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = undefined; }
  if (state && (state.source !== options.source || (options.label && state.label !== options.label)
    || !!state.update !== !!options.update || state.manifestHash !== scanned.manifestHash)) {
    if (!options.newSession) throw new Error('Есть незавершённая загрузка с другим содержимым или версией. Запустите с --new-session, чтобы начать заново.');
    state = undefined;
  }
  const base = `/api/admin/sources/${encodeURIComponent(options.source)}/uploads`;
  if (!state) {
    const label = options.label ?? 'Обновление ' + new Date().toISOString().slice(0, 23).replace('T', ' ') + ' UTC';
    const upload = await request('POST', base, { idempotencyKey: 'cli' + randomBytes(12).toString('hex'), label, validFrom: options.from, validTo: options.to,
      baseSnapshotId: options.base, totalFiles: scanned.files.length, totalBytes: scanned.bytes, exclusions, skipUnchanged: !!options.update });
    state = { source: options.source, label, update: !!options.update, manifestHash: scanned.manifestHash, uploadId: upload.id, pages: 0 };
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  const uploadBase = `${base}/${state.uploadId}`;
  const pageSize = 1000;
  for (let page = state.pages; page * pageSize < scanned.files.length; page++) {
    const entries = scanned.files.slice(page * pageSize, (page + 1) * pageSize).map(f => ({ path: f.path, size: f.size, sha256: f.sha256, ...(f.secretFindings ? { secretFindings: f.secretFindings } : {}) }));
    await request('PUT', uploadBase + '/manifest', { page, last: (page + 1) * pageSize >= scanned.files.length, entries });
    state.pages = page + 1;
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  const byPath = new Map(scanned.files.map(f => [f.path, f]));
  let sent = 0, sentBytes = 0;
  for (let round = 0; round < 3; round++) {
    let cursor = -1, pending = 0;
    for (;;) {
      const status = await request('GET', `${uploadBase}?cursor=${cursor}`);
      const tasks = [];
      for (const file of status.files) {
        const local = byPath.get(file.path);
        if (!local) throw new Error('Файл из манифеста не найден: ' + file.path);
        if (file.secretFindings && !file.secretDecision) {
          if (!options.includeSecret?.includes(file.path)) throw new Error('Сервер обнаружил возможный секрет в файле «' + file.path + '». Исключите его или явно укажите --include-secret для этого файла.');
          await request('POST', `${uploadBase}/files/${file.fileId}/secret-decision`, {});
        }
        pending++;
        for (let part = 1; part <= file.partsTotal; part++) {
          if (file.partsReceived.includes(part)) continue;
          tasks.push(async () => {
            const info = await lstat(local.absolute);
            if (info.size !== local.size || info.mtimeMs !== local.mtimeMs) throw new Error('Файл изменился во время загрузки: ' + local.path + '. Запустите с --new-session.');
            const handle = await open(local.absolute);
            try {
              const start = (part - 1) * status.upload.partBytes, length = Math.min(status.upload.partBytes, local.size - start);
              const buffer = Buffer.alloc(length);
              await handle.read(buffer, 0, length, start);
              await request('PUT', `${uploadBase}/files/${file.fileId}/parts/${part}`, buffer,
                { 'content-type': 'application/octet-stream', 'x-content-sha256': createHash('sha256').update(buffer).digest('hex') });
              sent++; sentBytes += length;
              options.progress?.({ parts: sent, bytes: sentBytes, total: scanned.bytes });
            } finally { await handle.close(); }
          });
        }
      }
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, tasks.length) }, async () => { while (index < tasks.length) await tasks[index++](); }));
      if (status.next === undefined) break;
      cursor = status.next;
    }
    if (!pending) break;
  }
  const completed = await request('POST', uploadBase + '/complete', { idempotencyKey: 'cli-complete-' + state.uploadId.slice(0, 18) });
  let snapshotState = completed.snapshotState;
  if (options.wait) {
    for (let i = 0; i < 720 && !['ready', 'failed'].includes(snapshotState); i++) {
      await new Promise(r => setTimeout(r, options.pollMs ?? 5000));
      snapshotState = (await request('GET', uploadBase)).upload.snapshotState;
    }
  }
  try { await import('node:fs/promises').then(fs => fs.rm(statePath, { force: true })); } catch { /* state cleanup is best-effort */ }
  return { ...report, uploadId: state.uploadId, snapshotId: completed.snapshotId, snapshotState, unchanged: !!completed.unchanged, partsSent: sent, bytesSent: sentBytes, reused: completed.files.reused };
}

function parse(argv) {
  const out = { exclude: [], includeSecret: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('Нет значения для ' + a); return argv[++i]; };
    if (a === '--server') out.server = next(); else if (a === '--source') out.source = next(); else if (a === '--label') out.label = next();
    else if (a === '--from') out.from = next(); else if (a === '--to') out.to = next(); else if (a === '--base') out.base = next();
    else if (a === '--exclude') out.exclude.push(next()); else if (a === '--include-secret') out.includeSecret.push(next());
    else if (a === '--report') out.report = next(); else if (a === '--state') out.state = next(); else if (a === '--token-file') out.tokenFile = next();
    else if (a === '--dry-run') out.dryRun = true; else if (a === '--wait') out.wait = true; else if (a === '--new-session') out.newSession = true;
    else if (a === '--update') out.update = true;
    else if (a === '--token') throw new Error('Токен не передаётся аргументом: используйте FASTKORE_SOURCES_TOKEN или --token-file.');
    else if (a.startsWith('--')) throw new Error('Неизвестный параметр ' + a);
    else if (!out.folder) out.folder = a; else throw new Error('Укажите одну папку.');
  }
  return out;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (!options.folder || (!options.dryRun && (!options.server || !options.source || (!options.label && !options.update)))) {
    console.error('Использование: node source-upload.mjs --server URL --source src_… [--update] [--label ВЕРСИЯ] [--from ДАТА] [--to ДАТА] [--base snp_…] [--exclude ПРАВИЛО] [--dry-run] [--wait] [--report файл] ПАПКА');
    process.exitCode = 2; return;
  }
  if (!options.dryRun) {
    options.token = options.tokenFile ? (await readFile(options.tokenFile, 'utf8')).trim() : process.env.FASTKORE_SOURCES_TOKEN;
    if (!options.token) { console.error('Задайте токен в FASTKORE_SOURCES_TOKEN или --token-file.'); process.exitCode = 2; return; }
  }
  let last = 0;
  options.progress = p => { if (Date.now() - last > 1000) { last = Date.now(); process.stderr.write(`\rПередано ${(p.bytes / 1048576).toFixed(1)} из ${(p.total / 1048576).toFixed(1)} МиБ`); } };
  const result = await run(options);
  if (options.report) await writeFile(options.report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, skipped: result.skipped.length, skippedSample: result.skipped.slice(0, 20) }, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error('Ошибка: ' + error.message); process.exitCode = 1; });
