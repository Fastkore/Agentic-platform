import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AntigravityClient } from '../server/gemini.js';

test('AntigravityClient isolates MCP configs across concurrent runs and keeps stable cwd on resume', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bridge-agy-concurrent-'));
  const fakeAgy = path.join(home, 'fake-agy.mjs');
  await writeFile(fakeAgy, [
    "import { readFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'const args = process.argv.slice(2);',
    "const convIdx = args.indexOf('--conversation');",
    "const conversationId = convIdx >= 0 ? args[convIdx + 1] : crypto.randomUUID();",
    "let stdin = '';",
    'for await (const chunk of process.stdin) stdin += chunk;',
    'await new Promise(resolve => setTimeout(resolve, 120));',
    "const cfg = JSON.parse(await readFile(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8'));",
    'const bridge = cfg.mcpServers.bridge;',
    "const res = await fetch(bridge.serverUrl, { method: 'POST', headers: { ...bridge.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });",
    'if (res.status !== 200) { console.error("MCP auth failed: " + res.status); process.exit(1); }',
    'const tools = await res.json();',
    "console.log(JSON.stringify({ event: 'init', conversation_id: conversationId }));",
    "console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify({ cwd: process.cwd(), toolCount: tools.result.tools.length }) } }));",
    '',
  ].join('\n'));
  try {
    const client = new AntigravityClient(home, process.execPath, [fakeAgy]);
    const slotA = randomUUID();
    const slotB = randomUUID();
    const [runA, runB] = await Promise.all([
      client.run({
        cliPath: '', workspace: home, prompt: 'A', allowWrite: false, sessionSlot: slotA,
        tools: { definitions: [{ type: 'function', name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } }], call: async () => ({ success: true, text: 'ok' }) },
      }, async () => {}, AbortSignal.timeout(10_000)),
      client.run({
        cliPath: '', workspace: home, prompt: 'B', allowWrite: false, sessionSlot: slotB,
        tools: { definitions: [], call: async () => ({ success: true, text: 'ok' }) },
      }, async () => {}, AbortSignal.timeout(10_000)),
    ]);
    const parsedA = JSON.parse(runA.response) as { cwd: string; toolCount: number };
    const parsedB = JSON.parse(runB.response) as { cwd: string; toolCount: number };
    assert.notEqual(parsedA.cwd, parsedB.cwd);
    assert.equal(parsedA.toolCount, 1);
    assert.equal(parsedB.toolCount, 0);

    const resumedA = await client.run({
      cliPath: '', workspace: home, prompt: 'A2', allowWrite: false, sessionId: runA.sessionId, sessionSlot: slotA,
    }, async () => {}, AbortSignal.timeout(10_000));
    assert.equal(JSON.parse(resumedA.response).cwd, parsedA.cwd);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
