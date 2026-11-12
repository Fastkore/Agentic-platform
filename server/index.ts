import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store.js';
import { CodexClient } from './codex.js';
import { RemoteCodexRunner } from './codex-remote.js';
import { Workspace } from './workspace.js';
import { FileStorage } from './file-storage.js';
import { addresses, createApp } from './app.js';

const root = path.resolve(process.env.BRIDGE_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'CodexChatBridgeWeb'));
const port = Number(process.env.BRIDGE_PORT ?? 8787), lan = process.argv.includes('--lan') || process.env.BRIDGE_HOST === '0.0.0.0';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BRIDGE_PORT должен быть от 1024 до 65535.');
await mkdir(root, { recursive: true });
const lock = path.join(root, 'server.lock');
try {
  const handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); await handle.close();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const previousPid = Number(await readFile(lock, 'utf8'));
  let running = false;
  if (Number.isInteger(previousPid) && previousPid > 0) {
    try { process.kill(previousPid, 0); running = true; } catch (e) { running = (e as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  if (running) throw new Error('Сервер с этой папкой данных уже запущен.');
  await unlink(lock); const handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); await handle.close();
}
let cleaned = false;
const cleanup = async () => { if (!cleaned) { cleaned = true; await unlink(lock).catch(() => {}); } };
try {
  const store = new Store(root);
  await store.save();
  const socket = process.env.BRIDGE_CODEX_SOCKET;
  if (process.env.BRIDGE_EXECUTION === 'isolated' && (!socket || !path.isAbsolute(socket))) throw new Error('Для BRIDGE_EXECUTION=isolated нужен абсолютный BRIDGE_CODEX_SOCKET.');
  const workspace = new Workspace(store, socket ? new RemoteCodexRunner(socket) : new CodexClient(),
    new FileStorage(process.env), process.env.BRIDGE_CODEX_JOB_FILES);
  const app = await createApp(workspace, { port, lan, clientRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client') });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await workspace.shutdown(); await app.close(); await cleanup(); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  await app.listen({ port, host: lan ? '0.0.0.0' : '127.0.0.1' });
  console.log('Codex Chat Bridge Web · 0.6.0');
  for (const url of addresses(port, lan)) console.log(url);
  console.log(`Данные: ${root}`);
  console.log(lan ? 'Доступ в локальной сети включён. Вход — по личному логину и паролю.' : 'Доступ только с этого компьютера. Для локальной сети: --lan');
  console.log('Остановка: Ctrl+C. Учётные данные не записываются в журнал.');
} catch (error) { await cleanup(); console.error((error as Error).message); process.exitCode = 1; }
