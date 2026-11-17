import { createHash, randomUUID } from 'node:crypto';
import {
  businessDate, periodConflicts, selectByDate, validDate,
  type BindingSelector, type MatrixCell, type ProjectSourceBinding, type ProjectSourceSettings, type SourceAction, type SourceBundle, type SourceMatrix, type SourceOutputPolicy,
} from '../../shared/sources.js';
import { BridgeError } from '../store.js';
import { notFound, type SnapshotRow, type SourceActor, type SourceRegistry } from './registry.js';

/** Platform facts the source policy depends on; supplied by the workspace from the canonical project/specialist model. */
export interface PlatformDirectory {
  projectExists(projectId: string): boolean;
  projectName(projectId: string): string | undefined;
  canAccessProject(userId: string, projectId: string): boolean;
  /** Profiles connected to the project through ProjectAgentPolicy (all enabled profiles when the project has no policy). */
  connectedProfiles(projectId: string): { id: string; name: string }[];
  canUseProfile(userId: string, profileId: string): boolean;
  /** Closed analysis is enabled only after isolation was verified on the target Linux executor. */
  closedAnalysisVerified(): boolean;
}
type BindingRow = { id: string; project_id: string; source_id: string; selector: BindingSelector; snapshot_id: string | null; approved: string; allowed_actions: string;
  output_policy: SourceOutputPolicy; enabled: number; revision: number; created_at: string };
type BundleRow = { id: string; project_id: string; label: string; revision: number; items: string; state: 'active' | 'archived' | 'draft'; created_by: string; created_at: string; activated_at: string | null };
const parse = <T>(value: string | null, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const strictest = (...policies: (SourceOutputPolicy | null | undefined)[]): SourceOutputPolicy =>
  policies.every(p => !p || p === 'excerpts_allowed') ? 'excerpts_allowed' : 'explanation_only';
export const accessReasons: Record<string, string> = {
  project_access: 'Нет доступа к проекту', binding_disabled: 'Источник отключён от проекта', source_archived: 'Источник архивирован',
  action_not_allowed: 'Действие не разрешено привязкой', not_assigned: 'Источник не назначен специалисту', profile_not_connected: 'Специалист не подключён к проекту',
  profile_forbidden: 'Специалист недоступен сотруднику', closed_analysis_unverified: 'Закрытый анализ не включён: изоляция исполнителя не проверена',
  no_snapshot: 'Нет готового снимка', snapshot_not_ready: 'Выбранный снимок не готов', date_required: 'Нужна дата расчёта',
};
export interface ScopeEntry {
  bindingId: string; sourceId: string; sourceName: string; kind: string; selector: BindingSelector; snapshotId?: string; snapshotLabel?: string;
  outputPolicy: SourceOutputPolicy; classification: string; revision: number; policyRevision: number;
  selectionRevision?: string;
}
export interface RunSourceScope { projectId: string; actorId: string; profileId: string; entries: ScopeEntry[]; hash: string; effectiveDate?: string; bundleId?: string; bundleRevision?: number }

export class SourcePolicy {
  constructor(readonly registry: SourceRegistry, readonly directory: PlatformDirectory) {}
  private get db() { return this.registry.db; }
  binding(id: string) { return this.db.prepare('SELECT * FROM bindings WHERE id=?').get(id) as BindingRow | undefined; }
  private publicBinding(row: BindingRow): ProjectSourceBinding {
    return { id: row.id, projectId: row.project_id, sourceId: row.source_id, selector: row.selector, snapshotId: row.snapshot_id ?? undefined,
      approvedSnapshotIds: parse<string[]>(row.approved, []), allowedActions: parse<SourceAction[]>(row.allowed_actions, []), outputPolicy: row.output_policy,
      enabled: !!row.enabled, revision: row.revision };
  }
  /** A project manager: project access plus manage_project_binding on the source (administrators always). */
  private requireProject(actor: SourceActor, projectId: string) {
    if (!this.directory.projectExists(projectId) || !actor.admin && !this.directory.canAccessProject(actor.id, projectId)) throw new BridgeError('Проект не найден.', 404);
  }
  private manageable(actor: SourceActor, sourceId: string) { return this.registry.can(actor, sourceId, 'manage_project_binding'); }
  private requireBinding(actor: SourceActor, projectId: string, bindingId: string) {
    this.requireProject(actor, projectId);
    const row = this.binding(bindingId);
    if (!row || row.project_id !== projectId || !this.manageable(actor, row.source_id)) { this.registry.deny(actor, bindingId, 'manage_project_binding', 'binding'); throw notFound(); }
    return row;
  }
  canManageProject(actor: SourceActor, projectId: string) {
    if (!this.directory.projectExists(projectId)) return false;
    if (actor.admin) return true;
    if (!this.directory.canAccessProject(actor.id, projectId)) return false;
    return (this.db.prepare('SELECT DISTINCT source_id FROM bindings WHERE project_id=?').all(projectId) as { source_id: string }[]).some(r => this.manageable(actor, r.source_id))
      || this.registry.listSources(actor).some(s => this.manageable(actor, s.id));
  }
  listBindings(actor: SourceActor, projectId: string) {
    this.requireManager(actor, projectId);
    return (this.db.prepare('SELECT * FROM bindings WHERE project_id=? ORDER BY rowid').all(projectId) as BindingRow[])
      .filter(row => this.manageable(actor, row.source_id)).map(row => this.publicBinding(row));
  }
  /** Connects an existing registry source; access for specialists stays off until explicit grants. */
  attach(actor: SourceActor, projectId: string, input: { sourceId: string; selector: BindingSelector; snapshotId?: string; approvedSnapshotIds?: string[]; outputPolicy?: SourceOutputPolicy }) {
    this.requireProject(actor, projectId);
    const source = this.registry.sourceInfo(input.sourceId);
    if (!source || !this.manageable(actor, input.sourceId)) { this.registry.deny(actor, input.sourceId, 'manage_project_binding', 'attach'); throw notFound(); }
    if (source.archived_at) throw new BridgeError('Источник архивирован.', 409);
    const id = 'bnd_' + randomUUID().replaceAll('-', '');
    return this.registry.tx(() => {
      this.validateSelection(input.sourceId, input.selector, input.snapshotId, input.approvedSnapshotIds ?? []);
      try {
        this.db.prepare('INSERT INTO bindings VALUES (?,?,?,?,?,?,?,?,1,1,?)').run(id, projectId, input.sourceId, input.selector, input.snapshotId ?? null,
          JSON.stringify(input.approvedSnapshotIds ?? []), JSON.stringify(['use_for_analysis']), input.outputPolicy ?? source.output_policy, new Date().toISOString());
      } catch (error) {
        if (String((error as Error).message).includes('UNIQUE')) throw new BridgeError('Источник уже подключён к проекту.', 409);
        throw error;
      }
      return this.publicBinding(this.binding(id)!);
    }, () => [{ actorId: actor.id, action: 'source.binding.create', targetId: id, details: { objectIds: { projectId, sourceId: input.sourceId } } }]);
  }
  private validateSelection(sourceId: string, selector: BindingSelector, snapshotId: string | undefined, approved: string[]) {
    if (approved.length > 500 || new Set(approved).size !== approved.length) throw new BridgeError('Проверьте список допущенных снимков.');
    const own = (id: string) => { const s = this.registry.snapshotRow(id); if (!s || s.source_id !== sourceId || ['cancelled', 'archived'].includes(s.state)) throw notFound(); return s; };
    if (selector === 'pinned') {
      if (approved.length) throw new BridgeError('Для закреплённой версии список периодов не используется.');
      if (snapshotId) own(snapshotId);
    } else {
      if (snapshotId) throw new BridgeError('Для выбора по дате снимок не закрепляется.');
      const rows = approved.map(own);
      if (rows.some(r => !r.valid_from)) throw new BridgeError('Для выбора по дате у каждого снимка должна быть дата начала действия.');
    }
  }
  updateBinding(actor: SourceActor, projectId: string, bindingId: string, input: { revision: number; selector?: BindingSelector; snapshotId?: string | null; approvedSnapshotIds?: string[];
    outputPolicy?: SourceOutputPolicy; enabled?: boolean }) {
    const row = this.requireBinding(actor, projectId, bindingId);
    return this.registry.tx(() => {
      const current = this.binding(bindingId)!;
      if (current.revision !== input.revision) throw new BridgeError('Привязка изменена другим пользователем. Обновите данные.', 409);
      const selector = input.selector ?? current.selector;
      const snapshotId = input.snapshotId === undefined ? (selector === current.selector ? current.snapshot_id ?? undefined : undefined) : input.snapshotId ?? undefined;
      const approved = input.approvedSnapshotIds ?? (selector === current.selector ? parse<string[]>(current.approved, []) : []);
      this.validateSelection(row.source_id, selector, snapshotId, approved);
      this.db.prepare('UPDATE bindings SET selector=?, snapshot_id=?, approved=?, output_policy=?, enabled=?, revision=revision+1 WHERE id=?')
        .run(selector, snapshotId ?? null, JSON.stringify(approved), input.outputPolicy ?? current.output_policy, input.enabled === undefined ? current.enabled : Number(input.enabled), bindingId);
      return this.publicBinding(this.binding(bindingId)!);
    }, () => [{ actorId: actor.id, action: 'source.binding.update', targetId: bindingId, details: { previousRevision: String(input.revision) } }]);
  }
  /** Detaching removes the binding and its grants; snapshots stay in the registry for other projects. */
  detach(actor: SourceActor, projectId: string, bindingId: string, revision: number) {
    this.requireBinding(actor, projectId, bindingId);
    return this.registry.tx(() => {
      const current = this.binding(bindingId)!;
      if (current.revision !== revision) throw new BridgeError('Привязка изменена другим пользователем. Обновите данные.', 409);
      const active = this.activeBundleRow(projectId);
      if (active && parse<{ bindingId: string }[]>(active.items, []).some(i => i.bindingId === bindingId)) throw new BridgeError('Привязка входит в активный набор версий. Сначала выберите набор без неё.', 409);
      this.db.prepare('DELETE FROM bindings WHERE id=?').run(bindingId);
      return { ok: true };
    }, () => [{ actorId: actor.id, action: 'source.binding.delete', targetId: bindingId, details: { objectIds: { projectId } } }]);
  }
  /** Same grants back the project matrix and the specialist screen. Missing row = no access. */
  setGrant(actor: SourceActor, projectId: string, input: { bindingId: string; profileId: string; enabled: boolean; outputPolicy?: SourceOutputPolicy | null; bindingRevision: number }) {
    this.requireBinding(actor, projectId, input.bindingId);
    if (input.enabled && !this.directory.connectedProfiles(projectId).some(p => p.id === input.profileId)) throw new BridgeError('Сначала подключите специалиста к проекту.', 409);
    return this.registry.tx(() => {
      const binding = this.binding(input.bindingId)!;
      if (binding.revision !== input.bindingRevision) throw new BridgeError('Привязка изменена другим пользователем. Обновите данные.', 409);
      if (input.enabled) this.db.prepare('INSERT INTO grants VALUES (?,?,?,1,?) ON CONFLICT(project_id,profile_id,binding_id) DO UPDATE SET enabled=1, output_policy=excluded.output_policy')
        .run(projectId, input.profileId, input.bindingId, input.outputPolicy ?? null);
      else this.db.prepare('DELETE FROM grants WHERE project_id=? AND profile_id=? AND binding_id=?').run(projectId, input.profileId, input.bindingId);
      // Any grant change is a policy change: the run scope hash changes and executors start a new context.
      this.db.prepare('UPDATE bindings SET revision=revision+1 WHERE id=?').run(input.bindingId);
      return this.publicBinding(this.binding(input.bindingId)!);
    }, () => [{ actorId: actor.id, action: input.enabled ? 'source.grant.enable' : 'source.grant.disable', targetId: input.bindingId, details: { objectIds: { projectId, profileId: input.profileId } } }]);
  }
  grants(projectId: string) {
    return (this.db.prepare('SELECT project_id projectId, profile_id profileId, binding_id bindingId, enabled, output_policy outputPolicy FROM grants WHERE project_id=?').all(projectId) as
      { projectId: string; profileId: string; bindingId: string; enabled: number; outputPolicy: SourceOutputPolicy | null }[]);
  }

  // ---- settings, dates and bundles -----------------------------------------------------------
  settings(projectId: string): ProjectSourceSettings {
    const row = this.db.prepare('SELECT * FROM project_settings WHERE project_id=?').get(projectId) as { business_time_zone: string; current_date_rule: number; revision: number } | undefined;
    return { projectId, businessTimeZone: row?.business_time_zone ?? 'Europe/Moscow', currentDateRule: !!row?.current_date_rule, revision: row?.revision ?? 0 };
  }
  saveSettings(actor: SourceActor, projectId: string, input: { businessTimeZone: string; currentDateRule: boolean; revision: number }) {
    this.requireProject(actor, projectId);
    if (!this.canManageProject(actor, projectId)) throw new BridgeError('Недостаточно прав для настройки источников проекта.', 403);
    try { new Intl.DateTimeFormat('en-CA', { timeZone: input.businessTimeZone }); } catch { throw new BridgeError('Некорректный часовой пояс проекта.'); }
    return this.registry.tx(() => {
      const current = this.settings(projectId);
      if (current.revision !== input.revision) throw new BridgeError('Настройки изменены другим пользователем.', 409);
      this.db.prepare(`INSERT INTO project_settings VALUES (?,?,?,1) ON CONFLICT(project_id) DO UPDATE SET business_time_zone=excluded.business_time_zone,
        current_date_rule=excluded.current_date_rule, revision=project_settings.revision+1`).run(projectId, input.businessTimeZone, Number(input.currentDateRule));
      this.db.prepare('UPDATE bindings SET revision=revision+1 WHERE project_id=?').run(projectId);
      return this.settings(projectId);
    }, () => [{ actorId: actor.id, action: 'source.project.settings', targetId: projectId }]);
  }
  private activeBundleRow(projectId: string) { return this.db.prepare("SELECT * FROM bundles WHERE project_id=? AND state='active'").get(projectId) as BundleRow | undefined; }
  private publicBundle(row: BundleRow): SourceBundle {
    return { id: row.id, projectId: row.project_id, label: row.label, revision: row.revision, state: row.state === 'draft' ? 'archived' : row.state, items: parse(row.items, []),
      createdBy: row.created_by, createdAt: row.created_at };
  }
  bundles(actor: SourceActor, projectId: string) {
    this.requireManager(actor, projectId);
    return (this.db.prepare('SELECT * FROM bundles WHERE project_id=? ORDER BY created_at DESC').all(projectId) as BundleRow[])
      .map(row => this.publicBundle(row)).filter(bundle => this.canSeeBundle(actor, bundle));
  }
  private canSeeBundle(actor: SourceActor, bundle: SourceBundle) {
    return actor.admin || bundle.items.every(item => {
      const binding = this.binding(item.bindingId);
      return binding && binding.project_id === bundle.projectId && this.manageable(actor, binding.source_id);
    });
  }
  /** Validates that every item uses a ready snapshot of its binding and that confirmed platform dependencies match. */
  private checkBundle(projectId: string, items: { bindingId: string; snapshotId: string }[]) {
    if (!items.length || items.length > 50 || new Set(items.map(i => i.bindingId)).size !== items.length) throw new BridgeError('Укажите версии для разных привязок проекта.');
    const chosen = new Map<string, SnapshotRow>();
    for (const item of items) {
      const binding = this.binding(item.bindingId);
      if (!binding || binding.project_id !== projectId) throw notFound();
      if (binding.selector !== 'pinned') throw new BridgeError('В набор версий входят привязки с закреплённой версией; прайсы выбираются по дате.', 409);
      const snapshot = this.registry.snapshotRow(item.snapshotId);
      if (!snapshot || snapshot.source_id !== binding.source_id) throw notFound();
      if (snapshot.state !== 'ready') throw new BridgeError(`Снимок «${snapshot.label}» ещё не готов.`, 409);
      chosen.set(binding.source_id, snapshot);
    }
    const warnings: string[] = [];
    for (const snapshot of chosen.values()) {
      for (const dep of this.registry.dependencies(snapshot.id)) {
        const platform = this.registry.snapshotRow(dep.id)!;
        const picked = chosen.get(platform.source_id);
        if (!picked) warnings.push(`Для «${snapshot.label}» подтверждена зависимость от «${platform.label}», но этот источник не входит в набор: цепочка не будет проверена полностью.`);
        else if (picked.id !== platform.id) throw new BridgeError(`«${snapshot.label}» подтверждён для «${platform.label}», а в набор выбран «${picked.label}». Выберите совместимую пару или подтвердите зависимость.`, 409);
      }
    }
    return warnings;
  }
  createBundle(actor: SourceActor, projectId: string, input: { label: string; items: { bindingId: string; snapshotId: string }[]; activate?: boolean; expectedActiveRevision?: number }) {
    this.requireProject(actor, projectId);
    for (const item of input.items) this.requireBinding(actor, projectId, item.bindingId);
    const label = input.label.trim();
    if (!label || label.length > 120) throw new BridgeError('Укажите название набора до 120 символов.');
    const id = 'bdl_' + randomUUID().replaceAll('-', '');
    return this.registry.tx(() => {
      const warnings = this.checkBundle(projectId, input.items);
      this.db.prepare("INSERT INTO bundles VALUES (?,?,?,1,?,'draft',?,?,NULL)").run(id, projectId, label, JSON.stringify(input.items), actor.id, new Date().toISOString());
      if (input.activate) this.activateInside(projectId, id, input.expectedActiveRevision);
      return { bundle: this.publicBundle(this.db.prepare('SELECT * FROM bundles WHERE id=?').get(id) as BundleRow), warnings };
    }, () => [{ actorId: actor.id, action: input.activate ? 'source.bundle.activate' : 'source.bundle.create', targetId: id, details: { objectIds: { projectId } } }]);
  }
  /** Atomic switch of all bindings in the bundle; a concurrent switch is a conflict. */
  activateBundle(actor: SourceActor, projectId: string, bundleId: string, expectedActiveRevision?: number) {
    this.requireProject(actor, projectId);
    const row = this.db.prepare('SELECT * FROM bundles WHERE id=? AND project_id=?').get(bundleId, projectId) as BundleRow | undefined;
    if (!row) throw notFound();
    for (const item of parse<{ bindingId: string }[]>(row.items, [])) this.requireBinding(actor, projectId, item.bindingId);
    return this.registry.tx(() => {
      const warnings = this.checkBundle(projectId, parse(row.items, []));
      this.activateInside(projectId, bundleId, expectedActiveRevision);
      return { bundle: this.publicBundle(this.db.prepare('SELECT * FROM bundles WHERE id=?').get(bundleId) as BundleRow), warnings };
    }, () => [{ actorId: actor.id, action: 'source.bundle.activate', targetId: bundleId, details: { objectIds: { projectId } } }]);
  }
  private activateInside(projectId: string, bundleId: string, expectedActiveRevision?: number) {
    const active = this.activeBundleRow(projectId);
    const activeRevision = this.activeRevision(projectId);
    if (expectedActiveRevision !== undefined && expectedActiveRevision !== activeRevision) throw new BridgeError('Набор версий проекта уже изменён другим пользователем.', 409);
    if (active?.id === bundleId) return;
    if (active) this.db.prepare("UPDATE bundles SET state='archived' WHERE id=?").run(active.id);
    this.db.prepare("UPDATE bundles SET state='active', activated_at=?, revision=? WHERE id=?").run(new Date().toISOString(), activeRevision + 1, bundleId);
    this.db.prepare('UPDATE bindings SET revision=revision+1 WHERE project_id=?').run(projectId);
  }
  /** Monotonic counter of bundle switches for a project, used as expected revision. */
  activeRevision(projectId: string) { return (this.db.prepare('SELECT coalesce(max(revision),0) n FROM bundles WHERE project_id=? AND activated_at IS NOT NULL').get(projectId) as { n: number }).n; }
  /** Snapshots referenced by any binding or bundle; protected from archiving. */
  isBound(snapshotId: string) {
    if (this.db.prepare('SELECT 1 FROM bindings WHERE snapshot_id=? LIMIT 1').get(snapshotId)) return true;
    if ((this.db.prepare('SELECT approved FROM bindings').all() as { approved: string }[]).some(r => parse<string[]>(r.approved, []).includes(snapshotId))) return true;
    if ((this.db.prepare("SELECT items FROM bundles WHERE state='active'").all() as { items: string }[]).some(r => parse<{ snapshotId: string }[]>(r.items, []).some(i => i.snapshotId === snapshotId))) return true;
    if (this.db.prepare('SELECT 1 FROM chat_pins WHERE selection LIKE ? LIMIT 1').get('%"' + snapshotId + '"%')) return true;
    return false;
  }

  // ---- effective access ----------------------------------------------------------------------
  /**
   * The single access rule: project membership ∩ session/role ∩ action ∩ source policy ∩ project binding ∩ specialist grant.
   * userId=undefined evaluates the configured policy (matrix) without a particular employee.
   */
  effective(userId: string | undefined, projectId: string, profileId: string, bindingId: string, action: SourceAction = 'use_for_analysis') {
    const reasons: string[] = [];
    const binding = this.binding(bindingId);
    if (!binding || binding.project_id !== projectId) return { allowed: false, reasons: ['binding_disabled'] as string[], outputPolicy: undefined };
    const source = this.registry.sourceInfo(binding.source_id)!;
    if (userId !== undefined && !this.directory.canAccessProject(userId, projectId)) reasons.push('project_access');
    if (!binding.enabled) reasons.push('binding_disabled');
    if (source.archived_at) reasons.push('source_archived');
    if (!parse<string[]>(binding.allowed_actions, []).includes(action)) reasons.push('action_not_allowed');
    const grant = this.db.prepare('SELECT * FROM grants WHERE project_id=? AND profile_id=? AND binding_id=? AND enabled=1').get(projectId, profileId, bindingId) as { output_policy: SourceOutputPolicy | null } | undefined;
    if (!grant) reasons.push('not_assigned');
    if (!this.directory.connectedProfiles(projectId).some(p => p.id === profileId)) reasons.push('profile_not_connected');
    if (userId !== undefined && !this.directory.canUseProfile(userId, profileId)) reasons.push('profile_forbidden');
    if (source.classification === 'restricted' && !this.directory.closedAnalysisVerified()) reasons.push('closed_analysis_unverified');
    const outputPolicy = strictest(source.output_policy, binding.output_policy, grant?.output_policy);
    return { allowed: reasons.length === 0, reasons, outputPolicy, binding, source };
  }
  isCurrentRunEntry(scope: RunSourceScope, entry: ScopeEntry) {
    const access = this.effective(scope.actorId, scope.projectId, scope.profileId, entry.bindingId);
    return access.allowed && access.binding?.revision === entry.revision && access.source?.policy_revision === entry.policyRevision
      && access.outputPolicy === entry.outputPolicy && access.source.classification === entry.classification
      && this.selectionRevision(access.binding, entry.snapshotId) === entry.selectionRevision;
  }
  private selectionRevision(binding: BindingRow, snapshotId?: string) {
    const revisionOf = (id: string) => {
      const row = this.registry.snapshotRow(id);
      return row && [id, row.state, row.index_generation, row.metadata_revision];
    };
    if (snapshotId) return JSON.stringify(revisionOf(snapshotId));
    return createHash('sha256').update(JSON.stringify([
      this.settings(binding.project_id).revision,
      parse<string[]>(binding.approved, []).map(revisionOf),
    ])).digest('hex');
  }
  /** Resolves the snapshot for a binding: active bundle, then pinned version, then effective date. */
  resolve(bindingId: string, options: { date?: string; pinned?: Record<string, string> } = {}):
    { snapshot: SnapshotRow; via: 'bundle' | 'pinned' | 'date' | 'chat' } | { problem: 'no_snapshot' | 'snapshot_not_ready' | 'date_required' | 'conflict' | 'invalid_date'; candidates?: string[] } {
    const binding = this.binding(bindingId);
    if (!binding) return { problem: 'no_snapshot' };
    const chat = options.pinned?.[bindingId];
    if (chat && binding.selector === 'pinned') {
      const snapshot = this.registry.snapshotRow(chat);
      return snapshot?.state === 'ready' && snapshot.source_id === binding.source_id ? { snapshot, via: 'chat' } : { problem: 'snapshot_not_ready' };
    }
    if (binding.selector === 'pinned') {
      const active = this.activeBundleRow(binding.project_id);
      const fromBundle = active && parse<{ bindingId: string; snapshotId: string }[]>(active.items, []).find(i => i.bindingId === bindingId)?.snapshotId;
      const id = fromBundle ?? binding.snapshot_id;
      if (!id) return { problem: 'no_snapshot' };
      const snapshot = this.registry.snapshotRow(id);
      if (!snapshot || snapshot.state !== 'ready') return { problem: 'snapshot_not_ready' };
      return { snapshot, via: fromBundle ? 'bundle' : 'pinned' };
    }
    const date = options.date;
    if (!date) return { problem: 'date_required' };
    if (!validDate(date)) return { problem: 'invalid_date' };
    const approved = parse<string[]>(binding.approved, []).map(id => this.registry.snapshotRow(id)).filter((s): s is SnapshotRow => s?.state === 'ready')
      .map(s => ({ id: s.id, validFrom: s.valid_from ?? undefined, validTo: s.valid_to ?? undefined, row: s }));
    const result = selectByDate(approved, date);
    if (result.kind === 'one') return { snapshot: result.item.row, via: 'date' };
    if (result.kind === 'conflict') return { problem: 'conflict', candidates: result.items.map(i => i.row.label) };
    if (result.kind === 'invalid') return { problem: 'invalid_date' };
    return { problem: 'no_snapshot' };
  }
  /** Date for price selection: explicit user date, otherwise the project's configured business-date rule. Never the upload date. */
  effectiveDate(projectId: string, explicit?: string) {
    if (explicit) return validDate(explicit) ? { date: explicit, origin: 'user' as const } : { problem: 'invalid_date' as const };
    const settings = this.settings(projectId);
    if (settings.currentDateRule) return { date: businessDate(settings.businessTimeZone), origin: 'project_rule' as const };
    return { problem: 'date_required' as const };
  }
  periodWarnings(bindingId: string) {
    const binding = this.binding(bindingId);
    if (!binding || binding.selector !== 'effective_date') return [];
    const rows = parse<string[]>(binding.approved, []).map(id => this.registry.snapshotRow(id)).filter((s): s is SnapshotRow => !!s)
      .map(s => ({ id: s.id, label: s.label, validFrom: s.valid_from ?? undefined, validTo: s.valid_to ?? undefined }));
    const labels = new Map(rows.map(r => [r.id, r.label]));
    const warnings = periodConflicts(rows).map(([a, b]) => `Периоды «${labels.get(a)}» и «${labels.get(b)}» пересекаются`);
    const sorted = rows.filter(r => r.validFrom).sort((a, b) => a.validFrom!.localeCompare(b.validFrom!));
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].validTo && sorted[i - 1].validTo! < sorted[i].validFrom!) warnings.push(`Пробел между «${sorted[i - 1].label}» и «${sorted[i].label}»`);
    return warnings;
  }
  private selectionLabel(bindings: BindingRow[]) {
    const parts: string[] = [];
    for (const row of bindings.filter(binding => binding.enabled)) {
      const name = this.registry.sourceInfo(row.source_id)?.name ?? row.source_id;
      if (row.selector === 'effective_date') { parts.push(`${name}: прайсы на дату`); continue; }
      const resolved = this.resolve(row.id);
      parts.push(`${name} ${'snapshot' in resolved ? resolved.snapshot.label : '—'}`);
    }
    return parts.join(' → ');
  }
  private requireManager(actor: SourceActor, projectId: string) {
    this.requireProject(actor, projectId);
    if (!this.canManageProject(actor, projectId)) throw new BridgeError('Проект не найден.', 404);
  }
  matrix(actor: SourceActor, projectId: string): SourceMatrix {
    this.requireManager(actor, projectId);
    const bindings = (this.db.prepare('SELECT * FROM bindings WHERE project_id=? ORDER BY rowid').all(projectId) as BindingRow[]).filter(r => this.manageable(actor, r.source_id));
    const profiles = this.directory.connectedProfiles(projectId);
    const cells: MatrixCell[] = [];
    for (const binding of bindings) for (const profile of profiles) {
      const access = this.effective(undefined, projectId, profile.id, binding.id);
      const resolved = this.resolve(binding.id, { date: binding.selector === 'effective_date' ? this.effectiveDate(projectId).date : undefined });
      const reasons = [...access.reasons];
      if ('problem' in resolved && resolved.problem !== 'date_required') reasons.push(resolved.problem === 'conflict' ? 'Пересечение периодов' : accessReasons[resolved.problem] ?? resolved.problem);
      cells.push({ bindingId: binding.id, profileId: profile.id, granted: !access.reasons.includes('not_assigned'), allowed: access.allowed && !('problem' in resolved && resolved.problem !== 'date_required'),
        outputPolicy: access.outputPolicy, reasons: reasons.map(r => accessReasons[r] ?? r) });
    }
    const activeRow = this.activeBundleRow(projectId);
    const active = activeRow && this.publicBundle(activeRow);
    return {
      projectId, profiles, cells, activeBundle: active && this.canSeeBundle(actor, active) ? active : undefined, selectionLabel: this.selectionLabel(bindings),
      bindings: bindings.map(row => {
        const source = this.registry.sourceInfo(row.source_id)!;
        const resolved = this.resolve(row.id);
        return { ...this.publicBinding(row), sourceName: source.name, kind: source.kind,
          selection: row.selector === 'effective_date' ? 'Прайсы на дату' : 'snapshot' in resolved ? resolved.snapshot.label : 'Нет готового снимка' };
      }),
    };
  }

  // ---- run scope and chat pinning ------------------------------------------------------------
  /** Sources the run may use, from the same rule as the matrix; the hash enters the executor session scope. */
  runScope(userId: string, projectId: string, profileId: string, pinned?: Record<string, string>): RunSourceScope {
    const entries: ScopeEntry[] = [];
    for (const row of this.db.prepare('SELECT * FROM bindings WHERE project_id=? AND enabled=1 ORDER BY rowid').all(projectId) as BindingRow[]) {
      const access = this.effective(userId, projectId, profileId, row.id);
      if (!access.allowed) continue;
      const source = access.source!;
      const resolved = row.selector === 'pinned' ? this.resolve(row.id, { pinned }) : undefined;
      if (resolved && 'problem' in resolved) continue;
      entries.push({ bindingId: row.id, sourceId: row.source_id, sourceName: source.name, kind: source.kind, selector: row.selector,
        snapshotId: resolved?.snapshot.id, snapshotLabel: resolved?.snapshot.label, outputPolicy: access.outputPolicy!, classification: source.classification,
        revision: row.revision, policyRevision: source.policy_revision, selectionRevision: this.selectionRevision(row, resolved?.snapshot.id) });
    }
    const active = this.activeBundleRow(projectId);
    const effectiveDate = entries.some(entry => entry.selector === 'effective_date') ? this.effectiveDate(projectId).date : undefined;
    const hash = createHash('sha256').update(JSON.stringify([effectiveDate, entries.map(e => [e.bindingId, e.revision, e.policyRevision, e.snapshotId ?? e.selector, e.outputPolicy, e.selectionRevision])])).digest('hex');
    return { projectId, actorId: userId, profileId, entries, hash, effectiveDate, bundleId: active?.id, bundleRevision: active?.revision };
  }
  /** Selection a chat continues with. Changing the project bundle never silently changes a started chat. */
  chatPin(chatId: string) {
    const row = this.db.prepare('SELECT * FROM chat_pins WHERE chat_id=?').get(chatId) as { project_id: string; scope_hash: string; selection: string; pinned_at: string } | undefined;
    return row && { projectId: row.project_id, scopeHash: row.scope_hash, selection: parse<Record<string, string>>(row.selection, {}), pinnedAt: row.pinned_at };
  }
  /**
   * Fixes the run scope at enqueue time. A chat pinned to other versions keeps them; if they are no longer usable the run is refused
   * until the employee switches the chat (event recorded, executor context reset).
   */
  admitRun(runId: string, chatId: string, userId: string, projectId: string, profileId: string) {
    return this.registry.tx(() => {
      const pin = this.chatPin(chatId);
      const current = this.runScope(userId, projectId, profileId);
      let scope = current;
      if (pin && pin.projectId === projectId) {
        const pinnedScope = this.runScope(userId, projectId, profileId, pin.selection);
        const missing = Object.entries(pin.selection).filter(([bindingId, snapshotId]) => {
          const binding = this.binding(bindingId);
          return binding?.enabled && binding.selector === 'pinned' && this.effective(userId, projectId, profileId, bindingId).allowed
            && !pinnedScope.entries.some(e => e.bindingId === bindingId && e.snapshotId === snapshotId);
        });
        if (missing.length) throw Object.assign(new BridgeError('Версии источников этого чата больше недоступны. Переключите чат на текущий набор проекта.', 409), { code: 'source_scope_changed' });
        scope = pinnedScope;
        // Sources that became available after the chat started are pinned now; already pinned versions never change silently.
        const added = pinnedScope.entries.filter(e => e.snapshotId && !(e.bindingId in pin.selection));
        if (added.length) this.db.prepare('UPDATE chat_pins SET selection=? WHERE chat_id=?')
          .run(JSON.stringify({ ...pin.selection, ...Object.fromEntries(added.map(e => [e.bindingId, e.snapshotId!])) }), chatId);
      } else {
        const selection = Object.fromEntries(current.entries.filter(e => e.snapshotId).map(e => [e.bindingId, e.snapshotId!]));
        if (Object.keys(selection).length) this.db.prepare('INSERT OR REPLACE INTO chat_pins VALUES (?,?,?,?,?)').run(chatId, projectId, current.hash, JSON.stringify(selection), new Date().toISOString());
        else if (pin) this.db.prepare('DELETE FROM chat_pins WHERE chat_id=?').run(chatId);
        if (pin && Object.keys(selection).length) this.db.prepare('INSERT INTO chat_scope_events VALUES (?,?,?,?,?)').run(randomUUID(), chatId, new Date().toISOString(), JSON.stringify(pin), JSON.stringify(selection));
      }
      this.db.prepare('INSERT OR REPLACE INTO run_scopes VALUES (?,?,?,?,?,?)').run(runId, projectId, userId, profileId, JSON.stringify(scope), new Date().toISOString());
      return scope;
    });
  }
  /** Explicit switch of a chat to the current project selection; recorded in the chat source history. */
  switchChat(chatId: string, userId: string, projectId: string, profileId: string) {
    return this.registry.tx(() => {
      const pin = this.chatPin(chatId);
      const current = this.runScope(userId, projectId, profileId);
      const selection = Object.fromEntries(current.entries.filter(e => e.snapshotId).map(e => [e.bindingId, e.snapshotId!]));
      this.db.prepare('INSERT OR REPLACE INTO chat_pins VALUES (?,?,?,?,?)').run(chatId, projectId, current.hash, JSON.stringify(selection), new Date().toISOString());
      this.db.prepare('INSERT INTO chat_scope_events VALUES (?,?,?,?,?)').run(randomUUID(), chatId, new Date().toISOString(), pin ? JSON.stringify(pin.selection) : null, JSON.stringify(selection));
      return { previous: pin?.selection, next: selection };
    });
  }
  /** Chat moved to another project: bindings do not move with it. */
  forgetChat(chatId: string) { this.db.prepare('DELETE FROM chat_pins WHERE chat_id=?').run(chatId); }
  chatScopeView(chatId: string, userId: string, projectId: string, profileId: string) {
    const pin = this.chatPin(chatId);
    const current = this.runScope(userId, projectId, profileId);
    const label = (selection: Record<string, string>) => Object.entries(selection).flatMap(([bindingId, snapshotId]) => {
      const access = this.effective(userId, projectId, profileId, bindingId);
      const snapshot = access.allowed && this.registry.snapshotRow(snapshotId);
      return snapshot && snapshot.source_id === access.source?.id ? [`${access.source.name} ${snapshot.label}`] : [];
    }).join(' → ');
    const currentSelection = Object.fromEntries(current.entries.filter(e => e.snapshotId).map(e => [e.bindingId, e.snapshotId!]));
    const events = (this.db.prepare('SELECT at, previous, next FROM chat_scope_events WHERE chat_id=? ORDER BY at').all(chatId) as { at: string; previous: string | null; next: string }[])
      .map(e => ({ at: e.at, previous: e.previous ? label(parse(e.previous, {})) || undefined : undefined, next: label(parse(e.next, {})) }))
      .filter(event => event.previous || event.next);
    const priceSources = current.entries.filter(e => e.selector === 'effective_date').map(e => e.sourceName);
    const differs = !!pin && Object.entries(pin.selection).some(([bindingId, snapshotId]) => bindingId in currentSelection && currentSelection[bindingId] !== snapshotId);
    return { pinned: pin ? label(pin.selection) : undefined, current: label(currentSelection) + (priceSources.length ? (Object.keys(currentSelection).length ? ' · ' : '') + priceSources.map(n => `${n}: на дату`).join(', ') : ''),
      differs, events, sources: current.entries.length };
  }
  storedRunScope(runId: string) {
    const row = this.db.prepare('SELECT scope FROM run_scopes WHERE run_id=?').get(runId) as { scope: string } | undefined;
    return row ? parse<RunSourceScope | undefined>(row.scope, undefined) : undefined;
  }
}
