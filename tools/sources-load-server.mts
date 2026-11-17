/** Platform process for tools/sources-load.mts: isolated fake executor, real HTTP API and source subsystem. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import type { CodexRunner } from '../server/codex.js';

const data = process.env.BRIDGE_DATA_DIR!;
await mkdir(path.join(data, 'project'), { recursive: true });
const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'load', authentication: 'chatgpt', status: '' }), run: async () => ({ response: 'OK' }) };
const workspace = new Workspace(new Store(data), runner);
const app = await createApp(workspace, { port: Number(process.env.PORT) });
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
if (process.send) setInterval(() => process.send?.(process.memoryUsage.rss()), 500).unref();
console.log('READY');
