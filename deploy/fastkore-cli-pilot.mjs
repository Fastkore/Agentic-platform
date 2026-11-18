import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandCatalog, commandArguments, jobDirectory } from './fastkore-cli-commands.mjs';
import { CliProcessPool } from './cli-process-pool.mjs';
import { readCommandOptions } from './fastkore-cli-reads.mjs';
import { runCliProcess } from './fastkore-cli-output.mjs';

const socket = '/run/fastkore-cli/pilot.sock';
const serverAddress = process.env.FASTKORE_SERVER;
const caFile = process.env.FASTKORE_CA_FILE;
const erp = new URL(serverAddress);
if (erp.protocol !== 'grpc:' || !erp.hostname || !erp.port || erp.username || erp.password ||
  erp.pathname || erp.search || erp.hash || !caFile) throw new Error('Invalid Fastkore CLI TLS configuration');
const trust = { authority: erp.host, caFingerprint: new X509Certificate(await readFile(caFile)).fingerprint256 };
const cliEnv = {
  PATH: process.env.PATH, HOME: '/tmp', XDG_DATA_HOME: '/tmp/.local/share',
  FASTKORE_SERVER: serverAddress, FASTKORE_TLS: 'true', FASTKORE_CA_FILE: caFile,
};
const cli = '/usr/local/bin/fastkore-cli';
const cliOptions = { env: cliEnv, timeout: 90_000, killSignal: 'SIGKILL' };
const stdoutLimitBytes = Number(process.env.BRIDGE_FASTKORE_CLI_STDOUT_MAX_BYTES ?? 8 * 1024 * 1024);
if (!Number.isSafeInteger(stdoutLimitBytes) || stdoutLimitBytes < 1 || stdoutLimitBytes > 16 * 1024 * 1024) {
  throw new Error('BRIDGE_FASTKORE_CLI_STDOUT_MAX_BYTES must be an integer from 1 to 16777216');
}
const capabilitiesArgs = ['agent', 'capabilities', '--json'];
const capabilities = await promisify(execFile)(cli, capabilitiesArgs, { ...cliOptions, maxBuffer: stdoutLimitBytes })
  .then(({ stdout }) => JSON.parse(stdout))
  .catch(() => { throw new Error('Fastkore CLI failed its offline startup check'); });
if (capabilities?.success !== true || capabilities.exitCode !== 0 ||
  capabilities.data?.schema !== 'fastkore-cli-capabilities/v1' ||
  !Array.isArray(capabilities.data.commands) ||
  !['auth info', 'data get', 'data query'].every(name => capabilities.data.commands.some(command => command?.name === name))) {
  throw new Error('Fastkore CLI package does not provide the required command catalog');
}

const catalog = commandCatalog(capabilities.data.commands);
const hasOption = (command, flag) => {
  const entry = catalog.get(command);
  return !!entry && [...entry.required, ...entry.optional].some(value => value.split(/\s+/).includes(flag));
};
Object.assign(trust, {
  contextPaging: hasOption('data query', '--context') && hasOption('data query', '--page-size') && hasOption('data query', '--after'),
  batchGet: hasOption('data get', '--entities'),
});
const jobsRoot = process.env.BRIDGE_CODEX_JOB_FILES;
const old = await lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (old) {
  if (!old.isSocket()) throw new Error('Pilot socket path is occupied');
  await unlink(socket);
}

const pool = new CliProcessPool(Number(process.env.BRIDGE_FASTKORE_CLI_CONCURRENCY ?? 4));
const commands = new Map([
  ['/describe/data-get', ['agent', 'describe', 'data get', '--json']],
  ['/describe/data-query', ['agent', 'describe', 'data query', '--json']],
]);

const ticketPattern = /^fkct1\.[A-Za-z0-9._-]{1,4096}$(?![\s\S])/;

async function readCommand(req) {
  if (req.headers['content-type'] !== 'application/json') return;
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 384 * 1024) return;
  }
  const input = JSON.parse(body);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { operation, ticket, authority, caFingerprint, ...args } = input;
  if (authority !== trust.authority || caFingerprint !== trust.caFingerprint ||
    typeof ticket !== 'string' || !ticketPattern.test(ticket)) return;
  if (operation === 'execute' && Object.keys(args).every(key => ['command', 'args', 'workDirectoryId', 'context'].includes(key)) && jobsRoot) {
    const cwd = await jobDirectory(jobsRoot, args.workDirectoryId);
    const argv = await commandArguments(catalog, args.command, args.args, cwd);
    const contextPath = join(cwd, 'context.json');
    const usesContext = argv.some((value, index) => value === '--context' && argv[index + 1] === contextPath);
    if (usesContext && (!args.context || args.context.type !== 'fastkore.context' || args.context.version !== 1)) return;
    return { argv, ticket, cwd, context: usesContext ? args.context : undefined, contextPath: usesContext ? contextPath : undefined };
  }
  if ((operation === 'page' && !trust.contextPaging) || (operation === 'get-many' && !trust.batchGet)) return { unsupported: true };
  const command = readCommandOptions(operation, args, trust);
  if (command) return { ...command, ticket };
}

function json(text) { try { return JSON.parse(text); } catch { return undefined; } }

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, value) => res.writeHead(status).end(JSON.stringify(value));
  if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true, active: pool.active, concurrency: pool.limit }); return; }
  if (req.method === 'GET' && req.url === '/trust') { send(200, trust); return; }
  if (req.method === 'GET' && req.url === '/capabilities') { send(200, { ok: true, authenticated: false, capabilities }); return; }
  let read;
  if (req.method === 'POST' && req.url === '/read') {
    try { read = await readCommand(req); } catch { /* A malformed payload never starts a process. */ }
    if (!read) { send(400, {}); return; }
    if (read.unsupported) { send(422, {}); return; }
  }
  let describe;
  if (req.method === 'GET' && req.url?.startsWith('/command-description?')) {
    const name = new URL(req.url, 'http://localhost').searchParams.get('name');
    if (typeof name === 'string' && /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(name)) describe = ['agent', 'describe', name, '--json'];
  }
  const args = read?.argv ?? describe ?? (req.method === 'GET' ? commands.get(req.url) : undefined);
  if (!args) { send(404, {}); return; }
  const slot = pool.acquire();
  if (!slot) { send(429, { error: 'Fastkore CLI concurrency limit reached' }); return; }
  const stop = slot.controller;
  res.once('close', () => { if (!res.writableEnded) stop.abort(); });
  if (res.destroyed) stop.abort();
  let snapshotDir;
  async function dispose() {
    if (snapshotDir) {
      await unlink(join(snapshotDir, 'context.json')).catch(() => {});
      await rmdir(snapshotDir).catch(() => {});
    }
    slot.release();
  }
  try {
    if (read?.context) {
      snapshotDir = await mkdtemp('/tmp/fastkore-context-');
      const file = join(snapshotDir, 'context.json');
      await writeFile(file, JSON.stringify(read.context), { mode: 0o400, flag: 'wx' });
      if (read.contextPath) {
        for (let index = 0; index < args.length - 1; index++) if (args[index] === '--context' && args[index + 1] === read.contextPath) args[index + 1] = file;
      } else args.push('--context', file);
    }
    stop.signal.throwIfAborted();
  } catch {
    await dispose();
    if (!res.destroyed) send(502, {});
    return;
  }
  const processStarted = performance.now();
  try {
      const { exitCode, stdout, stderr } = await runCliProcess(cli, args, { ...cliOptions, cwd: read?.cwd, signal: stop.signal }, read?.ticket, stdoutLimitBytes);
      if (res.destroyed) return;
      res.setHeader('X-Fastkore-Cli-Process-Ms', String(Math.round(performance.now() - processStarted)));
      if (stdout.bytes > stdoutLimitBytes) {
        const error = { code: 'cli_stdout_too_large', actualBytes: stdout.bytes, limitBytes: stdoutLimitBytes };
        send(read ? 200 : 413, { success: exitCode === null ? null : exitCode === 0, exitCode, error });
        return;
      }
      if (exitCode !== 0) {
        if (!read || exitCode === null || exitCode < 1 || exitCode > 5) throw new Error();
        const reported = json(stdout.text) ?? json(stderr.text);
        if (reported?.exitCode !== undefined && reported.exitCode !== exitCode) throw new Error();
        send(200, { success: false, exitCode, data: reported });
        return;
      }
      const parsed = JSON.parse(stdout.text);
      if (read) {
        if (parsed.success !== true || parsed.exitCode !== 0 || !Object.hasOwn(parsed, 'data')) throw new Error();
        send(200, { success: true, exitCode: 0, data: parsed.data });
        return;
      }
      if (parsed.success !== true || !parsed.data?.name) throw new Error('Unexpected CLI contract');
      const { name, purpose, operation, required, optional, returns } = parsed.data;
      send(200, { ok: true, authenticated: false,
        contract: { name, purpose, operation, required, optional, returns } });
  } catch {
    if (!res.destroyed) send(502, {});
  } finally { await dispose(); }
});
server.listen(socket, async () => { await chmod(socket, 0o660); });
process.once('SIGTERM', () => { pool.abortAll(); server.close(); });
