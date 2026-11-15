import test from 'node:test';
import assert from 'node:assert/strict';
import { timeExecutor } from '../server/run-timing.js';
import type { RunTiming } from '../shared/types.js';

test('timings count overlapping tools once in wall time and separate model gaps', () => {
  let now = 0;
  const timing: RunTiming = { queueMs: 50, tools: {} };
  const trace = timeExecutor(timing, () => now);
  now = 100; trace.event({ kind: 'session' });
  now = 600; trace.event({ kind: 'tool', toolCallId: 'a', text: 'fastkore_cli_execute' });
  now = 700; trace.event({ kind: 'tool', toolCallId: 'b', text: 'knowledge' });
  now = 750; trace.event({ kind: 'tool', toolCallId: 'c', text: 'fastkore_GetOrder' });
  now = 900; trace.event({ kind: 'tool-end', toolCallId: 'a' });
  now = 950; trace.event({ kind: 'tool-end', toolCallId: 'c' });
  assert.equal(timing.outsideToolsMs, 600);
  now = 1000; trace.event({ kind: 'tool-end', toolCallId: 'b' });
  now = 1400; trace.event({ kind: 'message-delta', text: 'Ответ' });
  now = 1500; trace.finish();
  assert.equal(timing.executorMs, 1500);
  assert.equal(timing.toolWallMs, 400);
  assert.equal(timing.erpToolWallMs, 350);
  assert.equal(timing.outsideToolsMs, 1100);
  assert.equal(timing.tools.cli?.totalMs, 300);
  assert.equal(timing.tools.knowledge?.totalMs, 300);
  assert.equal(timing.firstTextMs, 1400);
  assert.equal(timing.sessionReadyMs, 100);
  assert.equal(timing.longestExecutorGapMs, 500);
});

test('unfinished tools are timed on failure without including arguments or response text', () => {
  let now = 10;
  const timing: RunTiming = { queueMs: 0, tools: {} };
  const trace = timeExecutor(timing, () => now);
  trace.event({ kind: 'tool', toolCallId: 'a', text: 'fastkore_GetOrders' });
  now = 210; trace.finish();
  assert.deepEqual(timing.tools.mcp, { calls: 1, totalMs: 200, maxMs: 200, unfinished: 1 });
  assert.equal(timing.outsideToolsMs, 0);
  assert.equal(JSON.stringify(timing).includes('GetOrders'), false);
});
