import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../../shared/types.js';
import {
  excluded, libraryActions, libraryDefaults, pathKey, pathProblem, suspiciousSecret,
  type ExternalSelection, type ContentState, type Coverage, type LibraryAction, type LibraryClassification, type LibraryFolderSummary, type LibraryProfile, type ManifestEntry,
  type OperationMode, type OperationStatus, type OperationSummary, type OutputPolicy, type UploadFileStatus,
} from '../../shared/library.js';
import { AuditJournal, publishAudit, type NewAuditEvent } from '../audit-journal.js';
import { BridgeError } from '../store.js';
import { ExternalLibraries } from './external.js';
import { FilesystemLibraryBlobStore, blobKey, storageFromInput, type LibraryBlobStore, type StorageInput, type LibraryStorageConfig } from './blob-store.js';
import { LibrarySettings } from './settings.js';

export const runScopeRetentionMs = 7 * 86_400_000;

export interface LibraryActor { id: string; admin: boolean; credentialId?: string }
export interface LibraryLimits {
  maxFiles: number; maxFileBytes: number; maxDepth: number; maxPathLength: number; partBytes: number; manifestPageEntries: number;
  defaultQuotaBytes: number; uploadTtlMs: number; uploadConcurrency: number; indexTextBytes: number; orphanGraceMs: number;
}
const int = (value: string | undefined, fallback: number, min = 1) => {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
};
/** Admission limits (not confirmed performance). Only the four size limits are configurable. */
export function libraryLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): LibraryLimits {
  return {
    maxFiles: int(env.BRIDGE_LIBRARY_MAX_FILES, libraryDefaults.maxFiles),
    maxFileBytes: int(env.BRIDGE_LIBRARY_MAX_FILE_BYTES, libraryDefaults.maxFileBytes),
    maxDepth: libraryDefaults.maxDepth, maxPathLength: libraryDefaults.maxPathLength, partBytes: libraryDefaults.partBytes,
    manifestPageEntries: libraryDefaults.manifestPageEntries,
    defaultQuotaBytes: int(env.BRIDGE_LIBRARY_DEFAULT_QUOTA, libraryDefaults.defaultQuotaBytes),
    uploadTtlMs: libraryDefaults.uploadTtlMs, uploadConcurrency: 8,
    indexTextBytes: int(env.BRIDGE_LIBRARY_INDEX_TEXT_BYTES, 16 * 1024 * 1024),
    orphanGraceMs: 3600_000,
  };
}
/**
 * Version of processing required for a file kind. Version 2 added DOCX and cell references in XLSX; other files keep version 1.
 * A prepared state processes contents below the required version again; contents of current states are brought up to date in the background.
 */
export const processorVersion = 2;
const upgradedDocuments = ['xlsx', 'docx'];
/**
 * SQL: the content row `c` of file `f` is up to date. Extensions are ASCII, so lower() is sufficient. Version 2 also reads Windows-1251 text,
 * so text left as "unsupported encoding" by version 1 is processed again.
 */
const upToDate = `(c.processor >= (CASE WHEN ${upgradedDocuments.map(e => `lower(f.path) LIKE '%.${e}'`).join(' OR ')} THEN 2 ELSE 1 END)
  AND NOT (c.state='unsupported_encoding' AND c.processor < 2))`;

const schemaVersion = 5;
const migrations: Record<number, string> = {
  1: `
CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, profile TEXT NOT NULL CHECK(profile IN ('code','documents')),
  classification TEXT NOT NULL CHECK(classification IN ('shared','restricted')), output_policy TEXT NOT NULL CHECK(output_policy IN ('explanation_only','excerpts_allowed')),
  quota_bytes INTEGER NOT NULL, revision INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, current_state TEXT, updated_at TEXT, deleted_at TEXT, origin TEXT);
CREATE UNIQUE INDEX folders_name ON folders(lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE folder_managers (folder_id TEXT NOT NULL REFERENCES folders(id), user_id TEXT NOT NULL, actions TEXT NOT NULL CHECK(json_valid(actions)), PRIMARY KEY(folder_id,user_id));
CREATE TABLE states (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id), base_state TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  ready_at INTEGER, total_files INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, indexed_files INTEGER NOT NULL DEFAULT 0, unsupported_files INTEGER NOT NULL DEFAULT 0,
  extraction_errors INTEGER NOT NULL DEFAULT 0, coverage_accepted_by TEXT, failure TEXT, manifest_hash TEXT, exclusions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(exclusions)));
CREATE UNIQUE INDEX states_one_preparing ON states(folder_id) WHERE status='preparing';
CREATE TABLE blobs (id TEXT PRIMARY KEY, folder_id TEXT, object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('original','derived')), state TEXT NOT NULL CHECK(state IN ('pending','verified','orphan','deleted')), created_at INTEGER NOT NULL, orphaned_at INTEGER);
CREATE INDEX blobs_reuse ON blobs(folder_id, sha256, size) WHERE state='verified' AND kind='original';
CREATE TABLE state_files (state_id TEXT NOT NULL REFERENCES states(id), file_id TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL, blob_id TEXT NOT NULL REFERENCES blobs(id),
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(state_id,file_id), UNIQUE(state_id,path_key));
CREATE INDEX state_files_path ON state_files(state_id, path);
CREATE INDEX state_files_content ON state_files(content, state_id);
CREATE INDEX state_files_hash ON state_files(sha256, size);
CREATE INDEX state_files_blob ON state_files(blob_id);
CREATE TABLE contents (sha256 TEXT NOT NULL, size INTEGER NOT NULL, processor INTEGER NOT NULL, state TEXT NOT NULL, media_type TEXT, encoding TEXT, line_count INTEGER,
  language TEXT, text_blob_id TEXT REFERENCES blobs(id), note TEXT, processed_at INTEGER NOT NULL, PRIMARY KEY(sha256,size));
CREATE VIRTUAL TABLE chunks USING fts5(content UNINDEXED, start_line UNINDEXED, text, tokenize='trigram', detail=none);
CREATE TABLE line_index (content TEXT NOT NULL, line INTEGER NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY(content,line));
CREATE TABLE sections (content TEXT NOT NULL, line INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY(content,line));
CREATE TABLE operations (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id), mode TEXT NOT NULL CHECK(mode IN ('replace','add','remove','retry')), actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0, declared_files INTEGER NOT NULL,
  declared_bytes INTEGER NOT NULL, base_state TEXT, state_id TEXT, manifest_pages INTEGER NOT NULL DEFAULT 0, manifest_complete INTEGER NOT NULL DEFAULT 0, manifest_files INTEGER NOT NULL DEFAULT 0,
  manifest_bytes INTEGER NOT NULL DEFAULT 0, exclusions TEXT NOT NULL CHECK(json_valid(exclusions)), complete_key TEXT, failure TEXT, created_at INTEGER NOT NULL, UNIQUE(actor_id, idempotency_key));
CREATE UNIQUE INDEX operations_one_active ON operations(folder_id) WHERE status IN ('open','preparing');
CREATE TABLE operation_pages (operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, page INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(operation_id,page));
CREATE TABLE operation_files (operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, file_id TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, state TEXT NOT NULL, blob_id TEXT REFERENCES blobs(id), s3_upload_id TEXT, parts_total INTEGER NOT NULL, secret_findings TEXT, secret_decision TEXT, failure TEXT,
  ordinal INTEGER NOT NULL, PRIMARY KEY(operation_id,file_id), UNIQUE(operation_id,path_key));
CREATE INDEX operation_files_state ON operation_files(operation_id, state, ordinal);
CREATE TABLE operation_parts (operation_id TEXT NOT NULL, file_id TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, etag TEXT NOT NULL,
  PRIMARY KEY(operation_id,file_id,part), FOREIGN KEY(operation_id,file_id) REFERENCES operation_files(operation_id,file_id) ON DELETE CASCADE);
CREATE TABLE index_jobs (state_id TEXT PRIMARY KEY REFERENCES states(id), status TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE connections (project_id TEXT NOT NULL, folder_id TEXT NOT NULL REFERENCES folders(id), enabled INTEGER NOT NULL, output_policy TEXT NOT NULL CHECK(output_policy IN ('explanation_only','excerpts_allowed')),
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, folder_id));
CREATE TABLE grants (project_id TEXT NOT NULL, profile_id TEXT NOT NULL, folder_id TEXT NOT NULL, output_policy TEXT CHECK(output_policy IS NULL OR output_policy IN ('explanation_only','excerpts_allowed')),
  paths TEXT CHECK(paths IS NULL OR json_valid(paths)), PRIMARY KEY(project_id, profile_id, folder_id), FOREIGN KEY(project_id, folder_id) REFERENCES connections(project_id, folder_id) ON DELETE CASCADE);
CREATE TABLE run_scopes (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, profile_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(json_valid(scope)), created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE imports (key TEXT PRIMARY KEY, done_at TEXT NOT NULL, report TEXT NOT NULL CHECK(json_valid(report)));
`,
  2: `
CREATE TABLE chunk_refs (content TEXT NOT NULL, chunk_rowid INTEGER NOT NULL, PRIMARY KEY(content,chunk_rowid)) WITHOUT ROWID;
INSERT INTO chunk_refs (content,chunk_rowid) SELECT content,rowid FROM chunks;
`,
  5: `
CREATE TABLE drive_accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, credentials TEXT NOT NULL);
ALTER TABLE external_sources ADD COLUMN account_id TEXT REFERENCES drive_accounts(id);
CREATE INDEX external_sources_account ON external_sources(account_id);
INSERT INTO drive_accounts SELECT e.folder_id,e.provider,f.name,e.credentials FROM external_sources e JOIN folders f ON f.id=e.folder_id;
UPDATE external_sources SET account_id=folder_id,credentials='';
`,
  4: `
CREATE TABLE external_sources(folder_id TEXT PRIMARY KEY REFERENCES folders(id), provider TEXT NOT NULL, remote_id TEXT NOT NULL,
  identity TEXT NOT NULL, name TEXT NOT NULL, credentials TEXT NOT NULL, checked_at TEXT, error TEXT, sync_owner TEXT, lease_until INTEGER);
ALTER TABLE states ADD COLUMN drive_signature TEXT;
CREATE TABLE external_files(state_id TEXT NOT NULL REFERENCES states(id), path TEXT NOT NULL, remote_id TEXT NOT NULL, revision TEXT NOT NULL, link TEXT, PRIMARY KEY(state_id,path));
`,
  3: `
ALTER TABLE folders ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
UPDATE folders SET active=0 WHERE classification='restricted';
`,
};

export type FolderRow = { id: string; name: string; description: string; profile: LibraryProfile; classification: LibraryClassification; output_policy: OutputPolicy; quota_bytes: number; active: number;
  revision: number; created_by: string; created_at: string; current_state: string | null; updated_at: string | null; deleted_at: string | null; origin: string | null };
export type StateRow = { id: string; folder_id: string; base_state: string | null; status: ContentState; created_by: string; created_at: number; ready_at: number | null; total_files: number;
  total_bytes: number; indexed_files: number; unsupported_files: number; extraction_errors: number; coverage_accepted_by: string | null; failure: string | null; manifest_hash: string | null; exclusions: string };
type OperationRow = { id: string; folder_id: string; mode: OperationMode | 'remove' | 'retry'; actor_id: string; idempotency_key: string; request_hash: string; status: OperationStatus;
  expires_at: number; reserved_bytes: number; declared_files: number; declared_bytes: number; base_state: string | null; state_id: string | null; manifest_pages: number;
  manifest_complete: number; manifest_files: number; manifest_bytes: number; exclusions: string; complete_key: string | null; failure: string | null; created_at: number };
type OperationFileRow = { operation_id: string; file_id: string; path: string; path_key: string; size: number; sha256: string; state: UploadFileStatus['state']; blob_id: string | null;
  s3_upload_id: string | null; parts_total: number; secret_findings: string | null; secret_decision: string | null; failure: string | null; ordinal: number };
export type StateFileRow = { state_id: string; file_id: string; path: string; path_key: string; blob_id: string; sha256: string; size: number; content: string };
export type ContentRow = { sha256: string; size: number; processor: number; state: string; media_type: string | null; encoding: string | null; line_count: number | null;
  language: string | null; text_blob_id: string | null; note: string | null; processed_at: number };
export type LibraryFile = StateFileRow & { extraction_state: string; line_count: number | null; language: string | null; encoding: string | null; media_type: string | null;
  text_blob_id: string | null; extraction_note: string | null };

const sha256Hex = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
export const contentKey = (sha256: string, size: number) => sha256 + ':' + size;
export const notFound = () => new BridgeError('Папка библиотеки не найдена.', 404);
const busy = () => new BridgeError('Папка уже обновляется. Продолжите или отмените текущую загрузку.', 409);
const failureStates = "('failed','timeout')";
const unsupportedStates = "('unsupported_format','unsupported_encoding','ocr_required')";
/** Joins the last processing result, including results still usable during a processor upgrade. */
const fileSelect = `SELECT f.*, coalesce(c.state,'pending') extraction_state, c.line_count, c.language, c.encoding, c.media_type, c.text_blob_id, c.note extraction_note
  FROM state_files f LEFT JOIN contents c ON c.sha256=f.sha256 AND c.size=f.size`;

/**
 * Durable catalog of library folders. Each folder has one current content; an update is prepared as an internal state and replaces the current
 * one atomically after processing. Earlier states are never offered to users or agents and are removed once no running answer reads them.
 */
export class LibraryRegistry {
  readonly db: DatabaseSync;
  readonly external: ExternalLibraries;
  readonly settings: LibrarySettings;
  private retiredStores: LibraryBlobStore[] = [];
  private configuringStorage = false;
  private readonly externalCache: FilesystemLibraryBlobStore;
  objectStore(key: string) { return key.startsWith('library/external_') ? this.externalCache : this.store(); }
  private readonly audit: AuditJournal;
  private activeParts = 0;
  private fileLocks = new Map<string, Promise<unknown>>();
  /** Project names for summaries; supplied by the workspace. */
  projectName: (projectId: string) => string | undefined = () => undefined;
  canSeeProject: (actor: LibraryActor, projectId: string) => boolean = () => true;
  constructor(root: string, public storage: LibraryStorageConfig, readonly limits: LibraryLimits = libraryLimitsFromEnv(), private readonly now = () => Date.now()) {
    this.externalCache = new FilesystemLibraryBlobStore(path.join(root, 'drive-cache'));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.settings = new LibrarySettings(root);
    const saved = this.settings.read<StorageInput>('s3');
    if (saved) {
      this.storage = storageFromInput(saved);
      storage.store?.close();
    }
    const file = path.join(root, 'library.sqlite');
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
      this.migrate();
      this.external = new ExternalLibraries(this);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS blobs_folder_usage ON blobs(folder_id, size) WHERE kind='original' AND state IN ('verified','pending');
        CREATE INDEX IF NOT EXISTS blobs_orphan ON blobs(orphaned_at) WHERE state='orphan';
        CREATE INDEX IF NOT EXISTS states_folder_status ON states(folder_id, status, created_at DESC);
      `);
      this.audit = new AuditJournal(this.db);
    } catch (error) { this.db.close(); throw error; }
  }
  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > schemaVersion) throw new BridgeError('База библиотеки создана более новой версией приложения.', 500);
    for (let version = current + 1; version <= schemaVersion; version++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const again = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (again < version) { this.db.exec(migrations[version]); this.db.exec(`PRAGMA user_version=${version}`); }
        this.db.exec('COMMIT');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  get schemaVersion() { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
  close() { this.db.close(); this.storage.store?.close(); this.retiredStores.forEach(store => store.close()); }

  async configureStorage(input: StorageInput) {
    if (this.configuringStorage) throw new BridgeError('Проверка хранилища уже идёт.', 409);
    const candidate = storageFromInput(input);
    const store = candidate.store!;
    this.configuringStorage = true;
    try {
      await store.check();
      const previous = this.storage.location;
      const sameTarget = previous && previous.bucket === input.bucket && previous.endpoint.replace(/\/$/, '') === candidate.location!.endpoint && (!!previous.endpoint || previous.region === input.region);
      if (this.storage.store && !sameTarget && this.db.prepare("SELECT 1 FROM blobs WHERE state != 'deleted' AND object_key NOT GLOB 'library/external_*' UNION ALL SELECT 1 FROM operations WHERE status='open' LIMIT 1").get()) {
        throw new BridgeError('В текущем хранилище уже есть файлы или активные загрузки. Укажите тот же адрес и бакет для обновления ключей.', 409);
      }
      this.settings.write('s3', input);
      // In-flight readers may still be streaming through the previous client.
      if (this.storage.store) this.retiredStores.push(this.storage.store);
      this.storage = candidate;
    } catch (e) { store.close(); throw e; }
    finally { this.configuringStorage = false; }
  }

  /** Runs write in one IMMEDIATE transaction; audit events commit with the change. */
  tx<T>(write: () => T, events: (value: T) => NewAuditEvent[] = () => []): T {
    this.db.exec('BEGIN IMMEDIATE');
    let value: T; let inserted: AuditEvent[] = [];
    try {
      value = write();
      inserted = events(value).map(event => this.audit.insert(event));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    inserted.forEach(publishAudit);
    return value;
  }
  recordAudit(event: NewAuditEvent) { publishAudit(this.audit.insert(event)); }
  auditPage(before?: { at: number; id: string }) { return this.audit.page(before); }

  store() {
    if (!this.storage.store) throw new BridgeError(this.storage.problem ?? 'Хранилище библиотеки не настроено.', 503);
    return this.storage.store;
  }
  storageStatus() {
    const one = <T>(sql: string) => this.db.prepare(sql).get() as T;
    return { configured: !!this.storage.store, kind: this.storage.store?.kind, problem: this.storage.problem, location: this.storage.location,
      limits: { maxFiles: this.limits.maxFiles, maxFileBytes: this.limits.maxFileBytes, partBytes: this.limits.partBytes, maxDepth: this.limits.maxDepth,
        maxPathLength: this.limits.maxPathLength, defaultQuotaBytes: this.limits.defaultQuotaBytes, uploadConcurrency: this.limits.uploadConcurrency },
      activeParts: this.activeParts,
      indexQueue: one<{ n: number }>("SELECT count(*) n FROM index_jobs WHERE status IN ('queued','running')").n,
      indexFailures: one<{ n: number }>("SELECT count(*) n FROM index_jobs WHERE status='failed'").n,
      openUploads: one<{ n: number }>("SELECT count(*) n FROM operations WHERE status='open'").n,
      orphanBlobs: one<{ n: number }>("SELECT count(*) n FROM blobs WHERE state='orphan'").n,
      indexChunks: one<{ n: number }>('SELECT count(*) n FROM chunk_refs').n };
  }
  projectLibraryLabels(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const rows = this.db.prepare(`SELECT c.project_id, c.enabled, f.name, f.active
      FROM connections c JOIN folders f ON f.id=c.folder_id WHERE f.deleted_at IS NULL ORDER BY c.rowid`).all() as
      { project_id: string; enabled: number; name: string; active: number }[];
    for (const row of rows) {
      const list = result.get(row.project_id) ?? [];
      list.push(row.name + (row.enabled && row.active ? '' : ' (выключена)'));
      result.set(row.project_id, list);
    }
    return result;
  }

  // ---- authorization -------------------------------------------------------------------------
  folderRow(id: string) { return this.db.prepare('SELECT * FROM folders WHERE id=? AND deleted_at IS NULL').get(id) as FolderRow | undefined; }
  managerActions(folderId: string, userId: string): LibraryAction[] {
    const row = this.db.prepare('SELECT actions FROM folder_managers WHERE folder_id=? AND user_id=?').get(folderId, userId) as { actions: string } | undefined;
    return json<LibraryAction[]>(row?.actions, []).filter(a => (libraryActions as readonly string[]).includes(a));
  }
  can(actor: LibraryActor, folderId: string, action: LibraryAction) {
    if (!this.folderRow(folderId) || (action === 'upload' && this.external.has(folderId))) return false;
    return actor.admin || this.managerActions(folderId, actor.id).includes(action);
  }
  /** Returns the folder if visible to a manager; unknown and foreign ids are indistinguishable (404). */
  requireFolder(actor: LibraryActor, folderId: string, action: LibraryAction) {
    const row = this.folderRow(folderId);
    const visible = row && (actor.admin || this.managerActions(folderId, actor.id).length > 0);
    if (!row || !visible) { this.deny(actor, folderId, action, 'not_visible'); throw notFound(); }
    if (!this.can(actor, folderId, action)) { this.deny(actor, folderId, action, 'forbidden'); throw new BridgeError('Недостаточно прав для этого действия с папкой библиотеки.', 403); }
    return row;
  }
  deny(actor: LibraryActor, targetId: string, action: string, reason: string) {
    this.recordAudit({ actorId: actor.id, action: 'library.denied', targetId, details: { success: false, objectIds: { action, reason } } });
  }

  // ---- folders -------------------------------------------------------------------------------
  usedBytes(folderId: string) {
    return (this.db.prepare("SELECT coalesce(sum(size),0) n FROM blobs WHERE folder_id=? AND kind='original' AND state IN ('verified','pending')").get(folderId) as { n: number }).n;
  }
  private reservedBytes(folderId: string, exceptOperation = '') {
    return (this.db.prepare("SELECT coalesce(sum(reserved_bytes),0) n FROM operations WHERE folder_id=? AND status='open' AND id<>?").get(folderId, exceptOperation) as { n: number }).n;
  }
  stateRow(id: string) { return this.db.prepare('SELECT * FROM states WHERE id=?').get(id) as StateRow | undefined; }
  private processedCounts(stateId: string) {
    const counts = this.db.prepare(`SELECT sum(c.state IN ('indexed','limited')) n_indexed, sum(c.state IN ${unsupportedStates}) n_unsupported, sum(c.state IN ${failureStates}) n_failed
      FROM state_files f JOIN contents c ON c.sha256=f.sha256 AND c.size=f.size WHERE f.state_id=?`).get(stateId) as
      { n_indexed: number | null; n_unsupported: number | null; n_failed: number | null };
    return { indexed: counts.n_indexed ?? 0, unsupported: counts.n_unsupported ?? 0, errors: counts.n_failed ?? 0 };
  }
  coverage(state: StateRow): Coverage {
    const counts = state.status === 'preparing' ? this.processedCounts(state.id)
      : { indexed: state.indexed_files, unsupported: state.unsupported_files, errors: state.extraction_errors };
    return { files: state.total_files, bytes: state.total_bytes, ...counts,
      acceptedBy: state.coverage_accepted_by ?? undefined };
  }
  deleteContentIndex(key: string) {
    this.db.prepare('DELETE FROM chunks WHERE rowid IN (SELECT chunk_rowid FROM chunk_refs WHERE content=?)').run(key);
    this.db.prepare('DELETE FROM chunk_refs WHERE content=?').run(key);
    this.db.prepare('DELETE FROM line_index WHERE content=?').run(key);
    this.db.prepare('DELETE FROM sections WHERE content=?').run(key);
  }
  /** One file of a current content whose processing is older than its kind requires (for example XLSX before cell references). */
  outdatedFile() {
    return this.db.prepare(`SELECT f.* FROM folders d JOIN state_files f ON f.state_id=d.current_state JOIN contents c ON c.sha256=f.sha256 AND c.size=f.size
      WHERE d.deleted_at IS NULL AND NOT ${upToDate} LIMIT 1`).get() as StateFileRow | undefined;
  }
  /** Recounts processed files of published states that contain the content after it was processed again. */
  refreshCoverage(key: string) {
    const states = this.db.prepare(`SELECT DISTINCT s.id FROM state_files f JOIN states s ON s.id=f.state_id WHERE f.content=? AND s.status<>'preparing'`).all(key) as { id: string }[];
    for (const { id } of states) {
      const counts = this.processedCounts(id);
      this.db.prepare('UPDATE states SET indexed_files=?, unsupported_files=?, extraction_errors=? WHERE id=?').run(counts.indexed, counts.unsupported, counts.errors, id);
    }
  }
  private activeOperation(folderId: string) {
    return this.db.prepare("SELECT * FROM operations WHERE folder_id=? AND status IN ('open','preparing')").get(folderId) as OperationRow | undefined;
  }
  private lastFailedState(folder: FolderRow) {
    const row = this.db.prepare("SELECT * FROM states WHERE folder_id=? AND status='failed' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(folder.id) as StateRow | undefined;
    // Only a failure newer than the current content is still relevant.
    const current = folder.current_state ? this.stateRow(folder.current_state) : undefined;
    return row && (!current || row.created_at >= current.created_at) ? row : undefined;
  }
  summary(row: FolderRow, actor: LibraryActor): LibraryFolderSummary {
    const managers = (this.db.prepare('SELECT user_id, actions FROM folder_managers WHERE folder_id=? ORDER BY user_id').all(row.id) as { user_id: string; actions: string }[])
      .map(m => ({ userId: m.user_id, actions: json<LibraryAction[]>(m.actions, []) }));
    const current = row.current_state ? this.stateRow(row.current_state) : undefined;
    const operation = this.activeOperation(row.id);
    const failed = this.lastFailedState(row);
    const projects = (this.db.prepare('SELECT project_id FROM connections WHERE folder_id=? ORDER BY rowid').all(row.id) as { project_id: string }[])
      .filter(c => this.canSeeProject(actor, c.project_id))
      .map(c => ({ id: c.project_id, name: this.projectName(c.project_id) }));
    return { id: row.id, external: this.external.summary(row.id), name: row.name, description: row.description, profile: row.profile, classification: row.classification, outputPolicy: row.output_policy, active: !!row.active,
      quotaBytes: row.quota_bytes, usedBytes: this.usedBytes(row.id), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at ?? undefined,
      current: current && this.coverage(current), operation: operation && this.operationSummary(operation.id),
      failed: failed && { stateId: failed.id, coverage: this.coverage(failed), failure: failed.failure ?? undefined },
      managers, projects, canManage: this.can(actor, row.id, 'manage'), canUpload: this.can(actor, row.id, 'upload'), canDelete: this.can(actor, row.id, 'delete') };
  }
  listFolders(actor: LibraryActor) {
    const rows = actor.admin
      ? this.db.prepare('SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY lower(name)').all() as FolderRow[]
      : this.db.prepare('SELECT f.* FROM folders f JOIN folder_managers m ON m.folder_id=f.id AND m.user_id=? WHERE f.deleted_at IS NULL ORDER BY lower(f.name)').all(actor.id) as FolderRow[];
    return rows.map(row => this.summary(row, actor));
  }
  /** A folder visible to its managers (any delegated action) and administrators; others get 404. */
  visibleFolder(actor: LibraryActor, id: string) {
    const row = this.folderRow(id);
    if (!row || !actor.admin && !this.managerActions(id, actor.id).length) { this.deny(actor, id, 'view', 'not_visible'); throw notFound(); }
    return row;
  }
  getFolder(actor: LibraryActor, id: string) { return this.summary(this.visibleFolder(actor, id), actor); }
  createFolder(actor: LibraryActor, input: { name: string; description?: string; profile?: LibraryProfile; classification?: LibraryClassification; outputPolicy?: OutputPolicy;
    active?: boolean; quotaBytes?: number; managers?: { userId: string; actions: LibraryAction[] }[]; origin?: string; external?: ExternalSelection }) {
    if (!actor.admin) throw new BridgeError('Папки библиотеки создаёт администратор.', 403);
    const name = input.name.trim();
    if (!name || name.length > 120) throw new BridgeError('Укажите название папки до 120 символов.');
    const quota = input.quotaBytes ?? this.limits.defaultQuotaBytes;
    if (!Number.isSafeInteger(quota) || quota < 1) throw new BridgeError('Некорректная квота.');
    this.validateManagers(input.managers ?? []);
    const id = 'lib_' + randomUUID().replaceAll('-', '');
    try {
      return this.tx(() => {
        this.db.prepare('INSERT INTO folders (id, name, description, profile, classification, output_policy, quota_bytes, active, revision, created_by, created_at, origin) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)')
          .run(id, name, (input.description ?? '').trim().slice(0, 2000), input.profile ?? 'documents', input.classification ?? 'shared', input.outputPolicy ?? 'explanation_only',
            quota, Number(input.active ?? (input.classification !== 'restricted')),
            actor.id, new Date(this.now()).toISOString(), input.origin ?? null);
        if (input.external) this.external.attach(actor.id, id, input.external);
        for (const m of input.managers ?? []) this.db.prepare('INSERT INTO folder_managers VALUES (?,?,?)').run(id, m.userId, JSON.stringify([...new Set(m.actions)]));
        return this.summary(this.folderRow(id)!, actor);
      }, () => [{ actorId: actor.id, action: 'library.folder.create', targetId: id }]);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) throw new BridgeError('Папка с таким названием уже есть.', 409);
      throw error;
    }
  }
  private validateManagers(managers: { userId: string; actions: LibraryAction[] }[]) {
    if (managers.length > 50 || new Set(managers.map(m => m.userId)).size !== managers.length
      || managers.some(m => typeof m.userId !== 'string' || !m.userId || m.userId.length > 100 || m.actions.some(a => !(libraryActions as readonly string[]).includes(a)))) {
      throw new BridgeError('Проверьте список управляющих и их действия.');
    }
  }
  updateFolder(actor: LibraryActor, id: string, input: { revision: number; name?: string; description?: string; profile?: LibraryProfile; classification?: LibraryClassification;
    outputPolicy?: OutputPolicy; active?: boolean; quotaBytes?: number; managers?: { userId: string; actions: LibraryAction[] }[] }) {
    const row = this.requireFolder(actor, id, 'manage');
    if ((input.managers || input.classification || input.active !== undefined || input.quotaBytes !== undefined) && !actor.admin) {
      throw new BridgeError('Права, состояние папки и квоту меняет администратор.', 403);
    }
    if (input.managers) this.validateManagers(input.managers);
    try {
      return this.tx(() => {
        const current = this.folderRow(id)!;
        if (current.revision !== input.revision) throw new BridgeError('Папка изменена другим пользователем. Обновите данные.', 409);
        const name = input.name?.trim() ?? row.name;
        if (!name || name.length > 120) throw new BridgeError('Укажите название папки до 120 символов.');
        const quota = input.quotaBytes ?? row.quota_bytes;
        if (!Number.isSafeInteger(quota) || quota < this.usedBytes(id)) throw new BridgeError('Квота меньше занятого объёма.', 409);
        this.db.prepare('UPDATE folders SET name=?, description=?, profile=?, classification=?, output_policy=?, quota_bytes=?, active=?, revision=revision+1 WHERE id=?')
          .run(name, (input.description ?? row.description).trim().slice(0, 2000), input.profile ?? row.profile, input.classification ?? row.classification,
            input.outputPolicy ?? row.output_policy, quota, input.active === undefined ? row.active : Number(input.active), id);
        if (input.managers) {
          this.db.prepare('DELETE FROM folder_managers WHERE folder_id=?').run(id);
          for (const m of input.managers) this.db.prepare('INSERT INTO folder_managers VALUES (?,?,?)').run(id, m.userId, JSON.stringify([...new Set(m.actions)]));
        }
        return this.summary(this.folderRow(id)!, actor);
      }, () => [{ actorId: actor.id, action: 'library.folder.update', targetId: id, details: { previousRevision: String(input.revision) } }]);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) throw new BridgeError('Папка с таким названием уже есть.', 409);
      throw error;
    }
  }
  /** Deletes the folder in every connected project: connections and grants go, objects are collected when no running answer reads them. */
  deleteFolder(actor: LibraryActor, id: string, revision: number) {
    this.requireFolder(actor, id, 'delete');
    const result = this.tx(() => {
      const row = this.folderRow(id)!;
      if (row.revision !== revision) throw new BridgeError('Папка изменена другим пользователем. Обновите данные.', 409);
      const projects = (this.db.prepare('SELECT project_id FROM connections WHERE folder_id=?').all(id) as { project_id: string }[]).map(r => r.project_id);
      const at = this.now();
      for (const op of this.db.prepare("SELECT id FROM operations WHERE folder_id=? AND status IN ('open','preparing')").all(id) as { id: string }[]) this.closeOperation(op.id, 'cancelled');
      this.db.prepare("UPDATE blobs SET state='orphan',orphaned_at=? WHERE folder_id=? AND state='pending' AND object_key GLOB 'library/external_*'").run(at,id);
      this.db.prepare('DELETE FROM external_sources WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM grants WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM connections WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM folder_managers WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM index_jobs WHERE state_id IN (SELECT id FROM states WHERE folder_id=?)').run(id);
      this.db.prepare("UPDATE states SET status='superseded' WHERE folder_id=? AND status IN ('ready','failed','preparing')").run(id);
      this.db.prepare("UPDATE folders SET deleted_at=?, current_state=NULL, name=name || ' [удалена ' || id || ']', revision=revision+1 WHERE id=?").run(new Date(at).toISOString(), id);
      return { ok: true, projects };
    }, value => [{ actorId: actor.id, action: 'library.folder.delete', targetId: id, details: { objectIds: { projects: value.projects.join(',') } } }]);
    const sync = this.external.cancel(id);
    const collect = () => this.collectGarbage({ graceMs: 0 });
    void (sync ? sync.then(collect, collect) : collect()).catch(() => {});
    return { ...result, projects: result.projects.filter(projectId => this.canSeeProject(actor, projectId)) };
  }

  // ---- current content -----------------------------------------------------------------------
  currentState(folderId: string) {
    const row = this.folderRow(folderId);
    return row?.current_state ? this.stateRow(row.current_state) : undefined;
  }
  file(stateId: string, fileId: string) { return this.db.prepare(fileSelect + ' WHERE f.state_id=? AND f.file_id=?').get(stateId, fileId) as LibraryFile | undefined; }
  fileByPath(stateId: string, filePath: string) { return this.db.prepare(fileSelect + ' WHERE f.state_id=? AND f.path=?').get(stateId, filePath) as LibraryFile | undefined; }
  /** Lists one directory level of a content state; empty folders are not stored. `allow` restricts a grant to listed paths. */
  tree(stateId: string, prefix: string, cursor = '', limit = 200, allow?: ReadonlySet<string>) {
    if (prefix && pathProblem(prefix.replace(/\/$/, ''), { maxPathLength: this.limits.maxPathLength, maxDepth: this.limits.maxDepth })) throw new BridgeError('Некорректный путь.');
    const base = prefix ? prefix.replace(/\/?$/, '/') : '';
    const high = '\uffff';
    const entries: { name: string; type: 'dir' | 'file'; fileId?: string; size?: number; extraction?: string; lines?: number; language?: string }[] = [];
    const seen = new Set<string>();
    let next: string | undefined;
    if (!allow) {
      const upper = base + high;
      const query = this.db.prepare(fileSelect + ' WHERE f.state_id=? AND f.path >= ? AND f.path < ? AND f.path > ? ORDER BY f.path LIMIT 16');
      let minPath = base;
      let after = cursor ? base + cursor : '';
      while (true) {
        const batch = query.all(stateId, minPath, upper, after) as LibraryFile[];
        if (!batch.length) break;
        let jumped = false;
        for (const row of batch) {
          if (row.path < minPath) continue;
          const rest = row.path.slice(base.length);
          const slash = rest.indexOf('/');
          const name = slash >= 0 ? rest.slice(0, slash) : rest;
          if (!seen.has(name)) {
            if (entries.length >= limit) {
              next = entries.at(-1)!.name + (entries.at(-1)!.type === 'dir' ? '/' + high : '');
              return { path: base, entries, next };
            }
            seen.add(name);
            entries.push(slash >= 0 ? { name, type: 'dir' } : { name, type: 'file', fileId: row.file_id, size: row.size,
              extraction: row.extraction_state, lines: row.line_count ?? undefined, language: row.language ?? undefined });
          }
          if (slash >= 0) {
            minPath = base + name + '0';
            if (batch.length === 16 && batch.at(-1)!.path < minPath) { after = ''; jumped = true; break; }
          } else {
            after = row.path;
          }
        }
        if (!jumped && batch.length < 16) break;
      }
      return { path: base, entries, next };
    }
    const rows = (this.db.prepare(fileSelect + ' WHERE f.state_id=? AND f.path >= ? AND f.path < ? AND f.path > ? ORDER BY f.path LIMIT ?')
      .all(stateId, base, base + high, cursor ? base + cursor : '', 20_000) as LibraryFile[]).filter(row => allow.has(row.path));
    for (const row of rows) {
      const rest = row.path.slice(base.length);
      const slash = rest.indexOf('/');
      const name = slash >= 0 ? rest.slice(0, slash) : rest;
      if (seen.has(name)) continue;
      if (entries.length >= limit) { next = entries.at(-1)!.name + (entries.at(-1)!.type === 'dir' ? '/' + high : ''); break; }
      seen.add(name);
      entries.push(slash >= 0 ? { name, type: 'dir' } : { name, type: 'file', fileId: row.file_id, size: row.size, extraction: row.extraction_state,
        lines: row.line_count ?? undefined, language: row.language ?? undefined });
    }
    if (!next && rows.length === 20_000) next = rows.at(-1)!.path.slice(base.length);
    return { path: base, entries, next };
  }
  /** Files without search with the reason (unsupported format/encoding, extraction error, timeout). */
  problems(stateId: string) {
    const where = `WHERE f.state_id=? AND coalesce(c.state,'pending') NOT IN ('indexed','limited','pending')`;
    const counts = this.db.prepare(`SELECT coalesce(c.state,'pending') state, count(*) n FROM state_files f LEFT JOIN contents c ON c.sha256=f.sha256 AND c.size=f.size
      ${where} GROUP BY 1`).all(stateId) as { state: string; n: number }[];
    const files = this.db.prepare(`SELECT f.path, c.state, c.note FROM state_files f LEFT JOIN contents c ON c.sha256=f.sha256 AND c.size=f.size
      ${where} ORDER BY c.state IN ${failureStates} DESC, f.path LIMIT 500`).all(stateId) as { path: string; state: string; note: string | null }[];
    return { counts: Object.fromEntries(counts.map(c => [c.state, c.n])), files };
  }

  // ---- operations: upload, update, add, remove -------------------------------------------------
  private operationRow(id: string) { return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined; }
  private requireOperation(actor: LibraryActor, operationId: string, folderId: string) {
    const row = this.operationRow(operationId);
    if (!row || row.folder_id !== folderId || row.actor_id !== actor.id && !actor.admin) throw new BridgeError('Загрузка не найдена.', 404);
    // Authorization is rechecked on every resume, part and completion.
    this.requireFolder(actor, row.folder_id, 'upload');
    if (row.status === 'open' && row.expires_at <= this.now()) { this.closeOperation(row.id, 'expired'); throw new BridgeError('Срок загрузки истёк. Начните заново.', 409); }
    return row;
  }
  authorizeOperation(actor: LibraryActor, folderId: string, operationId: string) { this.requireOperation(actor, operationId, folderId); }
  /**
   * Starts an upload. replace: the selected folder becomes the complete content (absent files are removed); add: files are added or replace
   * files with the same path. One operation per folder; a second one gets 409. The operation remembers the current content it is based on.
   */
  createOperation(actor: LibraryActor, folderId: string, input: { idempotencyKey: string; mode: 'replace' | 'add'; totalFiles: number; totalBytes: number; exclusions: string[] }) {
    const folder = this.requireFolder(actor, folderId, 'upload');
    this.store();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) throw new BridgeError('Укажите ключ идемпотентности.');
    if (input.mode !== 'replace' && input.mode !== 'add') throw new BridgeError('Некорректный режим загрузки.');
    if (!Number.isSafeInteger(input.totalFiles) || input.totalFiles < 1 || input.totalFiles > this.limits.maxFiles) throw new BridgeError(`Папка должна содержать от 1 до ${this.limits.maxFiles} файлов.`, 413);
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0) throw new BridgeError('Некорректный объём.', 413);
    if (input.exclusions.length > 200 || input.exclusions.some(rule => typeof rule !== 'string' || !rule || rule.length > 200)) throw new BridgeError('Проверьте правила исключения.');
    const requestHash = hash(JSON.stringify([folderId, input.mode, input.totalFiles, input.totalBytes, input.exclusions]));
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM operations WHERE actor_id=? AND idempotency_key=?').get(actor.id, input.idempotencyKey) as OperationRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new BridgeError('Ключ идемпотентности уже использован с другими параметрами.', 409);
        return { value: this.operationSummary(existing.id), created: false };
      }
      if (this.activeOperation(folderId)) throw busy();
      // The logical size of the new composition is checked in full; physical space is reserved later only for missing objects.
      const current = folder.current_state ? this.stateRow(folder.current_state) : undefined;
      const logical = input.mode === 'add' ? (current?.total_bytes ?? 0) + input.totalBytes : input.totalBytes;
      const files = input.mode === 'add' ? (current?.total_files ?? 0) + input.totalFiles : input.totalFiles;
      if (logical > folder.quota_bytes) throw new BridgeError('Объём папки превысит квоту.', 413);
      if (files > this.limits.maxFiles) throw new BridgeError(`В папке может быть не больше ${this.limits.maxFiles} файлов.`, 413);
      const id = randomUUID(), at = this.now();
      this.db.prepare(`INSERT INTO operations (id, folder_id, mode, actor_id, idempotency_key, request_hash, status, expires_at, declared_files, declared_bytes, base_state, exclusions, created_at)
        VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?)`).run(id, folderId, input.mode, actor.id, input.idempotencyKey, requestHash, at + this.limits.uploadTtlMs, input.totalFiles, input.totalBytes,
        folder.current_state, JSON.stringify(input.exclusions), at);
      return { value: this.operationSummary(id), created: true };
    }, ({ value, created }) => created ? [{ actorId: actor.id, action: 'library.upload.create', targetId: value.id,
      details: { objectIds: { folderId, mode: input.mode, files: String(input.totalFiles), bytes: String(input.totalBytes) } } }] : []).value;
  }
  operationSummary(operationId: string): OperationSummary {
    const row = this.operationRow(operationId)!;
    const counts = Object.fromEntries((this.db.prepare('SELECT state, count(*) n, coalesce(sum(size),0) b FROM operation_files WHERE operation_id=? GROUP BY state').all(operationId) as
      { state: string; n: number; b: number }[]).map(r => [r.state, r]));
    const partial = (this.db.prepare(`SELECT coalesce(sum(p.size),0) n FROM operation_parts p JOIN operation_files f ON f.operation_id=p.operation_id AND f.file_id=p.file_id
      WHERE p.operation_id=? AND f.state IN ('pending','uploading')`).get(operationId) as { n: number }).n;
    const n = (state: string) => counts[state]?.n ?? 0, b = (state: string) => counts[state]?.b ?? 0;
    const state = row.state_id ? this.stateRow(row.state_id) : undefined;
    return { id: row.id, folderId: row.folder_id, mode: row.mode === 'add' ? 'add' : 'replace', status: row.status, expiresAt: new Date(row.expires_at).toISOString(),
      reservedBytes: row.reserved_bytes, manifestPages: row.manifest_pages, manifestComplete: !!row.manifest_complete,
      files: { total: row.manifest_files, pending: n('pending'), uploading: n('uploading'), verified: n('verified'), reused: n('reused'), failed: n('failed') },
      bytes: { total: row.manifest_bytes, transferred: b('verified') + partial, reused: b('reused') }, partBytes: this.limits.partBytes, failure: row.failure ?? undefined,
      diff: row.manifest_complete && (row.mode === 'replace' || row.mode === 'add') ? this.diff(row) : undefined,
      processing: state && { state: state.status, coverage: this.coverage(state), failure: state.failure ?? undefined } };
  }
  /** Changes against the content the operation is based on, by path and content hash. */
  private diff(row: OperationRow) {
    const files = row.status === 'open' || row.status === 'unchanged';
    if (!files && row.state_id) {
      const q = (sql: string) => (this.db.prepare(sql).get(row.state_id, row.base_state) as { n: number }).n;
      if (!row.base_state) return { added: (this.db.prepare('SELECT count(*) n FROM state_files WHERE state_id=?').get(row.state_id) as { n: number }).n, changed: 0, removed: 0 };
      return {
        added: q('SELECT count(*) n FROM state_files u WHERE u.state_id=? AND NOT EXISTS (SELECT 1 FROM state_files s WHERE s.state_id=? AND s.path_key=u.path_key)'),
        changed: q('SELECT count(*) n FROM state_files u JOIN state_files s ON s.path_key=u.path_key WHERE u.state_id=? AND s.state_id=? AND (s.path<>u.path OR s.sha256<>u.sha256 OR s.size<>u.size)'),
        removed: (this.db.prepare('SELECT count(*) n FROM state_files s WHERE s.state_id=? AND NOT EXISTS (SELECT 1 FROM state_files u WHERE u.state_id=? AND u.path_key=s.path_key)')
          .get(row.base_state, row.state_id) as { n: number }).n,
      };
    }
    const base = row.base_state ?? '';
    const q = (sql: string) => (this.db.prepare(sql).get(row.id, base) as { n: number }).n;
    return {
      added: q('SELECT count(*) n FROM operation_files u WHERE u.operation_id=? AND NOT EXISTS (SELECT 1 FROM state_files s WHERE s.state_id=? AND s.path_key=u.path_key)'),
      changed: q('SELECT count(*) n FROM operation_files u JOIN state_files s ON s.path_key=u.path_key WHERE u.operation_id=? AND s.state_id=? AND (s.path<>u.path OR s.sha256<>u.sha256 OR s.size<>u.size)'),
      removed: row.mode === 'add' ? 0 : (this.db.prepare('SELECT count(*) n FROM state_files s WHERE s.state_id=? AND NOT EXISTS (SELECT 1 FROM operation_files u WHERE u.operation_id=? AND u.path_key=s.path_key)')
        .get(base, row.id) as { n: number }).n,
    };
  }
  /**
   * Manifest pages are immutable: an identical retry is accepted, a different page with the same number is a conflict. Physical space is reserved
   * only for objects this folder does not already store. When the last page shows no changes, the operation ends as "unchanged".
   */
  putManifest(actor: LibraryActor, folderId: string, operationId: string, input: { page: number; last: boolean; entries: (ManifestEntry & { secretFindings?: string[] })[] }) {
    const operation = this.requireOperation(actor, operationId, folderId);
    if (!Number.isSafeInteger(input.page) || input.page < 0) throw new BridgeError('Некорректный номер страницы списка файлов.');
    if (!Array.isArray(input.entries) || input.entries.length > this.limits.manifestPageEntries) throw new BridgeError(`Страница списка содержит до ${this.limits.manifestPageEntries} записей.`);
    const pageHash = hash(JSON.stringify([input.page, input.last, input.entries.map(e => [e.path, e.size, e.sha256, e.secretFindings ?? []])]));
    const exclusions = json<string[]>(operation.exclusions, []);
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
    if (problems.length) throw Object.assign(new BridgeError('Список файлов содержит недопустимые записи: ' + problems.slice(0, 5).map(p => `${p.path} (${p.problem})`).join(', ')), { problems });
    return this.tx(() => {
      const current = this.operationRow(operationId)!;
      const existing = this.db.prepare('SELECT hash FROM operation_pages WHERE operation_id=? AND page=?').get(operationId, input.page) as { hash: string } | undefined;
      if (existing) {
        if (existing.hash !== pageHash) throw new BridgeError('Страница списка файлов уже принята с другим содержимым. Начните загрузку заново.', 409);
        return { value: this.operationSummary(operationId), changed: false };
      }
      if (current.status !== 'open') throw new BridgeError('Загрузка уже закрыта.', 409);
      if (current.manifest_complete) throw new BridgeError('Список файлов уже передан полностью.', 409);
      if (input.page !== current.manifest_pages) throw new BridgeError(`Ожидается страница списка ${current.manifest_pages}.`, 409);
      const files = current.manifest_files + input.entries.length, bytes = current.manifest_bytes + input.entries.reduce((s, e) => s + e.size, 0);
      if (files > current.declared_files) throw new BridgeError('Список содержит больше файлов, чем заявлено.', 413);
      if (bytes > current.declared_bytes) throw new BridgeError('Список превышает заявленный объём.', 413);
      const insert = this.db.prepare(`INSERT INTO operation_files (operation_id, file_id, path, path_key, size, sha256, state, blob_id, parts_total, secret_findings, ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const reuse = this.db.prepare("SELECT id FROM blobs WHERE folder_id=? AND sha256=? AND size=? AND state='verified' AND kind='original' LIMIT 1");
      const collisions: string[] = [];
      let missing = 0;
      const counted = new Set<string>();
      input.entries.forEach((entry, index) => {
        const key = pathKey(entry.path);
        const clash = this.db.prepare('SELECT path FROM operation_files WHERE operation_id=? AND path_key=?').get(operationId, key) as { path: string } | undefined;
        if (clash) { collisions.push(`${clash.path} ↔ ${entry.path}`); return; }
        const blob = reuse.get(current.folder_id, entry.sha256, entry.size) as { id: string } | undefined;
        if (!blob && !counted.has(entry.sha256 + entry.size)) { counted.add(entry.sha256 + entry.size); missing += entry.size; }
        const parts = Math.max(1, Math.ceil(entry.size / this.limits.partBytes));
        const findings = entry.secretFindings?.length ? JSON.stringify(entry.secretFindings) : null;
        insert.run(operationId, 'f_' + randomUUID().replaceAll('-', ''), entry.path, key, entry.size, entry.sha256, blob ? 'reused' : 'pending', blob?.id ?? null, parts, findings, current.manifest_files + index);
      });
      if (collisions.length) throw new BridgeError('Пути различаются только регистром или нормализацией: ' + collisions.slice(0, 5).join(', '), 409);
      if (input.last && files !== current.declared_files) throw new BridgeError(`Заявлено файлов: ${current.declared_files}, в списке: ${files}.`, 409);
      const folder = this.folderRow(current.folder_id)!;
      if (this.usedBytes(folder.id) + this.reservedBytes(folder.id, operationId) + current.reserved_bytes + missing > folder.quota_bytes) {
        throw new BridgeError('Недостаточно места в квоте папки для новых файлов.', 413);
      }
      this.db.prepare('INSERT INTO operation_pages VALUES (?,?,?)').run(operationId, input.page, pageHash);
      this.db.prepare('UPDATE operations SET manifest_pages=manifest_pages+1, manifest_complete=?, manifest_files=?, manifest_bytes=?, reserved_bytes=reserved_bytes+?, expires_at=? WHERE id=?')
        .run(input.last ? 1 : 0, files, bytes, missing, this.now() + this.limits.uploadTtlMs, operationId);
      if (input.last && this.unchanged(this.operationRow(operationId)!)) {
        this.db.prepare("UPDATE operations SET status='unchanged', reserved_bytes=0 WHERE id=?").run(operationId);
      }
      return { value: this.operationSummary(operationId), changed: true };
    }, ({ value, changed }) => [
      ...(changed && input.entries.some(e => e.secretFindings?.length) ? [{ actorId: actor.id, action: 'library.upload.secret_flagged', targetId: operationId,
        details: { objectIds: { count: String(input.entries.filter(e => e.secretFindings?.length).length) } } }] : []),
      ...(changed && value.status === 'unchanged' ? [{ actorId: actor.id, action: 'library.upload.unchanged', targetId: operationId }] : []),
    ]).value;
  }
  /** True when the manifest would not change the current content (same paths, sizes and hashes). */
  private unchanged(row: OperationRow) {
    if (!row.base_state) return false;
    const changed = this.diff({ ...row, status: 'open' });
    return changed.added === 0 && changed.changed === 0 && changed.removed === 0;
  }
  /** Explicit, audited manager decision to include a file flagged as a possible secret. */
  secretDecision(actor: LibraryActor, folderId: string, operationId: string, fileId: string) {
    this.requireOperation(actor, operationId, folderId);
    this.requireFolder(actor, folderId, 'manage');
    return this.tx(() => {
      const file = this.operationFile(operationId, fileId);
      if (!file?.secret_findings) throw new BridgeError('Файл не отмечен как подозрительный.', 409);
      this.db.prepare("UPDATE operation_files SET secret_decision='include' WHERE operation_id=? AND file_id=?").run(operationId, fileId);
      return { ok: true };
    }, () => [{ actorId: actor.id, action: 'library.upload.secret_include', targetId: operationId, details: { objectIds: { fileId } } }]);
  }
  private operationFile(operationId: string, fileId: string) {
    return this.db.prepare('SELECT * FROM operation_files WHERE operation_id=? AND file_id=?').get(operationId, fileId) as OperationFileRow | undefined;
  }
  /** Status with a page of files that still need bytes, in manifest order. */
  operationStatus(actor: LibraryActor, folderId: string, operationId: string, cursor = -1, limit = 200) {
    this.requireOperation(actor, operationId, folderId);
    const rows = this.db.prepare("SELECT * FROM operation_files WHERE operation_id=? AND state IN ('pending','uploading','failed') AND ordinal>? ORDER BY ordinal LIMIT ?")
      .all(operationId, cursor, Math.min(Math.max(limit, 1), 1000)) as OperationFileRow[];
    const files: (UploadFileStatus & { failure?: string; secretFindings?: string[]; secretDecision?: string })[] = rows.map(row => ({
      fileId: row.file_id, path: row.path, size: row.size, sha256: row.sha256, state: row.state, partsTotal: row.parts_total,
      partsReceived: (this.db.prepare('SELECT part FROM operation_parts WHERE operation_id=? AND file_id=? ORDER BY part').all(operationId, row.file_id) as { part: number }[]).map(p => p.part),
      failure: row.failure ?? undefined, secretFindings: json<string[] | undefined>(row.secret_findings, undefined), secretDecision: row.secret_decision ?? undefined,
    }));
    return { operation: this.operationSummary(operationId), files, next: rows.length === limit ? rows.at(-1)!.ordinal : undefined };
  }
  private async lockFile<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.fileLocks.set(key, next);
    try { return await next; } finally { if (this.fileLocks.get(key) === next) this.fileLocks.delete(key); }
  }
  /** Stores one part. The server computes size and SHA-256; a repeated identical part is a no-op. */
  async putPart(actor: LibraryActor, folderId: string, operationId: string, fileId: string, part: number, body: Buffer, declaredSha256?: string) {
    const operation = this.requireOperation(actor, operationId, folderId);
    if (operation.status !== 'open') throw new BridgeError('Загрузка закрыта.', 409);
    const store = this.store();
    const file = this.operationFile(operationId, fileId);
    if (!file) throw new BridgeError('Файл не найден в списке загрузки.', 404);
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
          this.db.prepare('UPDATE operation_files SET secret_findings=? WHERE operation_id=? AND file_id=?').run(JSON.stringify(findings), operationId, fileId);
          this.recordAudit({ actorId: actor.id, action: 'library.upload.secret_flagged', targetId: operationId, details: { objectIds: { fileId } } });
          throw new BridgeError('Файл похож на секрет (' + findings.join(', ') + '). Исключите его или получите решение управляющего.', 409);
        }
      }
    }
    if (this.activeParts >= this.limits.uploadConcurrency) throw new BridgeError('Сервер загружает другие части. Повторите позже.', 429);
    this.activeParts++;
    try {
      return await this.lockFile(operationId + '/' + fileId, async () => {
        const current = this.operationFile(operationId, fileId)!;
        const existing = this.db.prepare('SELECT sha256 FROM operation_parts WHERE operation_id=? AND file_id=? AND part=?').get(operationId, fileId, part) as { sha256: string } | undefined;
        if (existing) {
          if (existing.sha256 !== partHash) throw new BridgeError('Часть уже принята с другим содержимым.', 409);
          return { file: this.fileStatus(operationId, fileId), duplicate: true };
        }
        if (current.state === 'verified' || current.state === 'reused') return { file: this.fileStatus(operationId, fileId), duplicate: true };
        // Identical content already verified in this folder (for example a copy at another path): link instead of storing another copy.
        const known = this.db.prepare("SELECT id FROM blobs WHERE folder_id=? AND sha256=? AND size=? AND state='verified' AND kind='original' LIMIT 1").get(folderId, current.sha256, current.size) as { id: string } | undefined;
        if (known) {
          if (current.s3_upload_id && current.blob_id) await this.abandonBlob(current.blob_id, current.s3_upload_id);
          this.db.prepare("UPDATE operation_files SET state='reused', blob_id=?, s3_upload_id=NULL, failure=NULL WHERE operation_id=? AND file_id=?").run(known.id, operationId, fileId);
          this.db.prepare('DELETE FROM operation_parts WHERE operation_id=? AND file_id=?').run(operationId, fileId);
          return { file: this.fileStatus(operationId, fileId), duplicate: false };
        }
        let blobId = current.blob_id;
        if (!blobId || current.state === 'failed') {
          blobId = 'b_' + randomUUID().replaceAll('-', '');
          this.db.prepare("INSERT INTO blobs (id, folder_id, object_key, sha256, size, kind, state, created_at) VALUES (?,?,?,?,?,'original','pending',?)")
            .run(blobId, folderId, blobKey(folderId, blobId), current.sha256, current.size, this.now());
          this.db.prepare("UPDATE operation_files SET blob_id=?, state='uploading', s3_upload_id=NULL, failure=NULL WHERE operation_id=? AND file_id=?").run(blobId, operationId, fileId);
        }
        const key = blobKey(folderId, blobId);
        if (current.parts_total === 1) {
          if (partHash !== current.sha256) return this.failFile(operationId, fileId, blobId, 'Хеш файла не совпадает со списком. Файл изменился во время загрузки — передайте его заново.');
          await store.put(key, body);
          const head = await store.head(key);
          if (!head || head.size !== current.size) return this.failFile(operationId, fileId, blobId, 'Размер сохранённого объекта не совпадает.');
          this.tx(() => {
            this.db.prepare('INSERT INTO operation_parts VALUES (?,?,?,?,?,?)').run(operationId, fileId, 1, body.length, partHash, 'single');
            this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(blobId);
            this.db.prepare("UPDATE operation_files SET state='verified' WHERE operation_id=? AND file_id=?").run(operationId, fileId);
            this.touch(operationId);
          });
          return { file: this.fileStatus(operationId, fileId), duplicate: false };
        }
        let s3UploadId = this.operationFile(operationId, fileId)!.s3_upload_id;
        if (!s3UploadId) {
          s3UploadId = await store.createMultipart(key);
          this.db.prepare('UPDATE operation_files SET s3_upload_id=? WHERE operation_id=? AND file_id=?').run(s3UploadId, operationId, fileId);
        }
        const etag = await store.uploadPart(key, s3UploadId, part, body);
        this.tx(() => {
          this.db.prepare('INSERT INTO operation_parts VALUES (?,?,?,?,?,?)').run(operationId, fileId, part, body.length, partHash, etag);
          this.touch(operationId);
        });
        const parts = this.db.prepare('SELECT part, etag FROM operation_parts WHERE operation_id=? AND file_id=? ORDER BY part').all(operationId, fileId) as { part: number; etag: string }[];
        if (parts.length === current.parts_total) await this.finishMultipart(operationId, fileId, blobId, key, s3UploadId, parts);
        return { file: this.fileStatus(operationId, fileId), duplicate: false };
      });
    } finally { this.activeParts--; }
  }
  private touch(operationId: string) { this.db.prepare("UPDATE operations SET expires_at=? WHERE id=? AND status='open'").run(this.now() + this.limits.uploadTtlMs, operationId); }
  private fileStatus(operationId: string, fileId: string): UploadFileStatus & { failure?: string } {
    const row = this.operationFile(operationId, fileId)!;
    return { fileId, path: row.path, size: row.size, sha256: row.sha256, state: row.state, partsTotal: row.parts_total, failure: row.failure ?? undefined,
      partsReceived: (this.db.prepare('SELECT part FROM operation_parts WHERE operation_id=? AND file_id=? ORDER BY part').all(operationId, fileId) as { part: number }[]).map(p => p.part) };
  }
  private async failFile(operationId: string, fileId: string, blobId: string, message: string): Promise<never> {
    const row = this.operationFile(operationId, fileId);
    await this.abandonBlob(blobId, row?.s3_upload_id ?? undefined);
    this.db.prepare("UPDATE operation_files SET state='failed', failure=?, blob_id=NULL, s3_upload_id=NULL WHERE operation_id=? AND file_id=?").run(message, operationId, fileId);
    this.db.prepare('DELETE FROM operation_parts WHERE operation_id=? AND file_id=?').run(operationId, fileId);
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
  private async finishMultipart(operationId: string, fileId: string, blobId: string, key: string, s3UploadId: string, parts: { part: number; etag: string }[]) {
    const store = this.store();
    const file = this.operationFile(operationId, fileId)!;
    await store.completeMultipart(key, s3UploadId, parts.map(p => ({ partNumber: p.part, etag: p.etag })));
    this.db.prepare('UPDATE operation_files SET s3_upload_id=NULL WHERE operation_id=? AND file_id=?').run(operationId, fileId);
    // The client hash is not proof: re-read the stored object and verify size and SHA-256 on the server.
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of await store.stream(key)) { size += (chunk as Buffer).length; digest.update(chunk as Buffer); }
    if (size !== file.size || digest.digest('hex') !== file.sha256) {
      await this.failFile(operationId, fileId, blobId, 'Содержимое файла не совпадает со списком. Файл изменился во время загрузки — передайте его заново.');
    }
    this.tx(() => {
      this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(blobId);
      this.db.prepare("UPDATE operation_files SET state='verified' WHERE operation_id=? AND file_id=?").run(operationId, fileId);
    });
  }
  /**
   * Completes the transfer and prepares the new content: replace — exactly the uploaded files; add — the current files plus the uploaded ones
   * (same path replaced). The prepared content is processed in the background and replaces the current one only when it is ready.
   */
  async completeOperation(actor: LibraryActor, folderId: string, operationId: string, idempotencyKey: string) {
    const operation = this.requireOperation(actor, operationId, folderId);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new BridgeError('Укажите ключ идемпотентности.');
    if (operation.complete_key) {
      if (operation.complete_key !== idempotencyKey) throw new BridgeError('Загрузка уже завершается другим запросом.', 409);
      return this.operationSummary(operationId);
    }
    if (operation.status === 'unchanged') return this.operationSummary(operationId);
    if (operation.status !== 'open') throw new BridgeError('Загрузка закрыта.', 409);
    if (!operation.manifest_complete) throw new BridgeError('Список файлов передан не полностью.', 409);
    const remaining = this.db.prepare("SELECT path FROM operation_files WHERE operation_id=? AND state NOT IN ('verified','reused') LIMIT 5").all(operationId) as { path: string }[];
    if (remaining.length) throw new BridgeError('Не все файлы переданы и проверены: ' + remaining.map(r => r.path).join(', '), 409);
    const store = this.store();
    // Reused objects must exist and belong to this folder before the new content references them.
    const reused = this.db.prepare(`SELECT DISTINCT b.id, b.object_key, b.size, b.folder_id FROM operation_files f JOIN blobs b ON b.id=f.blob_id WHERE f.operation_id=? AND f.state='reused'`)
      .all(operationId) as { id: string; object_key: string; size: number; folder_id: string }[];
    for (const blob of reused) {
      const head = blob.folder_id === folderId ? await store.head(blob.object_key) : undefined;
      if (!head || head.size !== blob.size) {
        this.tx(() => {
          this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=? AND folder_id=?").run(this.now(), blob.id, folderId);
          this.db.prepare("UPDATE operation_files SET state='pending', blob_id=NULL WHERE operation_id=? AND blob_id=? AND state='reused'").run(operationId, blob.id);
        });
        throw new BridgeError('Часть ранее загруженных файлов недоступна в хранилище. Передайте отмеченные файлы заново.', 409);
      }
    }
    return this.tx(() => {
      const current = this.operationRow(operationId)!;
      if (current.complete_key) { if (current.complete_key !== idempotencyKey) throw new BridgeError('Загрузка уже завершается другим запросом.', 409); return this.operationSummary(operationId); }
      if (current.status !== 'open') throw new BridgeError('Загрузка закрыта.', 409);
      this.requireFolder(actor, folderId, 'upload');
      const folder = this.folderRow(folderId)!;
      if (folder.current_state !== current.base_state) throw new BridgeError('Папка уже обновлена другой операцией. Начните загрузку заново.', 409);
      const uploaded = this.db.prepare('SELECT * FROM operation_files WHERE operation_id=? ORDER BY path').all(operationId) as OperationFileRow[];
      if (uploaded.some(f => f.state !== 'verified' && f.state !== 'reused')) throw new BridgeError('Не все файлы проверены.', 409);
      const files: Omit<StateFileRow, 'state_id' | 'content'>[] = uploaded.map(f => ({ file_id: f.file_id, path: f.path, path_key: f.path_key, blob_id: f.blob_id!, sha256: f.sha256, size: f.size }));
      if (current.mode === 'add' && current.base_state) {
        const replaced = new Set(files.map(f => f.path_key));
        for (const f of this.db.prepare('SELECT * FROM state_files WHERE state_id=?').all(current.base_state) as StateFileRow[]) if (!replaced.has(f.path_key)) files.push(f);
      }
      const stateId = this.prepareState(folder, files, current.base_state, actor.id, json<string[]>(current.exclusions, []));
      this.db.prepare("UPDATE operations SET status='preparing', complete_key=?, reserved_bytes=0, state_id=? WHERE id=?").run(idempotencyKey, stateId, operationId);
      this.db.prepare('DELETE FROM operation_parts WHERE operation_id=?').run(operationId);
      this.tryPublish(stateId);
      return this.operationSummary(operationId);
    }, value => [{ actorId: actor.id, action: 'library.upload.complete', targetId: operationId, details: { objectIds: { folderId, files: String(value.files.total) } } }]);
  }
  /** Removes files from the current content; the change is published at once (their contents need no processing). */
  removeFiles(actor: LibraryActor, folderId: string, input: { paths: string[]; revision?: number }) {
    const folder = this.requireFolder(actor, folderId, 'upload');
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1000) throw new BridgeError('Укажите от 1 до 1000 файлов.');
    return this.tx(() => {
      if (this.activeOperation(folderId)) throw busy();
      const current = this.folderRow(folderId)!;
      if (!current.current_state) throw new BridgeError('В папке ещё нет материалов.', 409);
      const keys = new Set(input.paths.map(p => pathKey(String(p))));
      const files = this.db.prepare('SELECT * FROM state_files WHERE state_id=?').all(current.current_state) as StateFileRow[];
      const kept = files.filter(f => !keys.has(f.path_key));
      if (kept.length === files.length) throw new BridgeError('Файлы не найдены в папке.', 404);
      const id = randomUUID(), at = this.now();
      this.db.prepare(`INSERT INTO operations (id, folder_id, mode, actor_id, idempotency_key, request_hash, status, expires_at, declared_files, declared_bytes, base_state, exclusions, created_at)
        VALUES (?,?,'remove',?,?,?,'preparing',?,0,0,?,'[]',?)`).run(id, folderId, actor.id, 'remove-' + id.replaceAll('-', '').slice(0, 24), hash(id), at, current.current_state, at);
      const stateId = this.prepareState(folder, kept, current.current_state, actor.id, []);
      this.db.prepare('UPDATE operations SET state_id=? WHERE id=?').run(stateId, id);
      this.tryPublish(stateId);
      return { removed: files.length - kept.length, operation: this.operationSummary(id) };
    }, value => [{ actorId: actor.id, action: 'library.files.remove', targetId: folderId, details: { objectIds: { count: String(value.removed) } } }]);
  }
  /**
   * Processes failed or timed-out files again: of the last unpublished update, otherwise of the current content.
   * The result replaces the current content after processing, like an update.
   */
  retry(actor: LibraryActor, folderId: string) {
    const external = this.external.has(folderId);
    const folder = this.requireFolder(actor, folderId, external ? 'manage' : 'upload');
    return this.tx(() => {
      if (this.activeOperation(folderId)) throw busy();
      const failed = this.lastFailedState(folder);
      const source = failed ?? (folder.current_state ? this.stateRow(folder.current_state) : undefined);
      if (!source) throw new BridgeError('В папке ещё нет материалов.', 409);
      const files = this.db.prepare('SELECT * FROM state_files WHERE state_id=?').all(source.id) as StateFileRow[];
      const retries = this.db.prepare(`SELECT DISTINCT f.content FROM contents c JOIN state_files f ON f.sha256=c.sha256 AND f.size=c.size
        WHERE f.state_id=? AND c.state IN ${failureStates}`).all(source.id) as { content: string }[];
      for (const retry of retries) this.deleteContentIndex(retry.content);
      this.db.prepare(`DELETE FROM contents WHERE state IN ${failureStates} AND EXISTS (SELECT 1 FROM state_files f WHERE f.state_id=? AND f.sha256=contents.sha256 AND f.size=contents.size)`).run(source.id);
      if (failed) this.db.prepare("UPDATE states SET status='superseded' WHERE id=?").run(failed.id);
      const id = randomUUID(), at = this.now();
      this.db.prepare(`INSERT INTO operations (id, folder_id, mode, actor_id, idempotency_key, request_hash, status, expires_at, declared_files, declared_bytes, base_state, exclusions, created_at)
        VALUES (?,?,'retry',?,?,?,'preparing',?,0,0,?,'[]',?)`).run(id, folderId, actor.id, 'retry-' + id.replaceAll('-', '').slice(0, 24), hash(id), at, folder.current_state, at);
      const stateId = this.prepareState(folder, files, folder.current_state, actor.id, json<string[]>(source.exclusions, []));
      if (external) {
        this.db.prepare('UPDATE states SET drive_signature=(SELECT drive_signature FROM states WHERE id=?) WHERE id=?').run(source.id,stateId);
        this.db.prepare('INSERT INTO external_files SELECT ?,path,remote_id,revision,link FROM external_files WHERE state_id=?').run(stateId,source.id);
      }
      this.db.prepare('UPDATE operations SET state_id=? WHERE id=?').run(stateId, id);
      this.tryPublish(stateId);
      return this.operationSummary(id);
    }, value => [{ actorId: actor.id, action: 'library.retry', targetId: folderId, details: { objectIds: { operationId: value.id } } }]);
  }
  /** Explicit, audited decision to publish the last failed update with the files that could not be processed marked as such. */
  acceptCoverage(actor: LibraryActor, folderId: string) {
    const folder = this.requireFolder(actor, folderId, 'manage');
    return this.tx(() => {
      const failed = this.lastFailedState(folder);
      if (!failed || failed.failure !== 'partial_index') throw new BridgeError('Нет обновления с ошибками обработки.', 409);
      if (this.activeOperation(folderId)) throw busy();
      if (this.folderRow(folderId)!.current_state !== failed.base_state) throw new BridgeError('Папка уже обновлена другой операцией.', 409);
      this.db.prepare('UPDATE states SET coverage_accepted_by=? WHERE id=?').run(actor.id, failed.id);
      this.publish(failed.id);
      return this.summary(this.folderRow(folderId)!, actor);
    }, () => [{ actorId: actor.id, action: 'library.accept_partial', targetId: folderId }]);
  }
  prepareState(folder: FolderRow, files: Omit<StateFileRow, 'state_id' | 'content'>[], baseState: string | null, actorId: string, exclusions: string[]) {
    const id = 'st_' + randomUUID().replaceAll('-', '');
    const manifest = createHash('sha256');
    let bytes = 0;
    for (const f of [...files].sort((a, b) => a.path < b.path ? -1 : 1)) { manifest.update(f.path + '\0' + f.sha256 + '\0' + f.size + '\n'); bytes += f.size; }
    try {
      this.db.prepare("INSERT INTO states (id, folder_id, base_state, status, created_by, created_at, total_files, total_bytes, manifest_hash, exclusions) VALUES (?,?,?,'preparing',?,?,?,?,?,?)")
        .run(id, folder.id, baseState, actorId, this.now(), files.length, bytes, manifest.digest('hex'), JSON.stringify(exclusions));
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) throw busy();
      throw error;
    }
    const insert = this.db.prepare('INSERT INTO state_files (state_id, file_id, path, path_key, blob_id, sha256, size, content) VALUES (?,?,?,?,?,?,?,?)');
    for (const f of files) insert.run(id, 'f_' + randomUUID().replaceAll('-', ''), f.path, f.path_key, f.blob_id, f.sha256, f.size, contentKey(f.sha256, f.size));
    this.db.prepare("INSERT INTO index_jobs (state_id, status, created_at) VALUES (?,'queued',?)").run(id, this.now());
    return id;
  }
  /**
   * One-time transfer of existing material (former project files, earlier source uploads) into a folder as its new content.
   * Objects are stored like uploaded files and the content is processed and published as usual.
   */
  async importFiles(folderId: string, actorId: string, files: { path: string; data: Buffer }[]) {
    const store = this.store();
    const folder = this.folderRow(folderId);
    if (!folder) throw notFound();
    const prepared: Omit<StateFileRow, 'state_id' | 'content'>[] = [];
    const keys = new Set<string>();
    for (const file of files) {
      const problem = pathProblem(file.path, this.limits);
      if (problem || keys.has(pathKey(file.path))) throw new BridgeError('Некорректный путь при переносе: ' + file.path);
      keys.add(pathKey(file.path));
      const sha256 = hash(file.data), size = file.data.length;
      let blob = this.db.prepare("SELECT id FROM blobs WHERE folder_id=? AND sha256=? AND size=? AND state='verified' AND kind='original' LIMIT 1").get(folderId, sha256, size) as { id: string } | undefined;
      if (!blob) {
        const id = 'b_' + randomUUID().replaceAll('-', '');
        this.db.prepare("INSERT INTO blobs (id, folder_id, object_key, sha256, size, kind, state, created_at) VALUES (?,?,?,?,?,'original','pending',?)").run(id, folderId, blobKey(folderId, id), sha256, size, this.now());
        await store.put(blobKey(folderId, id), file.data);
        const head = await store.head(blobKey(folderId, id));
        if (!head || head.size !== size) throw new BridgeError('Не удалось сохранить файл при переносе: ' + file.path, 503);
        this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?").run(id);
        blob = { id };
      }
      prepared.push({ file_id: '', path: file.path, path_key: pathKey(file.path), blob_id: blob.id, sha256, size });
    }
    return this.tx(() => {
      if (this.activeOperation(folderId)) throw busy();
      const current = this.folderRow(folderId)!;
      const stateId = this.prepareState(current, prepared, current.current_state, actorId, []);
      this.tryPublish(stateId);
      return { stateId, files: prepared.length };
    }, value => [{ actorId, action: 'library.import', targetId: folderId, details: { objectIds: { files: String(value.files) } } }]);
  }
  importDone(key: string) { return !!this.db.prepare('SELECT 1 FROM imports WHERE key=?').get(key); }
  recordImport(key: string, report: object) { this.db.prepare('INSERT OR REPLACE INTO imports VALUES (?,?,?)').run(key, new Date(this.now()).toISOString(), JSON.stringify(report)); }
  /** Contents of a state that still need processing by the current processor. */
  pendingFiles(stateId: string) {
    return this.db.prepare(`SELECT f.* FROM state_files f WHERE f.state_id=? AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.sha256=f.sha256 AND c.size=f.size AND ${upToDate})
      ORDER BY f.path`).all(stateId) as StateFileRow[];
  }
  /** Publishes a prepared state when all its contents are processed; called after preparation and by the indexer. Runs inside a transaction. */
  tryPublish(stateId: string) {
    const state = this.stateRow(stateId);
    if (!state || state.status !== 'preparing') return false;
    if (this.db.prepare(`SELECT 1 FROM state_files f WHERE f.state_id=? AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.sha256=f.sha256 AND c.size=f.size AND ${upToDate}) LIMIT 1`)
      .get(stateId)) return false;
    const counts = this.processedCounts(stateId);
    this.db.prepare('UPDATE states SET indexed_files=?, unsupported_files=?, extraction_errors=? WHERE id=?').run(counts.indexed, counts.unsupported, counts.errors, stateId);
    this.db.prepare("UPDATE index_jobs SET status='done', lease_owner=NULL, lease_until=NULL, last_error=NULL WHERE state_id=?").run(stateId);
    if (counts.errors) { this.failState(stateId, 'partial_index'); return true; }
    this.publish(stateId);
    return true;
  }
  /** The prepared content replaces the current one atomically; the previous content is no longer offered to new answers. */
  private publish(stateId: string) {
    const state = this.stateRow(stateId)!;
    const folder = this.db.prepare('SELECT * FROM folders WHERE id=?').get(state.folder_id) as FolderRow;
    if (folder.deleted_at || folder.current_state !== state.base_state) { this.failState(stateId, 'conflict'); return; }
    const at = this.now();
    if (folder.current_state) this.db.prepare("UPDATE states SET status='superseded' WHERE id=?").run(folder.current_state);
    this.db.prepare("UPDATE states SET status='ready', ready_at=?, failure=NULL WHERE id=?").run(at, stateId);
    this.db.prepare('UPDATE folders SET current_state=?, updated_at=? WHERE id=?').run(stateId, new Date(at).toISOString(), folder.id);
    this.db.prepare("UPDATE operations SET status='complete' WHERE state_id=? AND status='preparing'").run(stateId);
    this.recordAudit({ actorId: 'system', action: 'library.published', targetId: folder.id, details: { objectIds: { files: String(state.total_files) } } });
  }
  private failState(stateId: string, failure: 'partial_index' | 'conflict' | 'index_failed') {
    this.db.prepare("UPDATE states SET status='failed', failure=? WHERE id=?").run(failure, stateId);
    this.db.prepare("UPDATE operations SET status='failed', failure=? WHERE state_id=? AND status='preparing'").run(failure === 'conflict'
      ? 'Папка уже обновлена другой операцией.' : failure === 'partial_index' ? 'Часть файлов не обработана.' : 'Обработка не завершилась.', stateId);
  }
  /** Called by the indexer after repeated failures of the whole job (for example storage outage). */
  failIndexing(stateId: string) { this.tx(() => { const s = this.stateRow(stateId); if (s?.status === 'preparing') this.failState(stateId, 'index_failed'); }); }
  async cancelOperation(actor: LibraryActor, folderId: string, operationId: string) {
    const operation = this.requireOperation(actor, operationId, folderId);
    if (operation.status === 'cancelled') return this.operationSummary(operationId);
    if (operation.status !== 'open' && operation.status !== 'preparing') throw new BridgeError('Завершённую загрузку отменить нельзя.', 409);
    this.tx(() => this.closeOperation(operationId, 'cancelled'));
    this.recordAudit({ actorId: actor.id, action: 'library.upload.cancel', targetId: operationId });
    await this.collectGarbage({ graceMs: 0 });
    return this.operationSummary(operationId);
  }
  /** Releases the reservation and marks unreferenced objects of the operation for collection. Runs inside a transaction. */
  private closeOperation(operationId: string, status: 'cancelled' | 'expired') {
    const row = this.operationRow(operationId)!;
    if (row.status !== 'open' && row.status !== 'preparing') return;
    this.db.prepare('UPDATE operations SET status=?, reserved_bytes=0 WHERE id=?').run(status, operationId);
    if (row.state_id) {
      this.db.prepare("UPDATE states SET status='cancelled' WHERE id=? AND status='preparing'").run(row.state_id);
      this.db.prepare('DELETE FROM index_jobs WHERE state_id=?').run(row.state_id);
    }
    this.db.prepare(`UPDATE blobs SET state='orphan', orphaned_at=? WHERE id IN (SELECT blob_id FROM operation_files WHERE operation_id=? AND blob_id IS NOT NULL) AND state IN ('verified','pending')
      AND NOT EXISTS (SELECT 1 FROM state_files s JOIN states st ON st.id=s.state_id WHERE s.blob_id=blobs.id AND st.status IN ('ready','preparing','failed'))`).run(this.now(), operationId);
  }
  private expireOperations() {
    for (const row of this.db.prepare("SELECT id FROM operations WHERE status='open' AND expires_at<=?").all(this.now()) as { id: string }[]) this.tx(() => this.closeOperation(row.id, 'expired'));
  }

  // ---- collection ----------------------------------------------------------------------------
  /** Content states read by running answers; they are kept until those answers finish (or 6 hours pass). */
  private heldStates() {
    const held = new Set<string>();
    for (const row of this.db.prepare('SELECT scope FROM run_scopes WHERE finished_at IS NULL AND created_at>?').all(this.now() - 6 * 3600_000) as { scope: string }[]) {
      for (const entry of json<{ entries?: { stateId?: string }[] }>(row.scope, {}).entries ?? []) if (entry.stateId) held.add(entry.stateId);
    }
    return held;
  }
  /**
   * Removes replaced, cancelled and old failed contents nobody reads, then their index rows and objects with zero references.
   * Objects of the current content are never touched.
   */
  async collectGarbage(options: { graceMs?: number } = {}) {
    const grace = options.graceMs ?? this.limits.orphanGraceMs;
    this.expireOperations();
    const held = this.heldStates();
    this.tx(() => {
      const latestFailed = new Set((this.db.prepare("SELECT id FROM states s WHERE status='failed' AND id=(SELECT id FROM states x WHERE x.folder_id=s.folder_id AND x.status='failed' ORDER BY created_at DESC, rowid DESC LIMIT 1)")
        .all() as { id: string }[]).map(r => r.id));
      const old = (this.db.prepare("SELECT id FROM states WHERE status IN ('superseded','cancelled','failed')").all() as { id: string }[])
        .map(r => r.id).filter(id => !held.has(id) && !latestFailed.has(id) && !this.db.prepare("SELECT 1 FROM operations WHERE state_id=? AND status IN ('open','preparing')").get(id));
      const at = this.now();
      for (const id of old) {
        const blobIds = (this.db.prepare('SELECT DISTINCT blob_id id FROM state_files WHERE state_id=?').all(id) as { id: string }[]).map(r => r.id);
        this.db.prepare('DELETE FROM external_files WHERE state_id=?').run(id);
        this.db.prepare('DELETE FROM state_files WHERE state_id=?').run(id);
        this.db.prepare('DELETE FROM index_jobs WHERE state_id=?').run(id);
        this.db.prepare("UPDATE states SET status='removed' WHERE id=?").run(id);
        const orphan = this.db.prepare(`UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=? AND state='verified' AND NOT EXISTS (SELECT 1 FROM state_files s WHERE s.blob_id=blobs.id)
          AND NOT EXISTS (SELECT 1 FROM operation_files u JOIN operations o ON o.id=u.operation_id WHERE u.blob_id=blobs.id AND o.status='open')`);
        for (const blobId of blobIds) orphan.run(at, blobId);
      }
      // Processing results of contents no longer referenced by any state.
      const unused = this.db.prepare(`SELECT c.sha256, c.size, c.text_blob_id FROM contents c WHERE NOT EXISTS (SELECT 1 FROM state_files f WHERE f.content=c.sha256 || ':' || c.size)`).all() as
        { sha256: string; size: number; text_blob_id: string | null }[];
      for (const c of unused) {
        this.deleteContentIndex(contentKey(c.sha256, c.size));
        this.db.prepare('DELETE FROM contents WHERE sha256=? AND size=?').run(c.sha256, c.size);
        if (c.text_blob_id) this.db.prepare("UPDATE blobs SET state='orphan', orphaned_at=? WHERE id=? AND state='verified'").run(at, c.text_blob_id);
      }
      this.db.prepare('DELETE FROM run_scopes WHERE created_at<?').run(at - runScopeRetentionMs);
    });
    const store = this.storage.store;

    const pendingMultipart = this.db.prepare(`SELECT f.operation_id, f.file_id, f.s3_upload_id, b.object_key FROM operation_files f JOIN operations o ON o.id=f.operation_id JOIN blobs b ON b.id=f.blob_id
      WHERE f.s3_upload_id IS NOT NULL AND o.status IN ('cancelled','expired','failed')`).all() as { operation_id: string; file_id: string; s3_upload_id: string; object_key: string }[];
    for (const item of pendingMultipart) {
      if (!store) break;
      try { await store.abortMultipart(item.object_key, item.s3_upload_id); this.db.prepare('UPDATE operation_files SET s3_upload_id=NULL WHERE operation_id=? AND file_id=?').run(item.operation_id, item.file_id); }
      catch { /* retried next time */ }
    }
    const candidates = this.db.prepare(`SELECT id, object_key FROM blobs WHERE state='orphan' AND orphaned_at<=? AND NOT EXISTS (SELECT 1 FROM state_files s WHERE s.blob_id=blobs.id)
      AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.text_blob_id=blobs.id)
      AND NOT EXISTS (SELECT 1 FROM operation_files u JOIN operations o ON o.id=u.operation_id WHERE u.blob_id=blobs.id AND o.status='open') LIMIT 1000`).all(this.now() - grace) as { id: string; object_key: string }[];
    let deleted = 0, failed = 0;
    for (const blob of candidates) {
      try { await this.objectStore(blob.object_key).delete(blob.object_key); this.db.prepare("UPDATE blobs SET state='deleted' WHERE id=?").run(blob.id); deleted++; }
      catch { failed++; }
    }
    return { deleted, failed };
  }
  /** Read-only check: objects of current contents exist with the recorded size. */
  async verifyObjects(folderId?: string) {
    const rows = this.db.prepare(`SELECT DISTINCT b.id, b.object_key, b.size FROM blobs b WHERE b.state='verified' ${folderId ? 'AND b.folder_id=?' : ''}`).all(...(folderId ? [folderId] : [])) as
      { id: string; object_key: string; size: number }[];
    const missing: string[] = [];
    for (const row of rows) { const head = await this.objectStore(row.object_key).head(row.object_key); if (!head || head.size !== row.size) missing.push(row.id); }
    return { checked: rows.length, missing };
  }
}
