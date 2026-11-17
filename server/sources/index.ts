import { BridgeError } from '../store.js';
import type { CodexTools } from '../codex-tools.js';
import type { SourceStorageConfig } from './blob-store.js';
import { SourceIndexer } from './indexer.js';
import { SourcePolicy, type PlatformDirectory, type RunSourceScope } from './policy.js';
import { SourceReader } from './reader.js';
import { SourceRegistry, sourceLimitsFromEnv, type SourceLimits } from './registry.js';
import { publicationProblems, RunReadLog, sourceInstructions, withSources } from './tools.js';

/** Facade of the project sources subsystem, owned by the workspace. */
export class ProjectSources {
  readonly registry: SourceRegistry;
  readonly policy: SourcePolicy;
  readonly reader: SourceReader;
  readonly indexer: SourceIndexer;
  private started = false;
  private collector?: ReturnType<typeof setInterval>;
  constructor(root: string, storage: SourceStorageConfig, directory: PlatformDirectory, limits: SourceLimits = sourceLimitsFromEnv()) {
    this.registry = new SourceRegistry(root, storage, limits);
    this.policy = new SourcePolicy(this.registry, directory);
    this.reader = new SourceReader(this.registry);
    this.indexer = new SourceIndexer(this.registry);
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.indexer.start();
    const keep = Number(process.env.BRIDGE_SOURCES_RETENTION_KEEP ?? 0), minAgeDays = Number(process.env.BRIDGE_SOURCES_RETENTION_DAYS ?? 30);
    this.collector = setInterval(() => {
      try { if (keep > 0 && !this.registry.collectorPaused()) this.registry.applyRetention({ keep, minAgeDays }, id => this.policy.isBound(id)); } catch { /* next round */ }
      void this.registry.collectGarbage().catch(() => {});
    }, 10 * 60_000);
    this.collector.unref?.();
  }
  async stop() {
    clearInterval(this.collector);
    await this.indexer.stop();
    this.registry.close();
  }
  /** Fixes the run scope at enqueue time; no-op for projects without bindings. */
  admitRun(runId: string, chatId: string, userId: string | undefined, projectId: string, profileId: string) {
    if (!userId || !this.hasBindings(projectId)) return undefined;
    return this.policy.admitRun(runId, chatId, userId, projectId, profileId);
  }
  hasBindings(projectId: string) { return !!this.registry.db.prepare('SELECT 1 FROM bindings WHERE project_id=? AND enabled=1 LIMIT 1').get(projectId); }
  /** Recheck the queued policy before giving the executor access to sources. */
  prepareRun(runId: string, userId: string | undefined, projectId: string, profileId: string, toolsSupported: boolean, closedProvider: boolean) {
    const stored = this.policy.storedRunScope(runId);
    if (!stored || !userId) return undefined;
    if (stored.actorId !== userId || stored.projectId !== projectId || stored.profileId !== profileId) throw new BridgeError('Область источников задания не совпадает с заданием.', 409);
    const { entries } = stored;
    const scope = stored;
    if (!entries.length) return { scope, strict: false, closed: false, hashKey: '' };
    if (entries.some(entry => !this.policy.isCurrentRunEntry(scope, entry))) throw new BridgeError('Настройки источников изменились после постановки задания в очередь. Повторите вопрос.', 409);
    const closed = entries.some(e => e.classification === 'restricted');
    if (closed && (!toolsSupported || !closedProvider)) throw new BridgeError('Закрытый анализ источников недоступен на этом исполнителе.', 409);
    const strict = entries.some(e => e.outputPolicy === 'explanation_only');
    // A tool may resolve an explicit price date during the turn. Do not replay a different date's tool results in a later turn.
    const usesDatedSources = entries.some(entry => entry.selector === 'effective_date');
    const hashKey = ':sources:' + scope.hash + (usesDatedSources ? ':' + runId : '');
    return { scope, strict, closed, hashKey, toolsSupported };
  }
  tools(other: CodexTools | undefined, context: { runId: string; userId: string; scope: RunSourceScope; authorize: () => void }) {
    const log = new RunReadLog(context.runId);
    return { tools: withSources(other, { ...context, registry: this.registry, policy: this.policy, reader: this.reader }, log), log };
  }
  instructions(scope: RunSourceScope) { return sourceInstructions(scope); }
  /**
   * Server-side check before a source-backed answer is published: current permissions and verbatim reproduction.
   * Returns the text to publish.
   */
  publish(answer: string, scope: RunSourceScope, log: RunReadLog) {
    const userId = scope.actorId;
    try {
      if (scope.entries.some(entry => !this.policy.isCurrentRunEntry(scope, entry))) {
        this.registry.recordAudit({ actorId: userId, action: 'source.publish.blocked', targetId: log.runId, details: { runId: log.runId, objectIds: { reason: 'revoked' } } });
        return 'Ответ не опубликован: доступ к источникам изменился во время выполнения. Повторите вопрос.';
      }
      if (!log.calls) return answer;
      const policy = scope.entries.some(e => e.outputPolicy === 'explanation_only') ? 'explanation_only' : 'excerpts_allowed';
      const problems = publicationProblems(answer, log.texts(), policy);
      if (problems.length) {
        this.registry.recordAudit({ actorId: userId, action: 'source.publish.blocked', targetId: log.runId, details: { runId: log.runId, objectIds: { reason: problems.join(',') } } });
        return 'Ответ не опубликован: он содержал ' + problems.join(', ') + ', а режим выдачи источников этого не разрешает. Попросите объяснение своими словами со ссылками на основания.';
      }
      this.registry.recordAudit({ actorId: userId, action: 'source.publish', targetId: log.runId, details: { runId: log.runId, objectIds: { reads: String(log.calls) } } });
      return answer;
    } finally { log.purge(); }
  }
}
export type { PlatformDirectory } from './policy.js';
