import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex mock 1.0'); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args.includes('app-server')) {
  let steeringThread;
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: { userAgent: 'fake' } }));
    if (request.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: request.id, result: {
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1794397200 }, secondary: null } },
      rateLimitResetCredits: { availableCount: 2 }
    } }));
    if (request.method === 'model/list') console.log(JSON.stringify({ id: request.id, result: request.params.cursor ? {
      data: [{ id: 'test-b', model: 'test-b', displayName: 'Test Model B' }], nextCursor: null
    } : {
      data: [{ id: 'test-a', model: 'test-a', displayName: 'Test Model A', isDefault: true }, { id: 'hidden', model: 'hidden', hidden: true }], nextCursor: 'next'
    } }));
    if (request.method === 'thread/start' || request.method === 'thread/resume') console.log(JSON.stringify({ id: request.id,
      result: { thread: { id: request.params.threadId ?? '87db344a-98f3-42c8-bba8-c7d9f3dcff11' } } }));
    if (request.method === 'turn/start') {
      const threadId = request.params.threadId;
      console.log(JSON.stringify({ id: request.id, result: { turn: { id: 'turn-1' } } }));
      if (request.params.input[0].text.includes('WAIT_FOR_STEER')) {
        steeringThread = threadId;
        console.log(JSON.stringify({ id: 91, method: 'item/tool/call', params: { threadId, turnId: 'turn-1', callId: 'slow-tool', tool: 'knowledge', arguments: {} } }));
        continue;
      }
      console.log(JSON.stringify({ method: 'item/reasoning/textDelta', params: { threadId, delta: 'PRIVATE_REASONING' } }));
      console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'text-1', delta: 'Проверяю' } }));
      setTimeout(() => {
        console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'text-1', delta: ' документы.' } }));
        console.log(JSON.stringify({ method: 'item/completed', params: { threadId, item: { id: 'text-1', type: 'agentMessage', text: 'Проверяю документы.' } } }));
        console.log(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } }));
      }, 300);
    }
    if (request.method === 'turn/steer') {
      if (request.params.threadId !== steeringThread || request.params.expectedTurnId !== 'turn-1') {
        console.log(JSON.stringify({ id: request.id, error: { code: -32602, message: 'Unexpected turn' } }));
        continue;
      }
      console.log(JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } }));
      console.log(JSON.stringify({ method: 'item/completed', params: { threadId: steeringThread, item: { id: 'steer-text', type: 'agentMessage', text: request.params.input[0].text } } }));
      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: steeringThread, turn: { status: 'completed' } } }));
    }
  }
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
writeFileSync('fake-last-arguments.json', JSON.stringify(args));
const index = args.indexOf('resume');
const id = index >= 0 ? args[index + 1] : '87db344a-98f3-42c8-bba8-c7d9f3dcff11';
console.log(JSON.stringify({ type: 'thread.started', thread_id: prompt.includes('CHANGE_SESSION') ? '00000000-0000-4000-8000-000000000001' : id }));
if (prompt.includes('CANCEL_TEST')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  writeFileSync('fake-child.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else {
  await new Promise(resolve => setTimeout(resolve, 100));
  const item = { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'В таблице: Кофе — 42.\n\n**Готово.**' } };
  console.log(JSON.stringify(item)); console.log(JSON.stringify(item));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 15 } }));
}
