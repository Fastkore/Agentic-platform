import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProfile, Dataset, WorkRole } from '../../shared/types.js';
import { defaultExclusions, excluded, pathKey, pathProblem } from '../../shared/sources.js';
import { BridgeError } from '../store.js';
import type { SourcePolicy } from './policy.js';
import type { SourceActor, SourceRegistry } from './registry.js';

export interface LegacyDirectory {
  datasets: () => Dataset[];
  profiles: () => AgentProfile[];
  roles: () => WorkRole[];
  projectExists: (projectId: string) => boolean;
}
export const legacyMigrationVersion = 1;
export interface LegacyReportItem {
  datasetId: string; name: string; classification: Dataset['classification']; directoryRegistered: boolean;
  projects: string[]; missingProjects: string[]; profiles: string[]; roles: string[];
  plan: { createSource: string; bindings: string[]; grants: 0; notes: string[] };
}
/**
 * Report of the legacy Dataset → source migration. Old read permissions (datasetIds/readDatasetIds) are NOT converted into grants:
 * they did not name a project, so any conversion would widen access. Bindings are created disabled, without specialists.
 */
export function legacyReport(directory: LegacyDirectory, registry: SourceRegistry) {
  const applied = registry.db.prepare('SELECT version, applied_at appliedAt, actor_id actorId FROM legacy_migrations ORDER BY version').all() as { version: number; appliedAt: string; actorId: string }[];
  const items: LegacyReportItem[] = directory.datasets().map(dataset => {
    const profiles = directory.profiles().filter(p => p.datasetIds.includes(dataset.id)).map(p => p.id);
    const roles = directory.roles().filter(r => r.readDatasetIds.includes(dataset.id)).map(r => r.id);
    const projects = dataset.projectIds.filter(id => directory.projectExists(id));
    const notes = [
      profiles.length || roles.length ? 'Права профилей/ролей на чтение не переносятся: назначьте специалистов в матрице проекта.' : '',
      dataset.projectIds.length !== projects.length ? 'Часть проектов источника удалена — привязки для них не создаются.' : '',
      !projects.length ? 'Проекты не указаны: источник попадёт только в реестр.' : '',
      'Содержимое серверной папки не копируется автоматически: используйте импорт после проверки предварительного просмотра.',
    ].filter(Boolean);
    return { datasetId: dataset.id, name: dataset.name, classification: dataset.classification, directoryRegistered: !!dataset.directory,
      projects, missingProjects: dataset.projectIds.filter(id => !projects.includes(id)), profiles, roles,
      plan: { createSource: `${dataset.name} (перенос)`, bindings: projects, grants: 0 as const, notes } };
  });
  return { version: legacyMigrationVersion, applied, items };
}
/** Applies the migration once (versioned, transactional, idempotent): sources + disabled bindings, no grants, legacy config untouched. */
export function applyLegacyMigration(actor: SourceActor, directory: LegacyDirectory, registry: SourceRegistry, policy: SourcePolicy) {
  if (!actor.admin) throw new BridgeError('Перенос выполняет руководитель.', 403);
  const report = legacyReport(directory, registry);
  if (report.applied.some(a => a.version === legacyMigrationVersion)) throw new BridgeError('Перенос этой версии уже выполнен.', 409);
  const created: { datasetId: string; sourceId: string; bindings: string[] }[] = [];
  registry.tx(() => {
    for (const item of report.items) {
      const id = 'src_' + randomUUID().replaceAll('-', '');
      registry.db.prepare(`INSERT INTO sources VALUES (?,?,?,?,?,'explanation_only',?,1,?,?,NULL)`).run(id, uniqueName(registry, item.plan.createSource),
        'Перенесено из прежнего серверного источника ' + item.datasetId, 'mixed', item.classification, registry.limits.defaultQuotaBytes, actor.id, new Date().toISOString());
      const bindings: string[] = [];
      for (const projectId of item.projects) {
        const bindingId = 'bnd_' + randomUUID().replaceAll('-', '');
        registry.db.prepare("INSERT INTO bindings VALUES (?,?,?,'pinned',NULL,'[]',?,'explanation_only',0,1,?)").run(bindingId, projectId, id, JSON.stringify(['use_for_analysis']), new Date().toISOString());
        bindings.push(bindingId);
      }
      created.push({ datasetId: item.datasetId, sourceId: id, bindings });
    }
    registry.db.prepare('INSERT INTO legacy_migrations VALUES (?,?,?,?,?)').run(randomUUID(), legacyMigrationVersion, actor.id, new Date().toISOString(), JSON.stringify({ ...report, created }));
  }, () => [{ actorId: actor.id, action: 'source.legacy.migrate', targetId: 'legacy-datasets', details: { objectIds: { version: String(legacyMigrationVersion), sources: String(created.length) } } }]);
  void policy;
  return { ...report, created };
}
function uniqueName(registry: SourceRegistry, name: string) {
  let candidate = name.slice(0, 110), n = 2;
  while (registry.db.prepare('SELECT 1 FROM sources WHERE lower(name)=lower(?) AND archived_at IS NULL').get(candidate)) candidate = `${name.slice(0, 105)} ${n++}`;
  return candidate;
}

export interface ScannedServerFile { path: string; absolute: string; size: number; sha256: string }
/** Walks a registered server directory without following symlinks/junctions and without leaving the root. */
export async function scanServerDirectory(root: string, rules: string[] = defaultExclusions, limits = { maxFiles: 50_000, maxFileBytes: 100 * 1024 * 1024 }) {
  const base = await realpath(root).catch(() => { throw new BridgeError('Папка источника недоступна.', 404); });
  const files: ScannedServerFile[] = [], skipped: { path: string; reason: string }[] = [];
  const keys = new Set<string>();
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = (relative ? relative + '/' : '') + entry.name.normalize('NFC');
      const absolute = path.join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue; }
      if (info.isDirectory()) {
        if (excluded(rel + '/x', rules)) { skipped.push({ path: rel + '/', reason: 'excluded' }); continue; }
        const real = await realpath(absolute);
        if (real !== base && !real.startsWith(base + path.sep)) { skipped.push({ path: rel, reason: 'outside_root' }); continue; }
        await walk(absolute, rel);
        continue;
      }
      if (!info.isFile()) { skipped.push({ path: rel, reason: 'special' }); continue; }
      if (excluded(rel, rules)) { skipped.push({ path: rel, reason: 'excluded' }); continue; }
      const problem = pathProblem(rel);
      if (problem) { skipped.push({ path: rel, reason: problem }); continue; }
      if (info.size > limits.maxFileBytes) { skipped.push({ path: rel, reason: 'too_large' }); continue; }
      if (keys.has(pathKey(rel))) { skipped.push({ path: rel, reason: 'case_collision' }); continue; }
      keys.add(pathKey(rel));
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) digest.update(chunk as Buffer);
      files.push({ path: rel, absolute, size: info.size, sha256: digest.digest('hex') });
      if (files.length > limits.maxFiles) throw new BridgeError('Папка содержит слишком много файлов.', 413);
    }
  };
  await walk(base, '');
  return { root: base, files, skipped };
}
/** Imports a legacy server directory (registered by an administrator) as a new snapshot through the regular upload protocol. */
export async function importServerDirectory(actor: SourceActor, registry: SourceRegistry, directory: string, sourceId: string, label: string, options: { dryRun?: boolean } = {}) {
  if (!actor.admin) throw new BridgeError('Импорт серверной папки выполняет руководитель.', 403);
  const scan = await scanServerDirectory(directory, defaultExclusions, { maxFiles: registry.limits.maxFiles, maxFileBytes: registry.limits.maxFileBytes });
  const preview = { files: scan.files.length, bytes: scan.files.reduce((s, f) => s + f.size, 0), skipped: scan.skipped.slice(0, 500) };
  if (options.dryRun) return { preview };
  if (!scan.files.length) throw new BridgeError('В папке нет файлов для импорта.');
  const upload = registry.createUpload(actor, sourceId, { idempotencyKey: 'legacy' + randomUUID().replaceAll('-', ''), label, totalFiles: scan.files.length, totalBytes: preview.bytes, exclusions: defaultExclusions });
  for (let page = 0; page * 1000 < scan.files.length; page++) {
    const entries = scan.files.slice(page * 1000, (page + 1) * 1000).map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 }));
    registry.putManifest(actor, sourceId, upload.id, { page, last: (page + 1) * 1000 >= scan.files.length, entries });
  }
  const byPath = new Map(scan.files.map(f => [f.path, f]));
  let cursor = -1;
  for (;;) {
    const status = registry.uploadStatus(actor, sourceId, upload.id, cursor);
    for (const file of status.files) {
      const local = byPath.get(file.path)!;
      const handle = await open(local.absolute);
      try {
        for (let part = 1; part <= file.partsTotal; part++) {
          if (file.partsReceived.includes(part)) continue;
          const length = part < file.partsTotal ? registry.limits.partBytes : file.size - (file.partsTotal - 1) * registry.limits.partBytes;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, (part - 1) * registry.limits.partBytes);
          await registry.putPart(actor, sourceId, upload.id, file.fileId, part, buffer);
        }
      } finally { await handle.close(); }
    }
    if (status.next === undefined) break;
    cursor = status.next;
  }
  const done = await registry.completeUpload(actor, sourceId, upload.id, 'legacy-complete-' + upload.id.slice(0, 8));
  return { preview, upload: done };
}
