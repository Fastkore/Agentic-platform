import { createHash } from 'node:crypto';
import type { LibraryCell, LibraryConnection, OutputPolicy, ProjectLibraryView } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { notFound, type FolderRow, type LibraryActor, type LibraryRegistry } from './registry.js';

/** Platform facts the library policy depends on; supplied by the workspace from the canonical project/specialist model. */
export interface PlatformDirectory {
  projectExists(projectId: string): boolean;
  projectName(projectId: string): string | undefined;
  canAccessProject(userId: string, projectId: string, credentialId?: string): boolean;
  /** Profiles connected to the project through ProjectAgentPolicy (all enabled profiles when the project has no policy). */
  connectedProfiles(projectId: string): { id: string; name: string }[];
  /** Analysis of closed folders stays off until the real executor, its sessions and logs were verified. */
  closedAnalysisVerified(): boolean;
}
type ConnectionRow = { project_id: string; folder_id: string; enabled: number; output_policy: OutputPolicy; revision: number; created_at: string };
type GrantRow = { project_id: string; profile_id: string; folder_id: string; output_policy: OutputPolicy | null; paths: string | null };
const strictest = (...policies: (OutputPolicy | null | undefined)[]): OutputPolicy =>
  policies.every(p => !p || p === 'excerpts_allowed') ? 'excerpts_allowed' : 'explanation_only';
const parsePaths = (value: string | null) => { try { return value ? JSON.parse(value) as string[] : undefined; } catch { return []; } };
export const accessReasons: Record<string, string> = {
  folder_inactive: 'Папка неактивна',
  project_access: 'Нет доступа к проекту', connection_disabled: 'Папка отключена в проекте', not_assigned: 'Папка не назначена агенту',
  profile_not_connected: 'Агент не подключён к проекту',
  closed_analysis_off: 'Закрытая папка: анализ закрытых материалов в этой поставке выключен', no_content: 'В папке ещё нет готовых материалов',
};
export interface ScopeEntry {
  folderId: string; name: string; description: string; profile: string; outputPolicy: OutputPolicy; classification: string;
  /** Content state fixed at the start of the answer: the agent can finish with it; the next question uses the current content. */
  stateId: string;
  /** Grant restricted to listed files (carried over from per-file access of the former project files). */
  paths?: string[];
}
export interface RunLibraryScope { projectId: string; actorId: string; profileId: string; credentialId?: string; entries: ScopeEntry[]; hash: string }

export class LibraryPolicy {
  constructor(readonly registry: LibraryRegistry, readonly directory: PlatformDirectory) {}
  private get db() { return this.registry.db; }
  connection(projectId: string, folderId: string) { return this.db.prepare('SELECT * FROM connections WHERE project_id=? AND folder_id=?').get(projectId, folderId) as ConnectionRow | undefined; }
  private requireProject(actor: LibraryActor, projectId: string) {
    if (!this.directory.projectExists(projectId) || !actor.admin && !this.directory.canAccessProject(actor.id, projectId, actor.credentialId)) throw new BridgeError('Проект не найден.', 404);
  }
  private manageable(actor: LibraryActor, folderId: string) { return this.registry.can(actor, folderId, 'connect'); }
  /** A project library manager: project access plus the right to connect at least one folder (administrators always). */
  canManageProject(actor: LibraryActor, projectId: string) {
    if (!this.directory.projectExists(projectId)) return false;
    if (actor.admin) return true;
    if (!this.directory.canAccessProject(actor.id, projectId, actor.credentialId)) return false;
    return this.registry.listFolders(actor).some(f => this.manageable(actor, f.id));
  }
  private requireManager(actor: LibraryActor, projectId: string) {
    this.requireProject(actor, projectId);
    if (!this.canManageProject(actor, projectId)) throw new BridgeError('Проект не найден.', 404);
  }
  private requireConnection(actor: LibraryActor, projectId: string, folderId: string) {
    this.requireProject(actor, projectId);
    const row = this.connection(projectId, folderId);
    if (!row || !this.manageable(actor, folderId)) { this.registry.deny(actor, folderId, 'connect', 'connection'); throw notFound(); }
    return row;
  }
  /** Connects a folder; specialists get no access until explicitly assigned. */
  connect(actor: LibraryActor, projectId: string, input: { folderId: string; outputPolicy?: OutputPolicy }) {
    this.requireProject(actor, projectId);
    const folder = this.registry.folderRow(input.folderId);
    if (!folder || !this.manageable(actor, input.folderId)) { this.registry.deny(actor, input.folderId, 'connect', 'connect'); throw notFound(); }
    return this.registry.tx(() => {
      try {
        this.db.prepare('INSERT INTO connections VALUES (?,?,1,?,1,?)').run(projectId, input.folderId, input.outputPolicy ?? folder.output_policy, new Date().toISOString());
      } catch (error) {
        if (String((error as Error).message).includes('UNIQUE') || String((error as Error).message).includes('PRIMARY')) throw new BridgeError('Папка уже подключена к проекту.', 409);
        throw error;
      }
      return this.publicConnection(actor, this.connection(projectId, input.folderId)!, folder);
    }, () => [{ actorId: actor.id, action: 'library.connect', targetId: input.folderId, details: { objectIds: { projectId } } }]);
  }
  updateConnection(actor: LibraryActor, projectId: string, folderId: string, input: { revision: number; enabled?: boolean; outputPolicy?: OutputPolicy }) {
    this.requireConnection(actor, projectId, folderId);
    return this.registry.tx(() => {
      const current = this.connection(projectId, folderId)!;
      if (current.revision !== input.revision) throw new BridgeError('Настройки изменены другим пользователем. Обновите данные.', 409);
      this.db.prepare('UPDATE connections SET enabled=?, output_policy=?, revision=revision+1 WHERE project_id=? AND folder_id=?')
        .run(input.enabled === undefined ? current.enabled : Number(input.enabled), input.outputPolicy ?? current.output_policy, projectId, folderId);
      return this.publicConnection(actor, this.connection(projectId, folderId)!, this.registry.folderRow(folderId)!);
    }, () => [{ actorId: actor.id, action: 'library.connection.update', targetId: folderId, details: { objectIds: { projectId }, previousRevision: String(input.revision) } }]);
  }
  /** Disconnecting removes the folder's assignments in this project; the folder stays in the library for other projects. */
  disconnect(actor: LibraryActor, projectId: string, folderId: string, revision: number) {
    this.requireConnection(actor, projectId, folderId);
    return this.registry.tx(() => {
      const current = this.connection(projectId, folderId)!;
      if (current.revision !== revision) throw new BridgeError('Настройки изменены другим пользователем. Обновите данные.', 409);
      this.db.prepare('DELETE FROM grants WHERE project_id=? AND folder_id=?').run(projectId, folderId);
      this.db.prepare('DELETE FROM connections WHERE project_id=? AND folder_id=?').run(projectId, folderId);
      return { ok: true };
    }, () => [{ actorId: actor.id, action: 'library.disconnect', targetId: folderId, details: { objectIds: { projectId } } }]);
  }
  /** Assignment of a connected folder to a specialist. Missing row = no access. */
  setGrant(actor: LibraryActor, projectId: string, folderId: string, input: { profileId: string; enabled: boolean; outputPolicy?: OutputPolicy | null; revision: number;
    /** Opens the whole folder for an assignment that was limited to files. */ allFiles?: boolean }) {
    this.requireConnection(actor, projectId, folderId);
    if (input.enabled && !this.directory.connectedProfiles(projectId).some(p => p.id === input.profileId)) throw new BridgeError('Сначала подключите агента к проекту.', 409);
    return this.registry.tx(() => {
      const connection = this.connection(projectId, folderId)!;
      if (connection.revision !== input.revision) throw new BridgeError('Настройки изменены другим пользователем. Обновите данные.', 409);
      if (input.enabled) {
        this.db.prepare(`INSERT INTO grants VALUES (?,?,?,?,NULL) ON CONFLICT(project_id,profile_id,folder_id) DO UPDATE SET output_policy=excluded.output_policy,
          paths=CASE WHEN ? THEN NULL ELSE grants.paths END`).run(projectId, input.profileId, folderId, input.outputPolicy ?? null, input.allFiles ? 1 : 0);
      } else this.db.prepare('DELETE FROM grants WHERE project_id=? AND profile_id=? AND folder_id=?').run(projectId, input.profileId, folderId);
      this.db.prepare('UPDATE connections SET revision=revision+1 WHERE project_id=? AND folder_id=?').run(projectId, folderId);
      return this.publicConnection(actor, this.connection(projectId, folderId)!, this.registry.folderRow(folderId)!);
    }, () => [{ actorId: actor.id, action: input.enabled ? 'library.grant.enable' : 'library.grant.disable', targetId: folderId, details: { objectIds: { projectId, profileId: input.profileId } } }]);
  }
  private publicConnection(actor: LibraryActor, row: ConnectionRow, folder: FolderRow): LibraryConnection {
    const current = folder.current_state ? this.registry.stateRow(folder.current_state) : undefined;
    const preparing = !!this.db.prepare("SELECT 1 FROM operations WHERE folder_id=? AND status IN ('open','preparing')").get(folder.id);
    return { projectId: row.project_id, folderId: folder.id, folderName: folder.name, description: folder.description, profile: folder.profile, classification: folder.classification, folderActive: !!folder.active,
      outputPolicy: row.output_policy, enabled: !!row.enabled, revision: row.revision, current: current && this.registry.coverage(current), updatedAt: folder.updated_at ?? undefined,
      preparing, canManage: this.manageable(actor, folder.id) };
  }
  // ---- effective access ----------------------------------------------------------------------
  /**
   * The single access rule: project membership ∩ specialist availability ∩ connection ∩ assignment ∩ folder mode.
   * userId=undefined evaluates the configured policy (matrix) without a particular employee.
   */
  effective(userId: string | undefined, projectId: string, profileId: string, folderId: string, credentialId?: string) {
    const reasons: string[] = [];
    const connection = this.connection(projectId, folderId);
    const folder = this.registry.folderRow(folderId);
    if (!connection || !folder) return { allowed: false, reasons: ['connection_disabled'] as string[] };
    if (userId !== undefined && !this.directory.canAccessProject(userId, projectId, credentialId)) reasons.push('project_access');
    if (!folder.active) reasons.push('folder_inactive');
    if (!connection.enabled) reasons.push('connection_disabled');
    const grant = this.db.prepare('SELECT * FROM grants WHERE project_id=? AND profile_id=? AND folder_id=?').get(projectId, profileId, folderId) as GrantRow | undefined;
    if (!grant) reasons.push('not_assigned');
    if (!this.directory.connectedProfiles(projectId).some(p => p.id === profileId)) reasons.push('profile_not_connected');
    if (folder.classification === 'restricted' && !this.directory.closedAnalysisVerified()) reasons.push('closed_analysis_off');
    if (!folder.current_state) reasons.push('no_content');
    const outputPolicy = strictest(folder.output_policy, connection.output_policy, grant?.output_policy);
    return { allowed: reasons.length === 0, reasons, outputPolicy, folder, grant, paths: parsePaths(grant?.paths ?? null) };
  }
  /** Rights only: content updates during an answer are allowed and not checked (owner decision). */
  stillAllowed(scope: RunLibraryScope, entry: ScopeEntry) {
    const access = this.effective(scope.actorId, scope.projectId, scope.profileId, entry.folderId, scope.credentialId);
    return !!access.folder && access.reasons.every(r => r === 'no_content') && access.outputPolicy === entry.outputPolicy
      && access.folder.classification === entry.classification && JSON.stringify(access.paths ?? null) === JSON.stringify(entry.paths ?? null);
  }
  view(actor: LibraryActor, projectId: string): ProjectLibraryView {
    this.requireManager(actor, projectId);
    const rows = (this.db.prepare('SELECT c.* FROM connections c JOIN folders f ON f.id=c.folder_id WHERE c.project_id=? AND f.deleted_at IS NULL ORDER BY c.rowid').all(projectId) as ConnectionRow[])
      .filter(r => this.manageable(actor, r.folder_id));
    const profiles = this.directory.connectedProfiles(projectId);
    const cells: LibraryCell[] = [];
    for (const row of rows) for (const profile of profiles) {
      const access = this.effective(undefined, projectId, profile.id, row.folder_id);
      cells.push({ folderId: row.folder_id, profileId: profile.id, granted: !access.reasons.includes('not_assigned'), allowed: access.allowed, outputPolicy: access.outputPolicy,
        files: access.paths?.length, reasons: access.reasons.map(r => accessReasons[r] ?? r) });
    }
    const connected = new Set(rows.map(r => r.folder_id));
    return { projectId, profiles, cells,
      connections: rows.map(row => this.publicConnection(actor, row, this.registry.folderRow(row.folder_id)!)),
      available: this.registry.listFolders(actor).filter(f => !connected.has(f.id) && this.manageable(actor, f.id) && !this.connection(projectId, f.id)).map(f => ({ id: f.id, name: f.name })) };
  }
  /** Folders a run may use, from the same rule as the matrix; fixed when the answer starts. */
  runScope(userId: string, projectId: string, profileId: string, credentialId?: string): RunLibraryScope {
    const entries: ScopeEntry[] = [];
    for (const row of this.db.prepare('SELECT * FROM connections WHERE project_id=? AND enabled=1 ORDER BY rowid').all(projectId) as ConnectionRow[]) {
      const access = this.effective(userId, projectId, profileId, row.folder_id, credentialId);
      if (!access.allowed || !access.folder) continue;
      entries.push({ folderId: row.folder_id, name: access.folder.name, description: access.folder.description, profile: access.folder.profile, outputPolicy: access.outputPolicy!,
        classification: access.folder.classification, stateId: access.folder.current_state!, paths: access.paths });
    }
    // The hash covers rights only. Content updates do not create a new executor context: every answer with library tools starts a new one anyway.
    const hash = createHash('sha256').update(JSON.stringify(entries.map(e => [e.folderId, e.outputPolicy, e.classification, e.paths ?? null]))).digest('hex');
    return { projectId, actorId: userId, profileId, credentialId, entries, hash };
  }
  admitRun(runId: string, userId: string, projectId: string, profileId: string, credentialId?: string) {
    const scope = this.runScope(userId, projectId, profileId, credentialId);
    this.db.prepare('INSERT OR REPLACE INTO run_scopes VALUES (?,?,?,?,?,?,NULL)').run(runId, projectId, userId, profileId, JSON.stringify(scope), Date.now());
    return scope;
  }
  storedRunScope(runId: string) {
    const row = this.db.prepare('SELECT scope FROM run_scopes WHERE run_id=?').get(runId) as { scope: string } | undefined;
    try { return row ? JSON.parse(row.scope) as RunLibraryScope : undefined; } catch { return undefined; }
  }
  /** Fixes the content states at the start of the answer; earlier ones the agent could not have read are not kept. */
  startRun(runId: string, scope: RunLibraryScope) {
    const entries = scope.entries.flatMap(entry => {
      const state = this.registry.currentState(entry.folderId);
      return state ? [{ ...entry, stateId: state.id }] : [];
    });
    const started = { ...scope, entries };
    this.db.prepare('UPDATE run_scopes SET scope=?, created_at=? WHERE run_id=?').run(JSON.stringify(started), Date.now(), runId);
    return started;
  }
  finishRun(runId: string) { this.db.prepare('UPDATE run_scopes SET finished_at=? WHERE run_id=? AND finished_at IS NULL').run(Date.now(), runId); }
  hasConnections(projectId: string) { return !!this.db.prepare('SELECT 1 FROM connections WHERE project_id=? AND enabled=1 LIMIT 1').get(projectId); }
}
