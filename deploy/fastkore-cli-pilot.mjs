import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

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
const cliOptions = { env: cliEnv, timeout: 25_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024 };
const capabilitiesArgs = ['agent', 'capabilities', '--json'];
const capabilities = await promisify(execFile)(cli, capabilitiesArgs, cliOptions)
  .then(({ stdout }) => JSON.parse(stdout))
  .catch(() => { throw new Error('Fastkore CLI failed its offline startup check'); });
if (capabilities?.success !== true || capabilities.exitCode !== 0 ||
  capabilities.data?.schema !== 'fastkore-cli-capabilities/v1' ||
  !Array.isArray(capabilities.data.commands) ||
  !['auth info', 'data get', 'data query'].every(name => capabilities.data.commands.some(command => command?.name === name))) {
  throw new Error('Fastkore CLI package does not provide the required command catalog');
}

const old = await lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (old) {
  if (!old.isSocket()) throw new Error('Pilot socket path is occupied');
  await unlink(socket);
}

let active = false;
const commands = new Map([
  ['/describe/data-get', ['agent', 'describe', 'data get', '--json']],
  ['/describe/data-query', ['agent', 'describe', 'data query', '--json']],
]);

const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/;
const ticketPattern = /^fkct1\.[A-Za-z0-9._-]{1,4096}$(?![\s\S])/;

async function readCommand(req) {
  if (req.headers['content-type'] !== 'application/json') return;
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) return;
  }
  const input = JSON.parse(body);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { operation, ticket, authority, caFingerprint, ...args } = input;
  if (authority !== trust.authority || caFingerprint !== trust.caFingerprint ||
    typeof ticket !== 'string' || !ticketPattern.test(ticket)) return;
  const flags = ['--user-ticket-stdin', '--json'];
  if (operation === 'auth-info' && Object.keys(args).length === 0) return { argv: ['auth', 'info', ...flags], ticket };
  if (typeof args.entitySetId !== 'string' || !guid.test(args.entitySetId) || Object.keys(args).length !== 2) return;
  const entitySet = ['--entity-set', args.entitySetId];
  if (operation === 'get' && typeof args.entityId === 'string' && guid.test(args.entityId)) {
    return { argv: ['data', 'get', ...entitySet, '--entity', args.entityId, ...flags], ticket };
  }
  if (operation === 'query' && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50) {
    return { argv: ['data', 'query', ...entitySet, '--limit', String(args.limit), ...flags], ticket };
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, value) => res.writeHead(status).end(JSON.stringify(value));
  if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true }); return; }
  if (req.method === 'GET' && req.url === '/trust') { send(200, trust); return; }
  if (req.method === 'GET' && req.url === '/capabilities') { send(200, { ok: true, authenticated: false, capabilities }); return; }
  let read;
  if (req.method === 'POST' && req.url === '/read') {
    try { read = await readCommand(req); } catch { /* A malformed payload never starts a process. */ }
    if (!read) { send(400, {}); return; }
  }
  const args = read?.argv ?? (req.method === 'GET' ? commands.get(req.url) : undefined);
  if (!args) { send(404, {}); return; }
  if (active) { send(409, {}); return; }
  active = true;
  const stop = new AbortController();
  res.once('close', () => { if (!res.writableEnded) stop.abort(); });
  if (res.destroyed) stop.abort();
  const child = execFile(cli, args, { ...cliOptions, signal: stop.signal }, (error, stdout, stderr) => {
    active = false;
    if (res.destroyed) return;
    try {
      if (error) {
        if (read && Number.isInteger(error.code) && error.code > 0 && error.code <= 5) {
          let reported;
          try { reported = JSON.parse(stderr); } catch { /* Exit status is sufficient for an unstructured error. */ }
          if (reported?.exitCode !== undefined && reported.exitCode !== error.code) throw new Error();
          send(200, { success: false, exitCode: error.code });
          return;
        }
        throw new Error();
      }
      const parsed = JSON.parse(stdout);
      if (read) {
        if (parsed.success !== true || parsed.exitCode !== 0 || !Object.hasOwn(parsed, 'data')) throw new Error();
        send(200, { success: true, exitCode: 0, data: parsed.data });
        return;
      }
      if (parsed.success !== true || parsed.data?.operation !== 'read') throw new Error('Unexpected CLI contract');
      const { name, purpose, operation, required, optional, returns } = parsed.data;
      send(200, { ok: true, authenticated: false,
        contract: { name, purpose, operation, required, optional, returns } });
    }
    catch { send(502, {}); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(read ? read.ticket + '\n' : undefined, 'ascii');
});
server.listen(socket, async () => { await chmod(socket, 0o660); });
process.once('SIGTERM', () => server.close());
