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
  let erpStarted = started;
  let erpWallMs = 0;
  let activeErpTools = 0;
  const active = new Map<string, { kind: RunToolKind; started: number }>();
  const isErp = (kind: RunToolKind) => kind === 'cli' || kind === 'mcp';

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
    if (isErp(tool.kind) && --activeErpTools === 0) erpWallMs += time - erpStarted;
    if (!active.size) toolWallMs += time - toolsStarted;
  }

  function updateTotals(time: number) {
    timing.executorMs = Math.round(time - started);
    timing.toolWallMs = Math.round(toolWallMs + (active.size ? time - toolsStarted : 0));
    timing.erpToolWallMs = Math.round(erpWallMs + (activeErpTools ? time - erpStarted : 0));
    timing.outsideToolsMs = Math.round(time - started - toolWallMs - (active.size ? time - toolsStarted : 0));
    timing.longestExecutorGapMs = Math.round(longestGap);
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
        const kind = toolKind(event.text);
        if (isErp(kind) && activeErpTools++ === 0) erpStarted = time;
        active.set(event.toolCallId, { kind, started: time });
      }
      if (event.kind === 'tool-end' && event.toolCallId) closeTool(event.toolCallId, time, false);
      updateTotals(time);
    },
    finish() {
      const time = now();
      if (!active.size) longestGap = Math.max(longestGap, time - lastEvent);
      for (const id of active.keys()) closeTool(id, time, true);
      updateTotals(time);
    },
  };
}
