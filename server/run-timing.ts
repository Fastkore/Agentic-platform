import { performance } from 'node:perf_hooks';
import type { RunTiming, RunToolKind } from '../shared/types.js';
import type { CodexEvent } from './codex.js';

export const elapsedMs = (started: number) => Math.round(performance.now() - started);

function toolKind(name: string): RunToolKind {
  if (name.startsWith('fastkore_cli_')) return 'cli';
  if (name.startsWith('fastkore_')) return 'mcp';
  if (name.startsWith('internet_')) return 'internet';
  if (name === 'knowledge') return 'knowledge';
  if (name === 'consult_specialist') return 'specialist';
  return 'other';
}

export function timeExecutor(timing: RunTiming, now = () => performance.now()) {
  const started = now();
  let lastEvent = started;
  let toolsStarted = started;
  let longestGap = 0;
  let toolWallMs = 0;
  const active = new Map<string, { kind: RunToolKind; started: number }>();

  function closeTool(id: string, time: number, unfinished: boolean) {
    const tool = active.get(id);
    if (!tool) return;
    active.delete(id);
    const duration = Math.round(time - tool.started);
    const stats = timing.tools[tool.kind] ??= { calls: 0, totalMs: 0, maxMs: 0, unfinished: 0 };
    stats.calls++;
    stats.totalMs += duration;
    stats.maxMs = Math.max(stats.maxMs, duration);
    if (unfinished) stats.unfinished++;
    if (!active.size) toolWallMs += time - toolsStarted;
  }

  return {
    event(event: CodexEvent) {
      const time = now();
      if (!active.size) longestGap = Math.max(longestGap, time - lastEvent);
      lastEvent = time;
      if (event.kind === 'session') timing.sessionReadyMs ??= Math.round(time - started);
      if ((event.kind === 'message' || event.kind === 'message-delta' || event.kind === 'message-replace') && event.text?.trim()) {
        timing.firstTextMs ??= Math.round(time - started);
      }
      if (event.kind === 'tool' && event.toolCallId && event.text && !active.has(event.toolCallId)) {
        if (!active.size) toolsStarted = time;
        active.set(event.toolCallId, { kind: toolKind(event.text), started: time });
      }
      if (event.kind === 'tool-end' && event.toolCallId) closeTool(event.toolCallId, time, false);
    },
    finish() {
      const time = now();
      if (!active.size) longestGap = Math.max(longestGap, time - lastEvent);
      for (const id of active.keys()) closeTool(id, time, true);
      timing.executorMs = Math.round(time - started);
      timing.toolWallMs = Math.round(toolWallMs);
      timing.longestExecutorGapMs = Math.round(longestGap);
    },
  };
}
