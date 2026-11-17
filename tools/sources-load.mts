/**
 * Load test of project sources (AC14). Not part of `npm test`.
 *   npx tsx tools/sources-load.mts --files 50000 --gib 10 --uploads 5 --work /data/load
 * Starts the platform in a child process with filesystem or S3 source storage (BRIDGE_SOURCES_* from the environment),
 * generates a deterministic corpus, uploads it through the local utility over HTTP (one full upload and N-1 parallel smaller ones by
 * separate fixture users), measures re-upload, resume, indexing,
 * search/read p50/p95 with 5 parallel readers, and peak RSS of the server. Prints a JSON report.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
// @ts-expect-error plain ESM utility
import { run } from './source-upload.mjs';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : fallback; };
const files = Number(arg('files', '50000')), gib = Number(arg('gib', '10')), uploads = Number(arg('uploads', '5'));
const work = path.resolve(arg('work', path.join(os.tmpdir(), 'sources-load'))), port = Number(arg('port', '8890'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

async function corpus(dir: string, count: number, totalBytes: number) {
  const avg = Math.max(256, Math.floor(totalBytes / count));
  let written = 0;
  for (let i = 0; i < count; i++) {
    const folder = path.join(dir, 'Module' + String(i % 500).padStart(3, '0'), 'Sub' + (i % 7));
    await mkdir(folder, { recursive: true });
    const seed = createHash('sha256').update(String(i)).digest();
    const size = Math.max(128, Math.floor(avg * (0.25 + (seed[0] / 255) * 1.5)));
    const lines: string[] = [`namespace Fastkore.Load.M${i % 500} {`, `  public class Entity${i} {`];
    let length = 0, n = 0;
    while (length < size) {
      const line = `    public decimal Calc${i}_${n}(decimal v) { return v * ${(seed[n % 32] / 10).toFixed(1)}m + Price${(i * 31 + n) % 99991}; }`;
      lines.push(line); length += line.length + 1; n++;
    }
    lines.push('  }', '}');
    const text = lines.join('\n') + '\n';
    written += Buffer.byteLength(text);
    await writeFile(path.join(folder, `Entity${i}.cs`), text);
  }
  return written;
}
async function main() {
  await mkdir(work, { recursive: true });
  const report: Record<string, unknown> = { host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), platform: `${os.platform()} ${os.release()}`, node: process.version },
    target: { files, gib, uploads } };
  const corpusDir = path.join(work, 'corpus');
  let t = process.hrtime.bigint();
  const bytes = await corpus(corpusDir, files, gib * 2 ** 30);
  report.corpus = { files, bytes, generateMs: ms(t) };
  const smallDirs: string[] = [];
  for (let u = 1; u < uploads; u++) { const d = path.join(work, 'small' + u); await corpus(d, Math.max(100, Math.floor(files / 50)), Math.floor(gib * 2 ** 30 / 50)); smallDirs.push(d); }

  const env = { ...process.env, BRIDGE_DATA_DIR: path.join(work, 'data'), PORT: String(port),
    ...(process.env.BRIDGE_SOURCES_S3_BUCKET ? {} : { BRIDGE_SOURCES_STORAGE: 'filesystem', BRIDGE_SOURCES_DIR: path.join(work, 'objects') }) };
  const server = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'tools', 'sources-load-server.mts')], { env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'], cwd: repo });
  let peakRss = 0;
  server.on('message', message => { if (typeof message === 'number') peakRss = Math.max(peakRss, message); });
  await new Promise<void>((resolve, reject) => { server.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('READY')) resolve(); }); server.once('exit', () => reject(new Error('server exited'))); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); if (!r.ok) throw new Error(url + ' ' + r.status + ' ' + text); return text ? JSON.parse(text) : undefined;
  };
  try {
    const boot = await call('POST', '/api/local-login', '', {}, { 'x-bridge-local': '1' });
    const admin = (await call('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Load', password: 'Load-test-password-2026' })).token;
    const sources = await Promise.all(Array.from({ length: uploads }, async (_, i) => (await call('POST', '/api/admin/sources', admin, { name: 'Load ' + i, kind: 'code', classification: 'shared', quotaBytes: 64 * 2 ** 30 })).source));
    const actors = [admin];
    for (let i = 1; i < uploads; i++) {
      const user = { username: `load-user-${i}`, name: `Load ${i}`, password: `Load-test-password-${i}-2026` };
      await call('POST', '/api/users', admin, { ...user, role: 'admin' });
      actors.push((await call('POST', '/api/auth/login', '', { username: user.username, password: user.password })).token);
    }
    const tokens = await Promise.all(sources.map(async (s, i) => (await call('POST', `/api/admin/sources/${s.id}/upload-tokens`, actors[i], { ttlMinutes: 240 })).token));
    // Full upload in parallel with N-1 smaller uploads.
    t = process.hrtime.bigint();
    const timings = await Promise.all([corpusDir, ...smallDirs].map(async (dir, i) => {
      const start = process.hrtime.bigint();
      const result = await run({ folder: dir, server: base, source: sources[i].id, label: 'v1', token: tokens[i], state: path.join(work, `state-${i}.json`) });
      return { files: result.files, bytes: result.bytes, ms: ms(start), snapshotId: result.snapshotId };
    }));
    report.upload = { wallMs: ms(t), sessions: timings };
    // Indexing of the full snapshot.
    t = process.hrtime.bigint();
    for (;;) {
      const snapshots = await call('GET', `/api/admin/sources/${sources[0].id}/snapshots`, admin);
      if (['ready', 'failed'].includes(snapshots[0].state)) { report.indexing = { ms: ms(t), state: snapshots[0].state, indexed: snapshots[0].indexedFiles }; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    // Repeated upload of unchanged content.
    t = process.hrtime.bigint();
    const again = await run({ folder: corpusDir, server: base, source: sources[0].id, label: 'v2', token: tokens[0], state: path.join(work, 'state-again.json') });
    report.reupload = { ms: ms(t), partsSent: again.partsSent, reused: again.reused };
    // Resume after an interruption at ~30% of parts (new content: touch every 10th file).
    for (let i = 0; i < files; i += 10) { const f = path.join(corpusDir, 'Module' + String(i % 500).padStart(3, '0'), 'Sub' + (i % 7), `Entity${i}.cs`); await writeFile(f, (await readFile(f, 'utf8')) + '// changed\n'); }
    let parts = 0;
    t = process.hrtime.bigint();
    const interrupted = new Error('interrupted by load test');
    await run({ folder: corpusDir, server: base, source: sources[0].id, label: 'v3', token: tokens[0], state: path.join(work, 'state-resume.json'), concurrency: 1,
      progress: () => { if (++parts === Math.max(1, Math.floor(files / 10 * 0.3))) throw interrupted; } }).catch((error: unknown) => {
        if (error !== interrupted) throw error;
      });
    const resumed = await run({ folder: corpusDir, server: base, source: sources[0].id, label: 'v3', token: tokens[0], state: path.join(work, 'state-resume.json') });
    report.resume = { ms: ms(t), partsBeforeInterrupt: parts, partsAfterResume: resumed.partsSent };
    // Search/read latency with 5 parallel readers on the warmed index of v1.
    const snapshotId = (timings[0] as { snapshotId: string }).snapshotId;
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => new Promise<{ search: number[]; read: number[] }>((resolve, reject) => {
      const worker = new Worker(new URL('./sources-load-reader.mts', import.meta.url), { workerData: { dataRoot: path.join(work, 'data'), objects: path.join(work, 'objects'), snapshotId, seed: i, files, rounds: 200 },
        env, execArgv: ['--import', 'tsx'] });
      worker.once('message', resolve); worker.once('error', reject);
    })));
    const search = results.flatMap(r => r.search), read = results.flatMap(r => r.read);
    report.latency = { parallelReaders: 5, search: { n: search.length, p50: pct(search, 50), p95: pct(search, 95) }, read: { n: read.length, p50: pct(read, 50), p95: pct(read, 95) } };
    report.serverPeakRssMiB = +(peakRss / 2 ** 20).toFixed(1);
  } finally { server.kill('SIGTERM'); }
  console.log(JSON.stringify(report, null, 2));
  await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
