import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../../shared/types.js';
import {
  delegableSourceActions, excluded, pathKey, pathProblem, sourceActions, sourceDefaults, suspiciousSecret, validDate,
  type ManifestEntry, type SnapshotState, type SnapshotSummary, type SourceAction, type SourceClassification, type SourceKind,
  type SourceOutputPolicy, type SourceSummary, type UploadFileStatus, type UploadSummary,
} from '../../shared/sources.js';
import { AuditJournal, publishAudit, type NewAuditEvent } from '../audit-journal.js';
import { BridgeError } from '../store.js';
import { blobKey, type SourceStorageConfig } from './blob-store.js';

export interface SourceActor { id: string; admin: boolean }
export interface SourceLimits {
  maxFiles: number; maxFileBytes: number; maxDepth: number; maxPathLength: number; partBytes: number; manifestPageEntries: number;
  defaultQuotaBytes: number; uploadTtlMs: number; sessionsPerUser: number; uploadConcurrency: number; indexTextBytes: number; orphanGraceMs: number;
}
const int = (value: string | undefined, fallback: number, min = 1) => {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
};
export function sourceLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): SourceLimits {
  return {
    maxFiles: int(env.BRIDGE_SOURCES_MAX_FILES, sourceDefaults.maxFiles),
    maxFileBytes: int(env.BRIDGE_SOURCES_MAX_FILE_BYTES, sourceDefaults.maxFileBytes),
    maxDepth: int(env.BRIDGE_SOURCES_MAX_DEPTH, sourceDefaults.maxDepth),
    maxPathLength: int(env.BRIDGE_SOURCES_MAX_PATH, sourceDefaults.maxPathLength),
    partBytes: Math.max(5 * 1024 * 1024, int(env.BRIDGE_SOURCES_PART_BYTES, sourceDefaults.partBytes)),
    manifestPageEntries: sourceDefaults.manifestPageEntries,
    defaultQuotaBytes: int(env.BRIDGE_SOURCES_DEFAULT_QUOTA, sourceDefaults.defaultQuotaBytes),
    uploadTtlMs: int(env.BRIDGE_SOURCES_UPLOAD_TTL_MS, sourceDefaults.uploadTtlMs),
    sessionsPerUser: int(env.BRIDGE_SOURCES_SESSIONS_PER_USER, 2),
    uploadConcurrency: int(env.BRIDGE_SOURCES_UPLOAD_CONCURRENCY, 8),
    indexTextBytes: int(env.BRIDGE_SOURCES_INDEX_TEXT_BYTES, 16 * 1024 * 1024),
    orphanGraceMs: int(env.BRIDGE_SOURCES_ORPHAN_GRACE_MS, 3600_000, 0),
  };
}

const schemaVersion = 5;
const migrations: Record<number, string> = {
  1: `
CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('code','documents','prices','mixed')),
  classification TEXT NOT NULL CHECK(classification IN ('shared','restricted')), output_policy TEXT NOT NULL CHECK(output_policy IN ('explanation_only','excerpts_allowed')),
  quota_bytes INTEGER NOT NULL, policy_revision INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
CREATE UNIQUE INDEX sources_name ON sources(lower(name)) WHERE archived_at IS NULL;
CREATE TABLE source_managers (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, user_id TEXT NOT NULL, actions TEXT NOT NULL CHECK(json_valid(actions)), PRIMARY KEY(source_id,user_id));
CREATE TABLE snapshots (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, created_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT, state TEXT NOT NULL, manifest_hash TEXT, total_files INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
  indexed_files INTEGER NOT NULL DEFAULT 0, unsupported_files INTEGER NOT NULL DEFAULT 0, extraction_errors INTEGER NOT NULL DEFAULT 0, index_generation INTEGER NOT NULL DEFAULT 0,
  coverage_accepted_by TEXT, exclusions TEXT NOT NULL CHECK(json_valid(exclusions)), precheck TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(precheck)),
  metadata_revision INTEGER NOT NULL DEFAULT 1, failure TEXT, retained INTEGER NOT NULL DEFAULT 0,
  CHECK(valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to > valid_from)));
CREATE UNIQUE INDEX snapshots_label ON snapshots(source_id, lower(label)) WHERE state NOT IN ('cancelled');
CREATE TABLE blobs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'original' CHECK(kind IN ('original','derived')), state TEXT NOT NULL CHECK(state IN ('pending','verified','orphan','deleted')), created_at INTEGER NOT NULL, orphaned_at INTEGER);
CREATE INDEX blobs_reuse ON blobs(source_id, sha256, size) WHERE state='verified' AND kind='original';
CREATE TABLE snapshot_files (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), file_id TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(id), sha256 TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT, encoding TEXT, extraction_state TEXT NOT NULL DEFAULT 'pending',
  line_count INTEGER, language TEXT, text_blob_id TEXT REFERENCES blobs(id), extraction_note TEXT,
  PRIMARY KEY(snapshot_id,file_id), UNIQUE(snapshot_id,path_key));
CREATE INDEX snapshot_files_path ON snapshot_files(snapshot_id, path);
CREATE INDEX snapshot_files_blob ON snapshot_files(blob_id);
CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), snapshot_id TEXT NOT NULL REFERENCES snapshots(id), actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL, declared_files INTEGER NOT NULL,
  base_snapshot_id TEXT, manifest_pages INTEGER NOT NULL DEFAULT 0, manifest_complete INTEGER NOT NULL DEFAULT 0, manifest_files INTEGER NOT NULL DEFAULT 0, manifest_bytes INTEGER NOT NULL DEFAULT 0,
  complete_key TEXT, failure TEXT, created_at INTEGER NOT NULL, UNIQUE(actor_id, idempotency_key));
CREATE TABLE upload_manifest_pages (upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE, page INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(upload_id,page));
CREATE TABLE upload_files (upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE, file_id TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, state TEXT NOT NULL, blob_id TEXT REFERENCES blobs(id), s3_upload_id TEXT, parts_total INTEGER NOT NULL, secret_findings TEXT, secret_decision TEXT, failure TEXT, ordinal INTEGER NOT NULL,
  PRIMARY KEY(upload_id,file_id), UNIQUE(upload_id,path_key));
CREATE INDEX upload_files_state ON upload_files(upload_id, state, ordinal);
CREATE TABLE upload_parts (upload_id TEXT NOT NULL, file_id TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, etag TEXT NOT NULL,
  PRIMARY KEY(upload_id,file_id,part), FOREIGN KEY(upload_id,file_id) REFERENCES upload_files(upload_id,file_id) ON DELETE CASCADE);
CREATE TABLE index_jobs (snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id), generation INTEGER NOT NULL, state TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE index_file_results (snapshot_id TEXT NOT NULL, generation INTEGER NOT NULL, file_id TEXT NOT NULL, media_type TEXT, encoding TEXT, extraction_state TEXT NOT NULL,
  line_count INTEGER, language TEXT, text_blob_id TEXT, note TEXT, PRIMARY KEY(snapshot_id, generation, file_id));
CREATE VIRTUAL TABLE chunks USING fts5(snapshot_id UNINDEXED, generation UNINDEXED, file_id UNINDEXED, start_line UNINDEXED, text, tokenize='trigram');
CREATE TABLE line_index (snapshot_id TEXT NOT NULL, generation INTEGER NOT NULL, file_id TEXT NOT NULL, line INTEGER NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY(snapshot_id,generation,file_id,line));
CREATE TABLE symbols (snapshot_id TEXT NOT NULL, generation INTEGER NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER, language TEXT NOT NULL);
CREATE INDEX symbols_name ON symbols(snapshot_id, generation, name);
CREATE TABLE dependencies (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), platform_snapshot_id TEXT NOT NULL REFERENCES snapshots(id), kind TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, platform_snapshot_id), CHECK(snapshot_id <> platform_snapshot_id));
CREATE TABLE bindings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), selector TEXT NOT NULL CHECK(selector IN ('pinned','effective_date')),
  snapshot_id TEXT REFERENCES snapshots(id), approved TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(approved)), allowed_actions TEXT NOT NULL CHECK(json_valid(allowed_actions)),
  output_policy TEXT NOT NULL CHECK(output_policy IN ('explanation_only','excerpts_allowed')), enabled INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, source_id));
CREATE TABLE grants (project_id TEXT NOT NULL, profile_id TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, enabled INTEGER NOT NULL,
  output_policy TEXT CHECK(output_policy IS NULL OR output_policy IN ('explanation_only','excerpts_allowed')), PRIMARY KEY(project_id, profile_id, binding_id));
CREATE TABLE bundles (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, revision INTEGER NOT NULL, items TEXT NOT NULL CHECK(json_valid(items)), state TEXT NOT NULL CHECK(state IN ('active','archived','draft')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT);
CREATE UNIQUE INDEX bundles_active ON bundles(project_id) WHERE state='active';
CREATE TABLE project_settings (project_id TEXT PRIMARY KEY, business_time_zone TEXT NOT NULL, current_date_rule INTEGER NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE chat_pins (chat_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope_hash TEXT NOT NULL, selection TEXT NOT NULL CHECK(json_valid(selection)), pinned_at TEXT NOT NULL);
CREATE TABLE chat_scope_events (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, at TEXT NOT NULL, previous TEXT, next TEXT NOT NULL);
CREATE TABLE run_scopes (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, profile_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(json_valid(scope)), created_at TEXT NOT NULL);
CREATE TABLE run_reads (run_id TEXT NOT NULL, seq INTEGER NOT NULL, binding_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, file_id TEXT NOT NULL, start_line INTEGER, line_count INTEGER, bytes INTEGER NOT NULL,
  excerpt_hash TEXT, text TEXT, PRIMARY KEY(run_id, seq));
`,
  2: `
CREATE TABLE upload_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE legacy_migrations (id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, actor_id TEXT NOT NULL, applied_at TEXT NOT NULL, report TEXT NOT NULL CHECK(json_valid(report)));
CREATE TABLE maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  // Trigram index without positions: about half the size; substring candidates are verified line by line by the reader.
  3: `
DROP TABLE chunks;
CREATE VIRTUAL TABLE chunks USING fts5(snapshot_id UNINDEXED, generation UNINDEXED, file_id UNINDEXED, start_line UNINDEXED, text, tokenize='trigram', detail=none);
INSERT INTO index_jobs (snapshot_id, generation, state, attempts, created_at)
  SELECT id, index_generation + 1, 'queued', 0, CAST(strftime('%s','now') AS INTEGER) * 1000 FROM snapshots WHERE state='ready'
  ON CONFLICT(snapshot_id) DO UPDATE SET generation=excluded.generation, state='queued', attempts=0, lease_owner=NULL, lease_until=NULL;
`,
  4: `
PRAGMA secure_delete=ON;
DROP TABLE run_reads;
`,
  5: `
ALTER TABLE upload_sessions ADD COLUMN skip_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions ADD COLUMN unchanged_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL;
`,
};

type SourceRow = { id: string; name: string; description: string; kind: SourceKind; classification: SourceClassification; output_policy: SourceOutputPolicy; quota_bytes: number;
  policy_revision: number; created_by: string; created_at: string; archived_at: string | null };
export type SnapshotRow = { id: string; source_id: string; label: string; created_by: string; uploaded_at: string; valid_from: string | null; valid_to: string | null; state: SnapshotState;
  manifest_hash: string | null; total_files: number; total_bytes: number; indexed_files: number; unsupported_files: number; extraction_errors: number; index_generation: number;
  coverage_accepted_by: string | null; exclusions: string; precheck: string; metadata_revision: number; failure: string | null; retained: number };
type UploadRow = { id: string; source_id: string; snapshot_id: string; actor_id: string; idempotency_key: string; request_hash: string; state: UploadSummary['state']; expires_at: number;
  reserved_bytes: number; declared_files: number; base_snapshot_id: string | null; manifest_pages: number; manifest_complete: number; manifest_files: number; manifest_bytes: number;
  complete_key: string | null; failure: string | null; created_at: number; skip_unchanged: number; unchanged_snapshot_id: string | null };
type UploadFileRow = { upload_id: string; file_id: string; path: string; path_key: string; size: number; sha256: string; state: UploadFileStatus['state']; blob_id: string | null;
  s3_upload_id: string | null; parts_total: number; secret_findings: string | null; secret_decision: string | null; failure: string | null; ordinal: number };
export type SnapshotFileRow = { snapshot_id: string; file_id: string; path: string; path_key: string; blob_id: string; sha256: string; size: number; media_type: string | null;
  encoding: string | null; extraction_state: string; line_count: number | null; language: string | null; text_blob_id: string | null; extraction_note: string | null };

const sha256Hex = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
export const notFound = () => new BridgeError('Источник не найден.', 404);

/** Durable catalog of sources, immutable snapshots and resumable directory uploads. */
export class SourceRegistry {
  readonly db: DatabaseSync;
  private readonly audit: AuditJournal;
  private activeParts = 0;
  private fileLocks = new Map<string, Promise<unknown>>();
  constructor(root: string, readonly storage: SourceStorageConfig, readonly limits: SourceLimits = sourceLimitsFromEnv(), private readonly now = () => Date.now()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'sources.sqlite');
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate();
      this.audit = new AuditJournal(this.db);
    } catch (error) { this.db.close(); throw error; }
  }
  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > schemaVersion) throw new BridgeError('База источников создана более новой версией приложения.', 500);
    for (let version = current + 1; version <= schemaVersion; version++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const again = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (again < version) { this.db.exec(migrations[version]); this.db.exec(`PRAGMA user_version=${version}`); }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  get schemaVersion() { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
  close() { this.db.close(); this.storage.store?.close(); }

  /** Runs write in one IMMEDIATE transaction; audit events commit with the change. */
  tx<T>(write: () => T, events: (value: T) => NewAuditEvent[] = () => []): T {
    this.db.exec('BEGIN IMMEDIATE');
    let value: T; let inserted: AuditEvent[] = [];
    try {
      value = write();
      inserted = events(value).map(event => this.audit.insert(event));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    inserted.forEach(publishAudit);
    return value;
  }
  recordAudit(event: NewAuditEvent) { publishAudit(this.audit.insert(event)); }
  auditPage(before?: { at: number; id: string }) { return this.audit.page(before); }

  private store() {
    if (!this.storage.store) throw new BridgeError(this.storage.problem ?? 'Хранилище источников не настроено.', 503);
    return this.storage.store;
  }
  storageStatus() {
    return { configured: !!this.storage.store, kind: this.storage.store?.kind, problem: this.storage.problem,
      limits: { maxFiles: this.limits.maxFiles, maxFileBytes: this.limits.maxFileBytes, partBytes: this.limits.partBytes, maxDepth: this.limits.maxDepth,
        maxPathLength: this.limits.maxPathLength, defaultQuotaBytes: this.limits.defaultQuotaBytes, uploadConcurrency: this.limits.uploadConcurrency },
      activeParts: this.activeParts, ...this.metrics() };
  }
  metrics() {
    const one = <T>(sql: string, ...args: (string | number)[]) => this.db.prepare(sql).get(...args) as T;
    return {
      indexQueue: one<{ n: number }>("SELECT count(*) n FROM index_jobs WHERE state IN ('queued','running')").n,
      indexFailures: one<{ n: number }>("SELECT count(*) n FROM index_jobs WHERE state='failed'").n,
      openUploads: one<{ n: number }>("SELECT count(*) n FROM upload_sessions WHERE state='open'").n,
      orphanBlobs: one<{ n: number }>("SELECT count(*) n FROM blobs WHERE state='orphan'").n,
      unsupportedFiles: one<{ n: number }>("SELECT coalesce(sum(unsupported_files),0) n FROM snapshots WHERE state='ready'").n,
      indexChunks: one<{ n: number }>('SELECT count(*) n FROM chunks').n,
    };
  }

  // ---- authorization -------------------------------------------------------------------------
  private sourceRow(id: string) { return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined; }
  managerActions(sourceId: string, userId: string): SourceAction[] {
    const row = this.db.prepare('SELECT actions FROM source_managers WHERE source_id=? AND user_id=?').get(sourceId, userId) as { actions: string } | undefined;
    return json<SourceAction[]>(row?.actions, []).filter(a => delegableSourceActions.includes(a));
  }
  can(actor: SourceActor, sourceId: string, action: SourceAction) {
    if (!this.sourceRow(sourceId)) return false;
    if (actor.admin) return action !== 'use_for_analysis';
    return this.managerActions(sourceId, actor.id).includes(action);
  }
  /** Returns the source if visible to a manager; unknown and foreign ids are indistinguishable (404). */
  requireSource(actor: SourceActor, sourceId: string, action: SourceAction) {
    const row = this.sourceRow(sourceId);
    const visible = row && (actor.admin || this.managerActions(sourceId, actor.id).length > 0);
    if (!row || !visible) { this.deny(actor, sourceId, action, 'not_visible'); throw notFound(); }
    if (!this.can(actor, sourceId, action)) { this.deny(actor, sourceId, action, 'forbidden'); throw new BridgeError('Недостаточно прав для этого действия с источником.', 403); }
    return row;
  }
  deny(actor: SourceActor, targetId: string, action: string, reason: string) {
    this.recordAudit({ actorId: actor.id, action: 'source.denied', targetId, details: { success: false, objectIds: { action, reason } } });
  }

  // ---- sources -------------------------------------------------------------------------------
  private usedBytes(sourceId: string) {
    return (this.db.prepare("SELECT coalesce(sum(size),0) n FROM blobs WHERE source_id=? AND state IN ('verified','pending')").get(sourceId) as { n: number }).n;
  }
  private reservedBytes(sourceId: string) {
    return (this.db.prepare("SELECT coalesce(sum(reserved_bytes),0) n FROM upload_sessions WHERE source_id=? AND state IN ('open','completing')").get(sourceId) as { n: number }).n;
  }
  snapshotSummary(row: SnapshotRow): SnapshotSummary {
    return { id: row.id, sourceId: row.source_id, label: row.label, createdBy: row.created_by, uploadedAt: row.uploaded_at, validFrom: row.valid_from ?? undefined,
      validTo: row.valid_to ?? undefined, state: row.state, totalFiles: row.total_files, totalBytes: row.total_bytes, indexedFiles: row.indexed_files,
      unsupportedFiles: row.unsupported_files, extractionErrors: row.extraction_errors, indexGeneration: row.index_generation,
      coverageAcceptedBy: row.coverage_accepted_by ?? undefined, metadataRevision: row.metadata_revision, manifestHash: row.manifest_hash ?? undefined, failure: row.failure ?? undefined };
  }
  private summary(row: SourceRow, actor: SourceActor): SourceSummary {
    const managers = (this.db.prepare('SELECT user_id, actions FROM source_managers WHERE source_id=? ORDER BY user_id').all(row.id) as { user_id: string; actions: string }[])
      .map(m => ({ userId: m.user_id, actions: json<SourceAction[]>(m.actions, []) }));
    const latest = this.db.prepare("SELECT * FROM snapshots WHERE source_id=? AND state<>'cancelled' ORDER BY uploaded_at DESC LIMIT 1").get(row.id) as SnapshotRow | undefined;
    const snapshots = (this.db.prepare("SELECT count(*) n FROM snapshots WHERE source_id=? AND state NOT IN ('cancelled')").get(row.id) as { n: number }).n;
    return { id: row.id, name: row.name, description: row.description, kind: row.kind, classification: row.classification, outputPolicy: row.output_policy,
      quotaBytes: row.quota_bytes, usedBytes: this.usedBytes(row.id), reservedBytes: this.reservedBytes(row.id), policyRevision: row.policy_revision,
      createdAt: row.created_at, archivedAt: row.archived_at ?? undefined, managers, snapshots, latestSnapshot: latest && this.snapshotSummary(latest),
      canManage: this.can(actor, row.id, 'manage_source'), canUpload: this.can(actor, row.id, 'upload_snapshot') };
  }
  listSources(actor: SourceActor) {
    const rows = actor.admin
      ? this.db.prepare('SELECT * FROM sources ORDER BY archived_at IS NOT NULL, lower(name)').all() as SourceRow[]
      : this.db.prepare('SELECT s.* FROM sources s JOIN source_managers m ON m.source_id=s.id AND m.user_id=? ORDER BY s.archived_at IS NOT NULL, lower(s.name)').all(actor.id) as SourceRow[];
    return rows.map(row => this.summary(row, actor));
  }
  getSource(actor: SourceActor, id: string) { return this.summary(this.requireSource(actor, id, 'manage_source'), actor); }
  /** Source metadata for an already authorized internal caller (bindings, tools). */
  sourceInfo(id: string) { return this.sourceRow(id); }
  createSource(actor: SourceActor, input: { name: string; description?: string; kind: SourceKind; classification: SourceClassification; outputPolicy?: SourceOutputPolicy; quotaBytes?: number;
    managers?: { userId: string; actions: SourceAction[] }[] }) {
    if (!actor.admin) throw new BridgeError('Создавать источники может руководитель.', 403);
    const name = input.name.trim();
    if (!name || name.length > 120) throw new BridgeError('Укажите название источника до 120 символов.');
    const quota = input.quotaBytes ?? this.limits.defaultQuotaBytes;
    if (!Number.isSafeInteger(quota) || quota < 1) throw new BridgeError('Некорректная квота.');
    const id = 'src_' + randomUUID().replaceAll('-', '');
    this.validateManagers(input.managers ?? []);
    try {
      return this.tx(() => {
        this.db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(id, name, (input.description ?? '').trim().slice(0, 2000), input.kind, input.classification,
          input.outputPolicy ?? 'explanation_only', quota, 1, actor.id, new Date(this.now()).toISOString());
        for (const m of input.managers ?? []) this.db.prepare('INSERT INTO source_managers VALUES (?,?,?)').run(id, m.userId, JSON.stringify([...new Set(m.actions)]));
        return this.summary(this.sourceRow(id)!, actor);
      }, () => [{ actorId: actor.id, action: 'source.create', targetId: id }]);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) throw new BridgeError('Источник с таким названием уже есть.', 409);
      throw error;
    }
  }
  private validateManagers(managers: { userId: string; actions: SourceAction[] }[]) {
    if (managers.length > 50 || new Set(managers.map(m => m.userId)).size !== managers.length
      || managers.some(m => typeof m.userId !== 'string' || !m.userId || m.userId.length > 100 || m.actions.some(a => !delegableSourceActions.includes(a)))) {
      throw new BridgeError('Проверьте список управляющих и их действия.');
    }
  }
  updateSource(actor: SourceActor, id: string, input: { revision: number; name?: string; description?: string; classification?: SourceClassification; outputPolicy?: SourceOutputPolicy;
    quotaBytes?: number; managers?: { userId: string; actions: SourceAction[] }[] }) {
    const row = this.requireSource(actor, id, 'manage_source');
    if ((input.managers || input.classification || input.quotaBytes !== undefined) && !actor.admin) throw new BridgeError('Права, классификацию и квоту меняет руководитель.', 403);
    if (input.managers) this.validateManagers(input.managers);
    return this.tx(() => {
      const current = this.sourceRow(id)!;
      if (current.policy_revision !== input.revision) throw new BridgeError('Источник изменён другим пользователем. Обновите данные.', 409);
      const name = input.name?.trim() ?? row.name;
      if (!name || name.length > 120) throw new BridgeError('Укажите название источника до 120 символов.');
      const quota = input.quotaBytes ?? row.quota_bytes;
      if (!Number.isSafeInteger(quota) || quota < this.usedBytes(id)) throw new BridgeError('Квота меньше занятого объёма.', 409);
      this.db.prepare('UPDATE sources SET name=?, description=?, classification=?, output_policy=?, quota_bytes=?, policy_revision=policy_revision+1 WHERE id=?')
        .run(name, (input.description ?? row.description).trim().slice(0, 2000), input.classification ?? row.classification, input.outputPolicy ?? row.output_policy, quota, id);
      if (input.managers) {
        this.db.prepare('DELETE FROM source_managers WHERE source_id=?').run(id);
        for (const m of input.managers) this.db.prepare('INSERT INTO source_managers VALUES (?,?,?)').run(id, m.userId, JSON.stringify([...new Set(m.actions)]));
      }
      return this.summary(this.sourceRow(id)!, actor);
    }, () => [{ actorId: actor.id, action: 'source.update', targetId: id, details: { previousRevision: String(input.revision) } }]);
  }
  archiveSource(actor: SourceActor, id: string, revision: number) {
    this.requireSource(actor, id, 'manage_source');
    return this.tx(() => {
      const row = this.sourceRow(id)!;
      if (row.policy_revision !== revision) throw new BridgeError('Источник изменён другим пользователем. Обновите данные.', 409);
      // Archiving disables new project bindings; existing ones are listed in usage and stay until a manager detaches them.
      this.db.prepare('UPDATE sources SET archived_at=coalesce(archived_at, ?), policy_revision=policy_revision+1 WHERE id=?').run(new Date(this.now()).toISOString(), id);
      return this.summary(this.sourceRow(id)!, actor);
    }, () => [{ actorId: actor.id, action: 'source.archive', targetId: id }]);
  }
  /** Physical deletion only after archiving and when no binding, open upload, queued index job or retained snapshot remains. */
  deleteSource(actor: SourceActor, id: string) {
    this.requireSource(actor, id, 'delete_source');
    const blockers = this.deletionBlockers(id);
    if (blockers.length) throw new BridgeError('Источник используется: ' + blockers.join('; ') + '.', 409);
    return this.tx(() => {
      if (this.deletionBlockers(id).length) throw new BridgeError('Источник используется.', 409);
      const at = this.now();
      this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE source_id=? AND state IN ('verified','pending')").run(at, id);
      for (const table of ['line_index', 'symbols']) this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?)`).run(id);
      this.db.prepare('DELETE FROM chunks WHERE snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM dependencies WHERE snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?) OR platform_snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?)').run(id, id);
      this.db.prepare('DELETE FROM index_jobs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM upload_sessions WHERE source_id=?').run(id);
      this.db.prepare("UPDATE snapshots SET state='archived' WHERE source_id=?").run(id);
      this.db.prepare('DELETE FROM source_managers WHERE source_id=?').run(id);
      // Rows keep their ids for audit and orphan blob collection; the source becomes invisible.
      this.db.prepare("UPDATE sources SET archived_at=coalesce(archived_at, ?), name=name || ' [удалён ' || id || ']', policy_revision=policy_revision+1 WHERE id=?").run(new Date(at).toISOString(), id);
      return { ok: true };
    }, () => [{ actorId: actor.id, action: 'source.delete', targetId: id }]);
  }
  deletionBlockers(id: string) {
    const blockers: string[] = [];
    const row = this.sourceRow(id);
    if (row && !row.archived_at) blockers.push('сначала архивируйте источник');
    const bindings = (this.db.prepare('SELECT count(*) n FROM bindings WHERE source_id=?').get(id) as { n: number }).n;
    if (bindings) blockers.push(`подключён к проектам: ${bindings}`);
    const uploads = (this.db.prepare("SELECT count(*) n FROM upload_sessions WHERE source_id=? AND state IN ('open','completing')").get(id) as { n: number }).n;
    if (uploads) blockers.push(`активные загрузки: ${uploads}`);
    const jobs = (this.db.prepare("SELECT count(*) n FROM index_jobs j JOIN snapshots s ON s.id=j.snapshot_id WHERE s.source_id=? AND j.state IN ('queued','running')").get(id) as { n: number }).n;
    if (jobs) blockers.push(`задания индексации: ${jobs}`);
    const retained = (this.db.prepare('SELECT count(*) n FROM snapshots WHERE source_id=? AND retained=1').get(id) as { n: number }).n;
    if (retained) blockers.push(`снимки на удержании: ${retained}`);
    const deps = (this.db.prepare('SELECT count(*) n FROM dependencies d JOIN snapshots s ON s.id=d.platform_snapshot_id JOIN snapshots c ON c.id=d.snapshot_id WHERE s.source_id=? AND c.source_id<>?').get(id, id) as { n: number }).n;
    if (deps) blockers.push(`от снимков зависят другие источники: ${deps}`);
    return blockers;
  }

  // ---- snapshots -----------------------------------------------------------------------------
  snapshotRow(id: string) { return this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(id) as SnapshotRow | undefined; }
  listSnapshots(actor: SourceActor, sourceId: string) {
    this.requireSource(actor, sourceId, 'manage_source');
    return (this.db.prepare("SELECT * FROM snapshots WHERE source_id=? AND state<>'cancelled' ORDER BY uploaded_at DESC").all(sourceId) as SnapshotRow[]).map(r => this.snapshotSummary(r));
  }
  /** Separate audited revision of the validity period; content and manifest stay immutable. */
  updateSnapshotMetadata(actor: SourceActor, sourceId: string, snapshotId: string, input: { metadataRevision: number; label?: string; validFrom?: string | null; validTo?: string | null }) {
    this.requireSource(actor, sourceId, 'manage_source');
    for (const value of [input.validFrom, input.validTo]) if (value && !validDate(value)) throw new BridgeError('Дата периода указывается в формате ГГГГ-ММ-ДД.');
    return this.tx(() => {
      const row = this.snapshotRow(snapshotId);
      if (!row || row.source_id !== sourceId) throw notFound();
      if (row.metadata_revision !== input.metadataRevision) throw new BridgeError('Метаданные снимка изменены. Обновите данные.', 409);
      const validFrom = input.validFrom === undefined ? row.valid_from : input.validFrom, validTo = input.validTo === undefined ? row.valid_to : input.validTo;
      if (validTo && (!validFrom || validTo <= validFrom)) throw new BridgeError('Окончание периода должно быть позже начала.');
      const label = input.label?.trim() ?? row.label;
      if (!label || label.length > 120) throw new BridgeError('Укажите версию снимка до 120 символов.');
      this.db.prepare('UPDATE snapshots SET label=?, valid_from=?, valid_to=?, metadata_revision=metadata_revision+1 WHERE id=?').run(label, validFrom, validTo, snapshotId);
      this.bumpBindingsForSource(sourceId);
      return { value: this.snapshotSummary(this.snapshotRow(snapshotId)!), before: { label: row.label, validFrom: row.valid_from, validTo: row.valid_to } };
    }, ({ before }) => [{ actorId: actor.id, action: 'source.snapshot.metadata', targetId: snapshotId,
      details: { objectIds: { sourceId, previous: JSON.stringify(before), validFrom: input.validFrom ?? '', validTo: input.validTo ?? '' } } }]).value;
  }
  /** Policy revisions of bindings change when the effective selection of their snapshots may change. */
  bumpBindingsForSource(sourceId: string) { this.db.prepare('UPDATE bindings SET revision=revision+1 WHERE source_id=?').run(sourceId); }
  acceptCoverage(actor: SourceActor, sourceId: string, snapshotId: string) {
    this.requireSource(actor, sourceId, 'manage_source');
    return this.tx(() => {
      const row = this.snapshotRow(snapshotId);
      if (!row || row.source_id !== sourceId) throw notFound();
      if (row.state !== 'failed' || row.failure !== 'partial_index') throw new BridgeError('Частичное покрытие принимается только для снимка с ошибками индексации.', 409);
      this.db.prepare("UPDATE snapshots SET state='ready', failure=NULL, coverage_accepted_by=? WHERE id=?").run(actor.id, snapshotId);
      this.bumpBindingsForSource(sourceId);
      return this.snapshotSummary(this.snapshotRow(snapshotId)!);
    }, () => [{ actorId: actor.id, action: 'source.snapshot.accept_partial', targetId: snapshotId }]);
  }
  setRetention(actor: SourceActor, sourceId: string, snapshotId: string, retained: boolean) {
    this.requireSource(actor, sourceId, 'manage_source');
    return this.tx(() => {
      const row = this.snapshotRow(snapshotId);
      if (!row || row.source_id !== sourceId) throw notFound();
      this.db.prepare('UPDATE snapshots SET retained=? WHERE id=?').run(retained ? 1 : 0, snapshotId);
      return this.snapshotSummary(this.snapshotRow(snapshotId)!);
    }, () => [{ actorId: actor.id, action: retained ? 'source.snapshot.retain' : 'source.snapshot.release', targetId: snapshotId }]);
  }
  /** Explicit, confirmed configuration → platform dependency. Never inferred from version numbers. */
  setDependencies(actor: SourceActor, sourceId: string, snapshotId: string, platformSnapshotIds: string[]) {
    this.requireSource(actor, sourceId, 'manage_source');
    return this.tx(() => {
      const row = this.snapshotRow(snapshotId);
      if (!row || row.source_id !== sourceId) throw notFound();
      if (platformSnapshotIds.length > 20 || new Set(platformSnapshotIds).size !== platformSnapshotIds.length) throw new BridgeError('Проверьте список зависимостей.');
      for (const id of platformSnapshotIds) {
        const target = this.snapshotRow(id);
        if (!target || target.source_id === sourceId || !this.can(actor, target.source_id, 'manage_source')) throw notFound();
      }
      this.db.prepare('DELETE FROM dependencies WHERE snapshot_id=?').run(snapshotId);
      const at = new Date(this.now()).toISOString();
      for (const id of platformSnapshotIds) this.db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?)').run(snapshotId, id, 'platform', actor.id, at);
      return this.dependencies(snapshotId);
    }, () => [{ actorId: actor.id, action: 'source.snapshot.dependencies', targetId: snapshotId, details: { objectIds: { platform: platformSnapshotIds.join(',') } } }]);
  }
  dependencies(snapshotId: string) {
    return (this.db.prepare('SELECT platform_snapshot_id id, kind, confirmed_by confirmedBy, confirmed_at confirmedAt FROM dependencies WHERE snapshot_id=?').all(snapshotId) as
      { id: string; kind: string; confirmedBy: string; confirmedAt: string }[]);
  }
  snapshotFile(snapshotId: string, fileId: string) {
    return this.db.prepare('SELECT * FROM snapshot_files WHERE snapshot_id=? AND file_id=?').get(snapshotId, fileId) as SnapshotFileRow | undefined;
  }
  /** Lists one directory level of a snapshot from its paths; empty folders are not stored. */
  tree(snapshotId: string, prefix: string, cursor = '', limit = 200) {
    if (prefix && pathProblem(prefix.replace(/\/$/, ''), { maxPathLength: this.limits.maxPathLength, maxDepth: this.limits.maxDepth })) throw new BridgeError('Некорректный путь.');
    const base = prefix ? prefix.replace(/\/?$/, '/') : '';
    const rows = this.db.prepare(`SELECT file_id, path, size, extraction_state, line_count, language FROM snapshot_files WHERE snapshot_id=? AND path >= ? AND path < ? AND path > ? ORDER BY path LIMIT ?`)
      .all(snapshotId, base, base + '￿', cursor ? base + cursor : '', 20_000) as { file_id: string; path: string; size: number; extraction_state: string; line_count: number | null; language: string | null }[];
    const entries: { name: string; type: 'dir' | 'file'; fileId?: string; size?: number; extraction?: string; lines?: number; language?: string }[] = [];
    const seen = new Set<string>();
    let next: string | undefined;
    for (const row of rows) {
      const rest = row.path.slice(base.length);
      const slash = rest.indexOf('/');
      const name = slash >= 0 ? rest.slice(0, slash) : rest;
      if (seen.has(name)) continue;
      if (entries.length >= limit) { next = entries.at(-1)!.name + (entries.at(-1)!.type === 'dir' ? '/￿' : ''); break; }
      seen.add(name);
      entries.push(slash >= 0 ? { name, type: 'dir' } : { name, type: 'file', fileId: row.file_id, size: row.size, extraction: row.extraction_state, lines: row.line_count ?? undefined, language: row.language ?? undefined });
    }
    if (!next && rows.length === 20_000) next = rows.at(-1)!.path.slice(base.length);
    return { path: base, entries, next };
  }

  // ---- uploads -------------------------------------------------------------------------------
  private uploadRow(id: string) { return this.db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id) as UploadRow | undefined; }
  private requireUpload(actor: SourceActor, uploadId: string, sourceId?: string) {
    const row = this.uploadRow(uploadId);
    if (!row || (sourceId && row.source_id !== sourceId) || row.actor_id !== actor.id && !actor.admin) throw new BridgeError('Загрузка не найдена.', 404);
    // Authorization is rechecked on every resume, part and completion.
    this.requireSource(actor, row.source_id, 'upload_snapshot');
    if (row.state === 'open' && row.expires_at <= this.now()) { this.expireUpload(row.id); throw new BridgeError('Срок сессии загрузки истёк. Начните новую загрузку.', 409); }
    return row;
  }
  authorizeUpload(actor: SourceActor, sourceId: string, uploadId: string) { this.requireUpload(actor, uploadId, sourceId); }
  createUpload(actor: SourceActor, sourceId: string, input: { idempotencyKey: string; label: string; validFrom?: string; validTo?: string; totalFiles: number; totalBytes: number;
    exclusions: string[]; baseSnapshotId?: string; skipUnchanged?: boolean }) {
    const source = this.requireSource(actor, sourceId, 'upload_snapshot');
    this.store();
    if (source.archived_at) throw new BridgeError('Источник архивирован.', 409);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) throw new BridgeError('Укажите ключ идемпотентности.');
    const label = input.label.trim();
    if (!label || label.length > 120) throw new BridgeError('Укажите версию снимка до 120 символов.');
    for (const value of [input.validFrom, input.validTo]) if (value && !validDate(value)) throw new BridgeError('Дата периода указывается в формате ГГГГ-ММ-ДД.');
    if (input.validTo && (!input.validFrom || input.validTo <= input.validFrom)) throw new BridgeError('Окончание периода должно быть позже начала.');
    if (source.kind === 'prices' && !input.validFrom) throw new BridgeError('Для прайс-листа укажите дату начала действия.');
    if (!Number.isSafeInteger(input.totalFiles) || input.totalFiles < 1 || input.totalFiles > this.limits.maxFiles) throw new BridgeError(`Каталог должен содержать от 1 до ${this.limits.maxFiles} файлов.`, 413);
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > this.limits.maxFiles * this.limits.maxFileBytes) throw new BridgeError('Некорректный объём каталога.', 413);
    if (input.exclusions.length > 200 || input.exclusions.some(rule => typeof rule !== 'string' || !rule || rule.length > 200)) throw new BridgeError('Проверьте правила исключения.');
    const requestFields = [sourceId, label, input.validFrom ?? null, input.validTo ?? null, input.totalFiles, input.totalBytes, input.exclusions, input.baseSnapshotId ?? null];
    if (input.skipUnchanged) requestFields.push('skip_unchanged');
    const requestHash = hash(JSON.stringify(requestFields));
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM upload_sessions WHERE actor_id=? AND idempotency_key=?').get(actor.id, input.idempotencyKey) as UploadRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new BridgeError('Ключ идемпотентности уже использован с другими параметрами.', 409);
        return { value: this.uploadSummary(existing.id), created: false };
      }
      if (input.baseSnapshotId) {
        const base = this.snapshotRow(input.baseSnapshotId);
        if (!base || base.source_id !== sourceId) throw notFound();
      }
      const baseline = input.baseSnapshotId ?? (input.skipUnchanged ? (this.db.prepare("SELECT id FROM snapshots WHERE source_id=? AND state='ready' ORDER BY uploaded_at DESC, rowid DESC LIMIT 1")
        .get(sourceId) as { id: string } | undefined)?.id : undefined);
      const open = (this.db.prepare("SELECT count(*) n FROM upload_sessions WHERE actor_id=? AND state IN ('open','completing')").get(actor.id) as { n: number }).n;
      if (open >= this.limits.sessionsPerUser) throw new BridgeError('Слишком много одновременных загрузок. Завершите или отмените предыдущую.', 429);
      // Quota is reserved before any byte is accepted, together with parallel sessions.
      if (this.usedBytes(sourceId) + this.reservedBytes(sourceId) + input.totalBytes > source.quota_bytes) throw new BridgeError('Недостаточно квоты источника для этого каталога.', 413);
      const conflict = this.db.prepare("SELECT 1 FROM snapshots WHERE source_id=? AND lower(label)=lower(?) AND state<>'cancelled'").get(sourceId, label);
      if (conflict) throw new BridgeError('Снимок с такой версией уже существует.', 409);
      const snapshotId = 'snp_' + randomUUID().replaceAll('-', ''), uploadId = randomUUID(), at = this.now();
      this.db.prepare(`INSERT INTO snapshots (id, source_id, label, created_by, uploaded_at, valid_from, valid_to, state, exclusions) VALUES (?,?,?,?,?,?,?,'uploading',?)`)
        .run(snapshotId, sourceId, label, actor.id, new Date(at).toISOString(), input.validFrom ?? null, input.validTo ?? null, JSON.stringify(input.exclusions));
      this.db.prepare(`INSERT INTO upload_sessions (id, source_id, snapshot_id, actor_id, idempotency_key, request_hash, state, expires_at, reserved_bytes, declared_files, base_snapshot_id, created_at, skip_unchanged)
        VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?)`).run(uploadId, sourceId, snapshotId, actor.id, input.idempotencyKey, requestHash, at + this.limits.uploadTtlMs, input.totalBytes,
        input.totalFiles, baseline ?? null, at, Number(!!input.skipUnchanged));
      return { value: this.uploadSummary(uploadId), created: true };
    }, ({ value, created }) => created ? [{ actorId: actor.id, action: 'source.upload.create', targetId: value.id,
      details: { objectIds: { sourceId, snapshotId: value.snapshotId, files: String(input.totalFiles), bytes: String(input.totalBytes) } } }] : []).value;
  }
  uploadSummary(uploadId: string): UploadSummary {
    const row = this.uploadRow(uploadId)!;
    const counts = Object.fromEntries((this.db.prepare('SELECT state, count(*) n, coalesce(sum(size),0) b FROM upload_files WHERE upload_id=? GROUP BY state').all(uploadId) as
      { state: string; n: number; b: number }[]).map(r => [r.state, r]));
    const partial = (this.db.prepare("SELECT coalesce(sum(p.size),0) n FROM upload_parts p JOIN upload_files f ON f.upload_id=p.upload_id AND f.file_id=p.file_id WHERE p.upload_id=? AND f.state IN ('pending','uploading')").get(uploadId) as { n: number }).n;
    const n = (state: string) => counts[state]?.n ?? 0, b = (state: string) => counts[state]?.b ?? 0;
    const snapshot = this.snapshotRow(row.unchanged_snapshot_id ?? row.snapshot_id)!;
    return { id: row.id, sourceId: row.source_id, snapshotId: snapshot.id, state: row.state, snapshotState: snapshot.state, unchanged: row.unchanged_snapshot_id ? true : undefined, expiresAt: new Date(row.expires_at).toISOString(),
      reservedBytes: row.reserved_bytes, manifestPages: row.manifest_pages, manifestComplete: !!row.manifest_complete,
      files: { total: row.manifest_files, pending: n('pending'), uploading: n('uploading'), verified: n('verified'), reused: row.unchanged_snapshot_id ? row.manifest_files : n('reused'), failed: n('failed') },
      bytes: { total: row.manifest_bytes, transferred: b('verified') + partial, reused: row.unchanged_snapshot_id ? row.manifest_bytes : b('reused') }, partBytes: this.limits.partBytes, failure: row.failure ?? undefined };
  }
  /** Manifest pages are immutable: an identical retry is accepted, a different page with the same number is a conflict. */
  putManifest(actor: SourceActor, sourceId: string, uploadId: string, input: { page: number; last: boolean; entries: (ManifestEntry & { secretFindings?: string[] })[] }) {
    const session = this.requireUpload(actor, uploadId, sourceId);
    if (!Number.isSafeInteger(input.page) || input.page < 0) throw new BridgeError('Некорректный номер страницы манифеста.');
    if (!Array.isArray(input.entries) || input.entries.length > this.limits.manifestPageEntries) throw new BridgeError(`Страница манифеста содержит до ${this.limits.manifestPageEntries} записей.`);
    const pageHash = hash(JSON.stringify([input.page, input.last, input.entries.map(e => [e.path, e.size, e.sha256, e.secretFindings ?? []])]));
    const exclusions = json<string[]>(this.snapshotRow(session.snapshot_id)!.exclusions, []);
    const problems: { path: string; problem: string }[] = [];
    for (const entry of input.entries) {
      const problem = pathProblem(entry.path, this.limits);
      if (problem) problems.push({ path: String(entry.path).slice(0, 300), problem });
      else if (!Number.isSafeInteger(entry.size) || entry.size < 0) problems.push({ path: entry.path, problem: 'size' });
      else if (entry.size > this.limits.maxFileBytes) problems.push({ path: entry.path, problem: 'too_large' });
      else if (typeof entry.sha256 !== 'string' || !sha256Hex.test(entry.sha256)) problems.push({ path: entry.path, problem: 'sha256' });
      else if (excluded(entry.path, exclusions)) problems.push({ path: entry.path, problem: 'excluded' });
      else if (entry.secretFindings && (!Array.isArray(entry.secretFindings) || entry.secretFindings.length > 10 || entry.secretFindings.some(f => typeof f !== 'string' || f.length > 40))) problems.push({ path: entry.path, problem: 'secret_findings' });
    }
    if (problems.length) throw Object.assign(new BridgeError('Манифест содержит недопустимые записи: ' + problems.slice(0, 5).map(p => `${p.path} (${p.problem})`).join(', ')), { problems });
    return this.tx(() => {
      const current = this.uploadRow(uploadId)!;
      const existing = this.db.prepare('SELECT hash FROM upload_manifest_pages WHERE upload_id=? AND page=?').get(uploadId, input.page) as { hash: string } | undefined;
      if (existing) {
        if (existing.hash !== pageHash) throw new BridgeError('Страница манифеста уже принята с другим содержимым. Начните новую сессию.', 409);
        return { value: this.uploadSummary(uploadId), changed: false };
      }
      if (current.state !== 'open') throw new BridgeError('Сессия загрузки уже закрыта.', 409);
      if (current.manifest_complete) throw new BridgeError('Манифест уже завершён.', 409);
      if (input.page !== current.manifest_pages) throw new BridgeError(`Ожидается страница манифеста ${current.manifest_pages}.`, 409);
      const files = current.manifest_files + input.entries.length, bytes = current.manifest_bytes + input.entries.reduce((s, e) => s + e.size, 0);
      if (files > current.declared_files) throw new BridgeError('Манифест содержит больше файлов, чем заявлено.', 413);
      if (bytes > current.reserved_bytes) throw new BridgeError('Манифест превышает зарезервированный объём.', 413);
      const insert = this.db.prepare(`INSERT INTO upload_files (upload_id, file_id, path, path_key, size, sha256, state, blob_id, parts_total, secret_findings, ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const reuse = this.db.prepare("SELECT id FROM blobs WHERE source_id=? AND sha256=? AND size=? AND state='verified' AND kind='original' LIMIT 1");
      const collisions: string[] = [];
      input.entries.forEach((entry, index) => {
        const key = pathKey(entry.path);
        const clash = this.db.prepare('SELECT path FROM upload_files WHERE upload_id=? AND path_key=?').get(uploadId, key) as { path: string } | undefined;
        if (clash) { collisions.push(`${clash.path} ↔ ${entry.path}`); return; }
        const blob = reuse.get(session.source_id, entry.sha256, entry.size) as { id: string } | undefined;
        const parts = Math.max(1, Math.ceil(entry.size / this.limits.partBytes));
        const findings = entry.secretFindings?.length ? JSON.stringify(entry.secretFindings) : null;
        insert.run(uploadId, 'f_' + randomUUID().replaceAll('-', ''), entry.path, key, entry.size, entry.sha256, blob ? 'reused' : 'pending', blob?.id ?? null, parts, findings, current.manifest_files + index);
      });
      if (collisions.length) throw new BridgeError('Пути различаются только регистром или нормализацией: ' + collisions.slice(0, 5).join(', '), 409);
      if (input.last && files !== current.declared_files) throw new BridgeError(`Заявлено файлов: ${current.declared_files}, в манифесте: ${files}.`, 409);
      this.db.prepare('INSERT INTO upload_manifest_pages VALUES (?,?,?)').run(uploadId, input.page, pageHash);
      this.db.prepare('UPDATE upload_sessions SET manifest_pages=manifest_pages+1, manifest_complete=?, manifest_files=?, manifest_bytes=?, expires_at=? WHERE id=?')
        .run(input.last ? 1 : 0, files, bytes, this.now() + this.limits.uploadTtlMs, uploadId);
      return { value: this.uploadSummary(uploadId), changed: true };
    }, ({ changed }) => changed && input.entries.some(e => e.secretFindings?.length)
      ? [{ actorId: actor.id, action: 'source.upload.secret_flagged', targetId: uploadId, details: { objectIds: { count: String(input.entries.filter(e => e.secretFindings?.length).length) } } }] : []).value;
  }
  /** Explicit, audited manager decision to include a file flagged as a possible secret. */
  secretDecision(actor: SourceActor, sourceId: string, uploadId: string, fileId: string, decision: 'include') {
    const session = this.requireUpload(actor, uploadId, sourceId);
    this.requireSource(actor, session.source_id, 'manage_source');
    return this.tx(() => {
      const file = this.uploadFile(uploadId, fileId);
      if (!file?.secret_findings) throw new BridgeError('Файл не отмечен как подозрительный.', 409);
      this.db.prepare('UPDATE upload_files SET secret_decision=? WHERE upload_id=? AND file_id=?').run(decision, uploadId, fileId);
      return { ok: true };
    }, () => [{ actorId: actor.id, action: 'source.upload.secret_include', targetId: uploadId, details: { objectIds: { fileId } } }]);
  }
  private uploadFile(uploadId: string, fileId: string) {
    return this.db.prepare('SELECT * FROM upload_files WHERE upload_id=? AND file_id=?').get(uploadId, fileId) as UploadFileRow | undefined;
  }
  /** Status with a page of files that still need bytes, in manifest order. */
  uploadStatus(actor: SourceActor, sourceId: string, uploadId: string, cursor = -1, limit = 200) {
    this.requireUpload(actor, uploadId, sourceId);
    const rows = this.db.prepare("SELECT * FROM upload_files WHERE upload_id=? AND state IN ('pending','uploading','failed') AND ordinal>? ORDER BY ordinal LIMIT ?")
      .all(uploadId, cursor, Math.min(Math.max(limit, 1), 1000)) as UploadFileRow[];
    const files: (UploadFileStatus & { failure?: string; secretFindings?: string[]; secretDecision?: string })[] = rows.map(row => ({
      fileId: row.file_id, path: row.path, size: row.size, sha256: row.sha256, state: row.state, partsTotal: row.parts_total,
      partsReceived: (this.db.prepare('SELECT part FROM upload_parts WHERE upload_id=? AND file_id=? ORDER BY part').all(uploadId, row.file_id) as { part: number }[]).map(p => p.part),
      failure: row.failure ?? undefined, secretFindings: json<string[] | undefined>(row.secret_findings, undefined), secretDecision: row.secret_decision ?? undefined,
    }));
    return { upload: this.uploadSummary(uploadId), files, next: rows.length === limit ? rows.at(-1)!.ordinal : undefined, diff: cursor === -1 ? this.diff(uploadId) : undefined };
  }
  /** Differences from the chosen previous snapshot, by path and content hash. */
  diff(uploadId: string) {
    const row = this.uploadRow(uploadId)!;
    if (!row.base_snapshot_id) return undefined;
    if (row.unchanged_snapshot_id) return { baseSnapshotId: row.base_snapshot_id, added: 0, changed: 0, removed: 0 };
    const q = (sql: string) => (this.db.prepare(sql).get(uploadId, row.base_snapshot_id) as { n: number }).n;
    return {
      baseSnapshotId: row.base_snapshot_id,
      added: q('SELECT count(*) n FROM upload_files u WHERE u.upload_id=? AND NOT EXISTS (SELECT 1 FROM snapshot_files s WHERE s.snapshot_id=? AND s.path_key=u.path_key)'),
      changed: q('SELECT count(*) n FROM upload_files u JOIN snapshot_files s ON s.path_key=u.path_key WHERE u.upload_id=? AND s.snapshot_id=? AND (s.path<>u.path OR s.sha256<>u.sha256 OR s.size<>u.size)'),
      removed: (this.db.prepare('SELECT count(*) n FROM snapshot_files s WHERE s.snapshot_id=? AND NOT EXISTS (SELECT 1 FROM upload_files u WHERE u.upload_id=? AND u.path_key=s.path_key)')
        .get(row.base_snapshot_id, uploadId) as { n: number }).n,
    };
  }
  private async lockFile<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.fileLocks.set(key, next);
    try { return await next; } finally { if (this.fileLocks.get(key) === next) this.fileLocks.delete(key); }
  }
  /** Stores one part. The server computes size and SHA-256; a repeated identical part is a no-op. */
  async putPart(actor: SourceActor, sourceId: string, uploadId: string, fileId: string, part: number, body: Buffer, declaredSha256?: string) {
    const session = this.requireUpload(actor, uploadId, sourceId);
    if (session.state !== 'open') throw new BridgeError('Сессия загрузки закрыта.', 409);
    const store = this.store();
    const file = this.uploadFile(uploadId, fileId);
    if (!file) throw new BridgeError('Файл не найден в манифесте.', 404);
    if (!Number.isSafeInteger(part) || part < 1 || part > file.parts_total) throw new BridgeError('Некорректный номер части.');
    const expected = part < file.parts_total ? this.limits.partBytes : file.size - (file.parts_total - 1) * this.limits.partBytes;
    if (body.length !== expected) throw new BridgeError(`Размер части ${part} должен быть ${expected} байт.`, 400);
    const partHash = hash(body);
    if (declaredSha256 && declaredSha256 !== partHash) throw new BridgeError('Хеш части не совпадает: данные повреждены при передаче.', 400);
    if (file.secret_findings && !file.secret_decision) throw new BridgeError('Файл отмечен как возможный секрет. Исключите его или получите решение управляющего.', 409);
    if (part === 1 && !file.secret_decision) {
      const sample = body.subarray(0, 256 * 1024).toString('utf8');
      if (!sample.includes('\0')) {
        const findings = suspiciousSecret(sample);
        if (findings.length) {
          this.db.prepare('UPDATE upload_files SET secret_findings=? WHERE upload_id=? AND file_id=?').run(JSON.stringify(findings), uploadId, fileId);
          this.recordAudit({ actorId: actor.id, action: 'source.upload.secret_flagged', targetId: uploadId, details: { objectIds: { fileId } } });
          throw new BridgeError('Файл похож на секрет (' + findings.join(', ') + '). Исключите его или получите решение управляющего.', 409);
        }
      }
    }
    if (this.activeParts >= this.limits.uploadConcurrency) throw new BridgeError('Сервер загружает другие части. Повторите позже.', 429);
    this.activeParts++;
    try {
      return await this.lockFile(uploadId + '/' + fileId, async () => {
        const current = this.uploadFile(uploadId, fileId)!;
        const existing = this.db.prepare('SELECT sha256 FROM upload_parts WHERE upload_id=? AND file_id=? AND part=?').get(uploadId, fileId, part) as { sha256: string } | undefined;
        if (existing) {
          if (existing.sha256 !== partHash) throw new BridgeError('Часть уже принята с другим содержимым.', 409);
          return { file: this.fileStatus(uploadId, fileId), duplicate: true };
        }
        if (current.state === 'verified' || current.state === 'reused') return { file: this.fileStatus(uploadId, fileId), duplicate: true };
        // Identical content already verified in this source: link instead of storing another copy.
        const known = this.db.prepare("SELECT id FROM blobs WHERE source_id=? AND sha256=? AND size=? AND state='verified' AND kind='original' LIMIT 1").get(session.source_id, current.sha256, current.size) as { id: string } | undefined;
        if (known) {
          if (current.s3_upload_id && current.blob_id) await this.abandonBlob(current.blob_id, current.s3_upload_id);
          this.db.prepare("UPDATE upload_files SET state='reused', blob_id=?, s3_upload_id=NULL, failure=NULL WHERE upload_id=? AND file_id=?").run(known.id, uploadId, fileId);
          this.db.prepare('DELETE FROM upload_parts WHERE upload_id=? AND file_id=?').run(uploadId, fileId);
          return { file: this.fileStatus(uploadId, fileId), duplicate: false };
        }
        let blobId = current.blob_id;
        if (!blobId || current.state === 'failed') {
          blobId = 'b_' + randomUUID().replaceAll('-', '');
          this.db.prepare("INSERT INTO blobs (id, source_id, object_key, sha256, size, state, created_at) VALUES (?,?,?,?,?,'pending',?)")
            .run(blobId, session.source_id, blobKey(session.source_id, blobId), current.sha256, current.size, this.now());
          this.db.prepare("UPDATE upload_files SET blob_id=?, state='uploading', s3_upload_id=NULL, failure=NULL WHERE upload_id=? AND file_id=?").run(blobId, uploadId, fileId);
        }
        const key = blobKey(session.source_id, blobId);
        if (current.parts_total === 1) {
          if (partHash !== current.sha256) return this.failFile(uploadId, fileId, blobId, 'Хеш файла не совпадает с манифестом. Файл изменился во время загрузки — передайте его заново.');
          await store.put(key, body);
          const head = await store.head(key);
          if (!head || head.size !== current.size) return this.failFile(uploadId, fileId, blobId, 'Размер сохранённого объекта не совпадает.');
          this.tx(() => {
            this.db.prepare('INSERT INTO upload_parts VALUES (?,?,?,?,?,?)').run(uploadId, fileId, 1, body.length, partHash, 'single');
            this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(blobId);
            this.db.prepare("UPDATE upload_files SET state='verified' WHERE upload_id=? AND file_id=?").run(uploadId, fileId);
            this.touch(uploadId);
          });
          return { file: this.fileStatus(uploadId, fileId), duplicate: false };
        }
        let s3UploadId = this.uploadFile(uploadId, fileId)!.s3_upload_id;
        if (!s3UploadId) {
          s3UploadId = await store.createMultipart(key);
          this.db.prepare('UPDATE upload_files SET s3_upload_id=? WHERE upload_id=? AND file_id=?').run(s3UploadId, uploadId, fileId);
        }
        const etag = await store.uploadPart(key, s3UploadId, part, body);
        this.tx(() => {
          this.db.prepare('INSERT INTO upload_parts VALUES (?,?,?,?,?,?)').run(uploadId, fileId, part, body.length, partHash, etag);
          this.touch(uploadId);
        });
        const parts = this.db.prepare('SELECT part, etag FROM upload_parts WHERE upload_id=? AND file_id=? ORDER BY part').all(uploadId, fileId) as { part: number; etag: string }[];
        if (parts.length === current.parts_total) await this.finishMultipart(uploadId, fileId, blobId, key, s3UploadId, parts);
        return { file: this.fileStatus(uploadId, fileId), duplicate: false };
      });
    } finally { this.activeParts--; }
  }
  private touch(uploadId: string) { this.db.prepare("UPDATE upload_sessions SET expires_at=? WHERE id=? AND state='open'").run(this.now() + this.limits.uploadTtlMs, uploadId); }
  private fileStatus(uploadId: string, fileId: string): UploadFileStatus & { failure?: string } {
    const row = this.uploadFile(uploadId, fileId)!;
    return { fileId, path: row.path, size: row.size, sha256: row.sha256, state: row.state, partsTotal: row.parts_total, failure: row.failure ?? undefined,
      partsReceived: (this.db.prepare('SELECT part FROM upload_parts WHERE upload_id=? AND file_id=? ORDER BY part').all(uploadId, fileId) as { part: number }[]).map(p => p.part) };
  }
  private async failFile(uploadId: string, fileId: string, blobId: string, message: string): Promise<never> {
    const row = this.uploadFile(uploadId, fileId);
    await this.abandonBlob(blobId, row?.s3_upload_id ?? undefined);
    this.db.prepare("UPDATE upload_files SET state='failed', failure=?, blob_id=NULL, s3_upload_id=NULL WHERE upload_id=? AND file_id=?").run(message, uploadId, fileId);
    this.db.prepare('DELETE FROM upload_parts WHERE upload_id=? AND file_id=?').run(uploadId, fileId);
    throw new BridgeError(message, 409);
  }
  /** Removes a never-referenced object; failures leave it as an orphan for the collector. */
  private async abandonBlob(blobId: string, s3UploadId?: string) {
    const blob = this.db.prepare('SELECT * FROM blobs WHERE id=?').get(blobId) as { object_key: string; state: string } | undefined;
    if (!blob || blob.state === 'verified') return;
    this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=?").run(this.now(), blobId);
    try {
      if (s3UploadId) await this.store().abortMultipart(blob.object_key, s3UploadId);
      await this.store().delete(blob.object_key);
      this.db.prepare("UPDATE blobs SET state='deleted' WHERE id=?").run(blobId);
    } catch { /* collected later */ }
  }
  private async finishMultipart(uploadId: string, fileId: string, blobId: string, key: string, s3UploadId: string, parts: { part: number; etag: string }[]) {
    const store = this.store();
    const file = this.uploadFile(uploadId, fileId)!;
    await store.completeMultipart(key, s3UploadId, parts.map(p => ({ partNumber: p.part, etag: p.etag })));
    this.db.prepare('UPDATE upload_files SET s3_upload_id=NULL WHERE upload_id=? AND file_id=?').run(uploadId, fileId);
    // The client hash is not proof: re-read the stored object and verify size and SHA-256 on the server.
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of await store.stream(key)) { size += (chunk as Buffer).length; digest.update(chunk as Buffer); }
    const actual = digest.digest('hex');
    if (size !== file.size || actual !== file.sha256) {
      await this.failFile(uploadId, fileId, blobId, 'Содержимое файла не совпадает с манифестом. Файл изменился во время загрузки — передайте его заново.');
    }
    this.tx(() => {
      this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(blobId);
      this.db.prepare("UPDATE upload_files SET state='verified' WHERE upload_id=? AND file_id=?").run(uploadId, fileId);
    });
  }
  /** Commits the snapshot after verifying every file; idempotent with the same key. */
  async completeUpload(actor: SourceActor, sourceId: string, uploadId: string, idempotencyKey: string) {
    const session = this.requireUpload(actor, uploadId, sourceId);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new BridgeError('Укажите ключ идемпотентности.');
    if (session.complete_key) {
      if (session.complete_key !== idempotencyKey) throw new BridgeError('Загрузка уже завершается другим запросом.', 409);
      return this.uploadSummary(uploadId);
    }
    if (session.state !== 'open') throw new BridgeError('Сессия загрузки закрыта.', 409);
    if (!session.manifest_complete) throw new BridgeError('Манифест передан не полностью.', 409);
    const remaining = this.db.prepare("SELECT path, state FROM upload_files WHERE upload_id=? AND state NOT IN ('verified','reused') LIMIT 5").all(uploadId) as { path: string; state: string }[];
    if (remaining.length) throw new BridgeError('Не все файлы переданы и проверены: ' + remaining.map(r => r.path).join(', '), 409);
    const store = this.store();
    // Reused objects must still exist before the snapshot references them.
    const reused = this.db.prepare("SELECT DISTINCT b.id, b.object_key, b.size FROM upload_files f JOIN blobs b ON b.id=f.blob_id WHERE f.upload_id=? AND f.state='reused'").all(uploadId) as { id: string; object_key: string; size: number }[];
    for (const blob of reused) {
      const head = await store.head(blob.object_key);
      if (!head || head.size !== blob.size) {
        this.tx(() => {
          this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=?").run(this.now(), blob.id);
          this.db.prepare("UPDATE upload_files SET state='pending', blob_id=NULL WHERE upload_id=? AND blob_id=? AND state='reused'").run(uploadId, blob.id);
        });
        throw new BridgeError('Часть ранее загруженных объектов недоступна в хранилище. Передайте отмеченные файлы заново.', 409);
      }
    }
    return this.tx(() => {
      const current = this.uploadRow(uploadId)!;
      if (current.complete_key) { if (current.complete_key !== idempotencyKey) throw new BridgeError('Загрузка уже завершается другим запросом.', 409); return this.uploadSummary(uploadId); }
      if (current.state !== 'open') throw new BridgeError('Сессия загрузки закрыта.', 409);
      const source = this.sourceRow(current.source_id)!;
      this.requireSource(actor, sourceId, 'upload_snapshot');
      if (source.archived_at) throw new BridgeError('Источник архивирован.', 409);
      const files = this.db.prepare('SELECT * FROM upload_files WHERE upload_id=? ORDER BY path').all(uploadId) as UploadFileRow[];
      if (files.some(f => f.state !== 'verified' && f.state !== 'reused')) throw new BridgeError('Не все файлы проверены.', 409);
      // Final quota check before the snapshot can become ready (reservation of this session excluded).
      const used = this.usedBytes(current.source_id), reservedOthers = this.reservedBytes(current.source_id) - current.reserved_bytes;
      if (used + reservedOthers > source.quota_bytes) throw new BridgeError('Квота источника превышена.', 413);
      const manifest = createHash('sha256');
      let bytes = 0;
      for (const f of files) {
        manifest.update(f.path + '\0' + f.sha256 + '\0' + f.size + '\n');
        bytes += f.size;
      }
      const manifestHash = manifest.digest('hex');
      const uploadSnapshot = this.snapshotRow(current.snapshot_id)!;
      const baseline = current.skip_unchanged && current.base_snapshot_id ? this.snapshotRow(current.base_snapshot_id) : undefined;
      if (baseline?.state === 'ready' && baseline.manifest_hash === manifestHash && baseline.valid_from === uploadSnapshot.valid_from && baseline.valid_to === uploadSnapshot.valid_to
        && files.every(file => file.state === 'reused')) {
        this.db.prepare("UPDATE snapshots SET state='cancelled' WHERE id=?").run(current.snapshot_id);
        this.db.prepare("UPDATE upload_sessions SET state='complete', complete_key=?, reserved_bytes=0, unchanged_snapshot_id=? WHERE id=?").run(idempotencyKey, baseline.id, uploadId);
        this.db.prepare('DELETE FROM upload_files WHERE upload_id=?').run(uploadId);
        return this.uploadSummary(uploadId);
      }
      const insert = this.db.prepare('INSERT INTO snapshot_files (snapshot_id, file_id, path, path_key, blob_id, sha256, size) VALUES (?,?,?,?,?,?,?)');
      for (const f of files) insert.run(current.snapshot_id, f.file_id, f.path, f.path_key, f.blob_id, f.sha256, f.size);
      this.db.prepare("UPDATE snapshots SET state='indexing', manifest_hash=?, total_files=?, total_bytes=? WHERE id=?").run(manifestHash, files.length, bytes, current.snapshot_id);
      this.db.prepare("UPDATE upload_sessions SET state='complete', complete_key=?, reserved_bytes=0 WHERE id=?").run(idempotencyKey, uploadId);
      this.db.prepare("INSERT INTO index_jobs (snapshot_id, generation, state, created_at) VALUES (?,1,'queued',?) ON CONFLICT(snapshot_id) DO NOTHING").run(current.snapshot_id, this.now());
      this.db.prepare('DELETE FROM upload_parts WHERE upload_id=?').run(uploadId);
      return this.uploadSummary(uploadId);
    }, value => [{ actorId: actor.id, action: value.unchanged ? 'source.upload.unchanged' : 'source.upload.complete', targetId: uploadId, details: { objectIds: { snapshotId: value.snapshotId, files: String(value.files.total) } } }]);
  }
  async cancelUpload(actor: SourceActor, sourceId: string, uploadId: string) {
    const session = this.requireUpload(actor, uploadId, sourceId);
    if (session.state === 'cancelled') return this.uploadSummary(uploadId);
    if (session.state !== 'open') throw new BridgeError('Завершённую загрузку отменить нельзя.', 409);
    this.closeUpload(uploadId, 'cancelled');
    this.recordAudit({ actorId: actor.id, action: 'source.upload.cancel', targetId: uploadId });
    await this.collectGarbage({ graceMs: 0 });
    return this.uploadSummary(uploadId);
  }
  private expireUpload(uploadId: string) { this.closeUpload(uploadId, 'expired'); }
  /** Releases the reservation and marks unreferenced objects of this session for collection. */
  private closeUpload(uploadId: string, state: 'cancelled' | 'expired' | 'failed') {
    this.tx(() => {
      const row = this.uploadRow(uploadId)!;
      if (row.state !== 'open') return;
      const at = this.now();
      this.db.prepare("UPDATE upload_sessions SET state=?, reserved_bytes=0 WHERE id=?").run(state, uploadId);
      this.db.prepare("UPDATE snapshots SET state='cancelled' WHERE id=? AND state='uploading'").run(row.snapshot_id);
      this.db.prepare(`UPDATE blobs SET state='orphan', orphaned_at=? WHERE id IN (SELECT blob_id FROM upload_files WHERE upload_id=? AND state IN ('uploading','verified','failed','pending') AND blob_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM snapshot_files s WHERE s.blob_id=blobs.id) AND NOT EXISTS (SELECT 1 FROM upload_files u JOIN upload_sessions us ON us.id=u.upload_id
        WHERE u.blob_id=blobs.id AND us.state IN ('open','completing') AND us.id<>?)`).run(at, uploadId, uploadId);
    });
  }
  /** Expires sessions, aborts multipart uploads and deletes objects with zero references after a grace period. */
  async collectGarbage(options: { graceMs?: number } = {}) {
    const grace = options.graceMs ?? this.limits.orphanGraceMs;
    for (const row of this.db.prepare("SELECT id FROM upload_sessions WHERE state='open' AND expires_at<=?").all(this.now()) as { id: string }[]) this.expireUpload(row.id);
    const store = this.storage.store;
    if (!store || this.collectorPaused()) return { deleted: 0, failed: 0 };
    const pendingMultipart = this.db.prepare(`SELECT f.upload_id, f.file_id, f.s3_upload_id, b.object_key FROM upload_files f JOIN upload_sessions s ON s.id=f.upload_id JOIN blobs b ON b.id=f.blob_id
      WHERE f.s3_upload_id IS NOT NULL AND s.state IN ('cancelled','expired','failed')`).all() as { upload_id: string; file_id: string; s3_upload_id: string; object_key: string }[];
    for (const item of pendingMultipart) {
      try { await store.abortMultipart(item.object_key, item.s3_upload_id); this.db.prepare('UPDATE upload_files SET s3_upload_id=NULL WHERE upload_id=? AND file_id=?').run(item.upload_id, item.file_id); }
      catch { /* retried next time */ }
    }
    // Only objects with zero references are deleted; snapshots of other projects keep their blobs.
    const candidates = this.db.prepare(`SELECT id, object_key FROM blobs WHERE state='orphan' AND orphaned_at<=? AND NOT EXISTS (SELECT 1 FROM snapshot_files s WHERE s.blob_id=blobs.id OR s.text_blob_id=blobs.id)
      AND NOT EXISTS (SELECT 1 FROM upload_files u JOIN upload_sessions us ON us.id=u.upload_id WHERE u.blob_id=blobs.id AND us.state IN ('open','completing')) LIMIT 1000`).all(this.now() - grace) as { id: string; object_key: string }[];
    let deleted = 0, failed = 0;
    for (const blob of candidates) {
      try { await store.delete(blob.object_key); this.db.prepare("UPDATE blobs SET state='deleted' WHERE id=?").run(blob.id); deleted++; }
      catch { failed++; }
    }
    return { deleted, failed };
  }
  /** Removes an old, unbound and unretained snapshot (retention policy); blobs become orphans only when unreferenced. */
  archiveSnapshot(actor: SourceActor, sourceId: string, snapshotId: string, isBound: (snapshotId: string) => boolean) {
    this.requireSource(actor, sourceId, 'manage_source');
    return this.tx(() => {
      const row = this.snapshotRow(snapshotId);
      if (!row || row.source_id !== sourceId) throw notFound();
      if (row.retained) throw new BridgeError('Снимок находится на удержании.', 409);
      if (isBound(snapshotId)) throw new BridgeError('Снимок используется привязкой или набором версий проекта.', 409);
      if ((this.db.prepare('SELECT count(*) n FROM dependencies WHERE platform_snapshot_id=?').get(snapshotId) as { n: number }).n) throw new BridgeError('От снимка зависят другие снимки. Сначала снимите зависимость.', 409);
      if (['uploading', 'verifying', 'indexing'].includes(row.state)) throw new BridgeError('Дождитесь завершения обработки снимка.', 409);
      this.db.prepare("UPDATE snapshots SET state='archived' WHERE id=?").run(snapshotId);
      this.db.prepare('DELETE FROM chunks WHERE snapshot_id=?').run(snapshotId);
      this.db.prepare('DELETE FROM line_index WHERE snapshot_id=?').run(snapshotId);
      this.db.prepare('DELETE FROM symbols WHERE snapshot_id=?').run(snapshotId);
      const blobIds = (this.db.prepare('SELECT blob_id id FROM snapshot_files WHERE snapshot_id=? UNION SELECT text_blob_id FROM snapshot_files WHERE snapshot_id=? AND text_blob_id IS NOT NULL')
        .all(snapshotId, snapshotId) as { id: string }[]).map(r => r.id);
      this.db.prepare('DELETE FROM snapshot_files WHERE snapshot_id=?').run(snapshotId);
      this.db.prepare('DELETE FROM dependencies WHERE snapshot_id=?').run(snapshotId);
      const orphan = this.db.prepare(`UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=? AND state='verified' AND NOT EXISTS (SELECT 1 FROM snapshot_files s WHERE s.blob_id=blobs.id OR s.text_blob_id=blobs.id)
        AND NOT EXISTS (SELECT 1 FROM upload_files u JOIN upload_sessions us ON us.id=u.upload_id WHERE u.blob_id=blobs.id AND us.state IN ('open','completing'))`);
      for (const id of blobIds) orphan.run(this.now(), id);
      return this.snapshotSummary(this.snapshotRow(snapshotId)!);
    }, () => [{ actorId: actor.id, action: 'source.snapshot.archive', targetId: snapshotId }]);
  }
  // ---- local utility tokens ------------------------------------------------------------------
  /** Short-lived token limited to uploads of one source; the secret is shown once and stored as a hash. */
  issueUploadToken(actor: SourceActor, sourceId: string, ttlMinutes = 60) {
    this.requireSource(actor, sourceId, 'upload_snapshot');
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 240) throw new BridgeError('Срок действия токена — от 5 до 240 минут.');
    const id = randomUUID().replaceAll('-', ''), secret = randomBytes(32).toString('base64url');
    const token = `fksrc1.${id}.${secret}`, at = this.now();
    this.tx(() => { this.db.prepare('INSERT INTO upload_tokens VALUES (?,?,?,?,?,?,NULL)').run(id, hash(token), actor.id, sourceId, at, at + ttlMinutes * 60_000); },
      () => [{ actorId: actor.id, action: 'source.token.issue', targetId: sourceId, details: { objectIds: { tokenId: id, ttlMinutes: String(ttlMinutes) } } }]);
    return { token, expiresAt: new Date(at + ttlMinutes * 60_000).toISOString() };
  }
  /** Resolves the user of an upload token for this source; any mismatch is indistinguishable from an invalid token. */
  uploadTokenUser(token: string, sourceId: string) {
    if (!/^fksrc1\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare('SELECT * FROM upload_tokens WHERE hash=?').get(hash(token)) as { id: string; user_id: string; source_id: string; expires_at: number; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at || row.expires_at <= this.now() || row.source_id !== sourceId) return undefined;
    return row.user_id;
  }
  revokeUploadTokens(actor: SourceActor, sourceId: string) {
    this.requireSource(actor, sourceId, 'upload_snapshot');
    const changed = this.db.prepare('UPDATE upload_tokens SET revoked_at=? WHERE source_id=? AND revoked_at IS NULL AND (user_id=? OR ?)').run(this.now(), sourceId, actor.id, actor.admin ? 1 : 0).changes;
    this.recordAudit({ actorId: actor.id, action: 'source.token.revoke', targetId: sourceId });
    return { revoked: Number(changed) };
  }

  // ---- retention and maintenance --------------------------------------------------------------
  /** Collector pause used by consistent backups: objects are not deleted while the pause lasts. */
  pauseCollector(ms: number) { this.db.prepare("INSERT INTO maintenance VALUES ('collector_paused_until', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.now() + ms)); }
  resumeCollector() { this.db.prepare("DELETE FROM maintenance WHERE key='collector_paused_until'").run(); }
  collectorPaused() {
    const row = this.db.prepare("SELECT value FROM maintenance WHERE key='collector_paused_until'").get() as { value: string } | undefined;
    return !!row && Number(row.value) > this.now();
  }
  /**
   * Retention policy: per source keep the newest `keep` ready snapshots; older ones are archived when they are older than `minAgeDays`,
   * not bound to any project, bundle or chat, not retained and not a dependency target. Their objects become collectable only at zero references.
   */
  applyRetention(policy: { keep: number; minAgeDays: number }, isBound: (snapshotId: string) => boolean) {
    if (!(policy.keep > 0)) return { archived: [] as string[] };
    const archived: string[] = [];
    const cutoff = new Date(this.now() - policy.minAgeDays * 86_400_000).toISOString();
    for (const source of this.db.prepare('SELECT id FROM sources').all() as { id: string }[]) {
      const ready = this.db.prepare("SELECT * FROM snapshots WHERE source_id=? AND state='ready' ORDER BY uploaded_at DESC").all(source.id) as SnapshotRow[];
      for (const snapshot of ready.slice(policy.keep)) {
        if (snapshot.uploaded_at > cutoff || snapshot.retained || isBound(snapshot.id)) continue;
        if ((this.db.prepare('SELECT count(*) n FROM dependencies WHERE platform_snapshot_id=?').get(snapshot.id) as { n: number }).n) continue;
        try { this.archiveSnapshot({ id: 'system', admin: true }, source.id, snapshot.id, isBound); archived.push(snapshot.id); } catch { /* skipped */ }
      }
    }
    return { archived };
  }
  usage(sourceId: string) {
    return {
      bindings: this.db.prepare('SELECT id, project_id projectId, selector, snapshot_id snapshotId, approved, enabled, revision FROM bindings WHERE source_id=?').all(sourceId) as
        { id: string; projectId: string; selector: string; snapshotId: string | null; approved: string; enabled: number; revision: number }[],
      grants: this.db.prepare('SELECT g.project_id projectId, g.profile_id profileId, g.binding_id bindingId, g.enabled FROM grants g JOIN bindings b ON b.id=g.binding_id WHERE b.source_id=?').all(sourceId) as
        { projectId: string; profileId: string; bindingId: string; enabled: number }[],
      bundles: this.db.prepare("SELECT id, project_id projectId, label, state, revision, items FROM bundles WHERE state='active'").all() as { id: string; projectId: string; label: string; state: string; revision: number; items: string }[],
    };
  }
  /** Read-only check used by status screens: objects of ready snapshots exist with the recorded size. */
  async verifyObjects(sourceId?: string) {
    const store = this.store();
    const rows = this.db.prepare(`SELECT DISTINCT b.id, b.object_key, b.size FROM blobs b WHERE b.state='verified' ${sourceId ? 'AND b.source_id=?' : ''}`).all(...(sourceId ? [sourceId] : [])) as
      { id: string; object_key: string; size: number }[];
    const missing: string[] = [];
    for (const row of rows) { const head = await store.head(row.object_key); if (!head || head.size !== row.size) missing.push(row.id); }
    return { checked: rows.length, missing };
  }
}

export function isSourceAction(value: unknown): value is SourceAction { return typeof value === 'string' && (sourceActions as readonly string[]).includes(value); }
