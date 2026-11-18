import { BridgeError } from '../store.js';
import type { CodexTools } from '../codex-tools.js';
import type { LibraryStorageConfig } from './blob-store.js';
import { LibraryIndexer } from './indexer.js';
import { LibraryPolicy, type PlatformDirectory, type RunLibraryScope } from './policy.js';
import { LibraryReader } from './reader.js';
import { LibraryRegistry, libraryLimitsFromEnv, type LibraryLimits } from './registry.js';
import { libraryInstructions, publicationProblems, RunReadLog, withLibrary } from './tools.js';

/** Facade of the project library, owned by the workspace. */
export class ProjectLibrary {
  readonly registry: LibraryRegistry;
  readonly policy: LibraryPolicy;
  readonly reader: LibraryReader;
  readonly indexer: LibraryIndexer;
  private started = false;
  private collector?: ReturnType<typeof setInterval>;
  constructor(root: string, storage: LibraryStorageConfig, directory: PlatformDirectory, limits: LibraryLimits = libraryLimitsFromEnv()) {
    this.registry = new LibraryRegistry(root, storage, limits);
    this.registry.projectName = id => directory.projectName(id);
    this.registry.canSeeProject = (actor, projectId) => actor.admin || directory.canAccessProject(actor.id, projectId, actor.credentialId);
    this.policy = new LibraryPolicy(this.registry, directory);
    this.reader = new LibraryReader(this.registry);
    this.indexer = new LibraryIndexer(this.registry);
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.indexer.start();
    this.collector = setInterval(() => { void this.registry.collectGarbage().catch(() => {}); }, 10 * 60_000);
    this.collector.unref?.();
  }
  async stop() {
    clearInterval(this.collector);
    await this.indexer.stop();
    this.registry.close();
  }
  /** Records the library scope at enqueue time; no-op for projects without connected folders. */
  admitRun(runId: string, userId: string | undefined, projectId: string, profileId: string, credentialId?: string) {
    if (!userId || !this.policy.hasConnections(projectId)) return undefined;
    return this.policy.admitRun(runId, userId, projectId, profileId, credentialId);
  }
  /**
   * Rechecks the queued rights before giving the executor library tools and fixes the current content of each folder for this answer.
   * Content updates after that are not checked; the next question uses the current content.
   */
  prepareRun(runId: string, userId: string | undefined, projectId: string, profileId: string, toolsSupported: boolean, closedProvider: boolean) {
    const stored = this.policy.storedRunScope(runId);
    if (!stored || !userId) return undefined;
    if (stored.actorId !== userId || stored.projectId !== projectId || stored.profileId !== profileId) throw new BridgeError('Область библиотеки задания не совпадает с заданием.', 409);
    if (!stored.entries.length) return { scope: stored, strict: false, closed: false, hashKey: '', toolsSupported };
    if (stored.entries.some(entry => !this.policy.stillAllowed(stored, entry))) throw new BridgeError('Права на библиотеку изменились после постановки вопроса в очередь. Повторите вопрос.', 409);
    const closed = stored.entries.some(e => e.classification === 'restricted');
    if (closed && (!toolsSupported || !closedProvider)) throw new BridgeError('Анализ закрытых материалов недоступен на этом исполнителе.', 409);
    const scope = this.policy.startRun(runId, stored);
    const strict = scope.entries.some(e => e.outputPolicy === 'explanation_only');
    return { scope, strict, closed, hashKey: ':library:' + scope.hash, toolsSupported };
  }
  tools(other: CodexTools | undefined, context: { runId: string; userId: string; scope: RunLibraryScope; authorize: () => void }) {
    const log = new RunReadLog(context.runId);
    return { tools: withLibrary(other, { ...context, registry: this.registry, policy: this.policy, reader: this.reader }, log), log };
  }
  instructions(scope: RunLibraryScope) { return libraryInstructions(scope); }
  /**
   * Server-side check before a library-backed answer is published: current rights and verbatim reproduction. Content changes during the
   * answer are not checked (owner decision). Returns the text to publish.
   */
  publish(answer: string, scope: RunLibraryScope, log: RunReadLog) {
    const userId = scope.actorId;
    try {
      if (scope.entries.some(entry => !this.policy.stillAllowed(scope, entry))) {
        this.registry.recordAudit({ actorId: userId, action: 'library.publish.blocked', targetId: log.runId, details: { runId: log.runId, objectIds: { reason: 'revoked' } } });
        return 'Ответ не опубликован: доступ к библиотеке изменился во время выполнения. Повторите вопрос.';
      }
      if (!log.calls) return answer;
      const policy = scope.entries.some(e => e.outputPolicy === 'explanation_only') ? 'explanation_only' : 'excerpts_allowed';
      const problems = publicationProblems(answer, log.texts(), policy);
      if (problems.length) {
        this.registry.recordAudit({ actorId: userId, action: 'library.publish.blocked', targetId: log.runId, details: { runId: log.runId, objectIds: { reason: problems.join(',') } } });
        return 'Ответ не опубликован: он содержал ' + problems.join(', ') + ', а режим выдачи библиотеки этого не разрешает. Попросите объяснение своими словами со ссылками на файлы.';
      }
      this.registry.recordAudit({ actorId: userId, action: 'library.publish', targetId: log.runId, details: { runId: log.runId, objectIds: { reads: String(log.calls) } } });
      return answer;
    } finally { log.purge(); }
  }
  /** The answer ended: content states it read may be removed once replaced. */
  finishRun(runId: string) { try { this.policy.finishRun(runId); } catch { /* best effort */ } }
}
export type { PlatformDirectory } from './policy.js';
