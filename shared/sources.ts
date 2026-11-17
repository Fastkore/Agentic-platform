/** Project sources: shared contracts for the server, browser and local upload utility. */
export type SourceKind = 'code' | 'documents' | 'prices' | 'mixed';
export type SourceClassification = 'shared' | 'restricted';
export type SourceOutputPolicy = 'explanation_only' | 'excerpts_allowed';
export type SnapshotState = 'uploading' | 'verifying' | 'indexing' | 'ready' | 'failed' | 'cancelled' | 'archived';
export type UploadState = 'open' | 'completing' | 'complete' | 'cancelled' | 'expired' | 'failed';
export type UploadFileState = 'pending' | 'uploading' | 'verified' | 'reused' | 'failed';
export type ExtractionState = 'pending' | 'indexed' | 'limited' | 'unsupported_format' | 'unsupported_encoding' | 'failed';
export const sourceActions = ['manage_source', 'upload_snapshot', 'manage_project_binding', 'use_for_analysis', 'view_original', 'download_original', 'delete_source'] as const;
export type SourceAction = typeof sourceActions[number];
/** Actions a source manager can be delegated. use_for_analysis is granted through project bindings only. */
export const delegableSourceActions: SourceAction[] = ['manage_source', 'upload_snapshot', 'manage_project_binding', 'view_original', 'download_original', 'delete_source'];

export interface SourceSummary {
  id: string; name: string; description: string; kind: SourceKind; classification: SourceClassification;
  outputPolicy: SourceOutputPolicy; quotaBytes: number; usedBytes: number; reservedBytes: number;
  policyRevision: number; createdAt: string; archivedAt?: string; managers: { userId: string; actions: SourceAction[] }[];
  snapshots: number; latestSnapshot?: SnapshotSummary; canManage: boolean; canUpload: boolean;
}
export interface SnapshotSummary {
  id: string; sourceId: string; label: string; createdBy: string; uploadedAt: string; validFrom?: string; validTo?: string;
  state: SnapshotState; totalFiles: number; totalBytes: number; indexedFiles: number; unsupportedFiles: number;
  extractionErrors: number; indexGeneration: number; coverageAcceptedBy?: string; metadataRevision: number;
  manifestHash?: string; failure?: string;
}
export interface ManifestEntry { path: string; size: number; sha256: string }
export interface UploadSummary {
  id: string; sourceId: string; snapshotId: string; state: UploadState; snapshotState: SnapshotState; expiresAt: string;
  reservedBytes: number; manifestPages: number; manifestComplete: boolean;
  files: { total: number; pending: number; uploading: number; verified: number; reused: number; failed: number };
  bytes: { total: number; transferred: number; reused: number };
  partBytes: number; failure?: string; unchanged?: boolean;
}
export interface UploadFileStatus { fileId: string; path: string; size: number; sha256: string; state: UploadFileState; partsTotal: number; partsReceived: number[] }

export type BindingSelector = 'pinned' | 'effective_date';
export interface ProjectSourceBinding {
  id: string; projectId: string; sourceId: string; selector: BindingSelector; snapshotId?: string; approvedSnapshotIds: string[];
  allowedActions: SourceAction[]; outputPolicy: SourceOutputPolicy; enabled: boolean; revision: number;
}
export interface SourceGrant { projectId: string; profileId: string; bindingId: string; enabled: boolean }
export interface SourceBundle {
  id: string; projectId: string; label: string; revision: number; state: 'active' | 'archived';
  items: { bindingId: string; snapshotId: string }[]; createdBy: string; createdAt: string;
}
export interface ProjectSourceSettings { projectId: string; businessTimeZone: string; currentDateRule: boolean; revision: number }
export interface MatrixCell { bindingId: string; profileId: string; granted: boolean; allowed: boolean; outputPolicy?: SourceOutputPolicy; reasons: string[] }
export interface SourceMatrix {
  projectId: string; bindings: (ProjectSourceBinding & { sourceName: string; kind: SourceKind; selection: string })[];
  profiles: { id: string; name: string }[]; cells: MatrixCell[]; activeBundle?: SourceBundle; selectionLabel: string;
}
export interface SourceCitation { sourceId: string; sourceName: string; snapshotId: string; snapshotLabel: string; path: string; startLine?: number; endLine?: number }

export const sourceDefaults = {
  maxFiles: 50_000, maxFileBytes: 100 * 1024 * 1024, maxDepth: 64, maxPathLength: 1024, partBytes: 8 * 1024 * 1024,
  manifestPageEntries: 1000, defaultQuotaBytes: 20 * 1024 * 1024 * 1024, uploadTtlMs: 24 * 3600_000,
};
export const toolLimits = { treeEntries: 200, searchMatches: 20, readLines: 200, responseBytes: 32 * 1024, callsPerRun: 200, bytesPerRun: 4 * 1024 * 1024 };

/** Default exclusions; the full list is shown to the user and stored with the session. */
export const defaultExclusions = [
  '.git/', '.svn/', '.hg/', 'node_modules/', 'bin/', 'obj/', '.vs/', '.idea/', '__pycache__/', '.cache/', 'packages/',
  '.gradle/', '.pytest_cache/', '.mypy_cache/', '.next/', '.nuxt/', '.output/', 'dist/', 'build/', 'out/', 'target/', 'artifacts/', 'coverage/', 'TestResults/',
  '*.dll', '*.exe', '*.pdb', '*.so', '*.so.*', '*.dylib', '*.a', '*.lib', '*.o', '*.obj', '*.class', '*.pyc', '*.pyo', '*.wasm',
  '*.nupkg', '*.nupkg.sha512', '.nupkg.metadata', '.signature.p7s', '*.snupkg', '*.jar', '*.war', '*.ear', '*.whl', '*.msi', '*.msix', '*.appx', '*.deb', '*.rpm',
  '*.tsbuildinfo', '*.js.map', '*.mjs.map', '*.cjs.map', '*.css.map', '*.suo', '*.csproj.user', '*.vbproj.user',
  '*.tmp', '*.temp', '~$*', '*.swp', 'Thumbs.db', '.DS_Store',
  '.env', '.env.*', '*.pfx', '*.p12', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.kdbx',
  '*.bak', '*.backup', '*.zip', '*.7z', '*.rar', '*.tar', '*.gz',
];

export type PathProblem = 'empty' | 'absolute' | 'drive' | 'dot' | 'empty_segment' | 'control' | 'backslash' | 'encoded_separator' | 'too_long' | 'too_deep' | 'reserved' | 'not_normalized';
/** Validates a client-provided relative path. Never apply the result as a filesystem path on the server. */
export function pathProblem(input: string, limits = { maxPathLength: sourceDefaults.maxPathLength, maxDepth: sourceDefaults.maxDepth }): PathProblem | undefined {
  if (typeof input !== 'string' || !input) return 'empty';
  if (input.length > limits.maxPathLength) return 'too_long';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) return 'control';
  if (input.includes('\\')) return 'backslash';
  if (/%2f|%5c|%00/i.test(input) || /[∕⧸／＼]/.test(input)) return 'encoded_separator';
  if (input.startsWith('/')) return 'absolute';
  if (/^[a-zA-Z]:/.test(input)) return 'drive';
  if (input.normalize('NFC') !== input) return 'not_normalized';
  const segments = input.split('/');
  if (segments.length > limits.maxDepth) return 'too_deep';
  for (const segment of segments) {
    if (!segment) return 'empty_segment';
    if (segment === '.' || segment === '..') return 'dot';
    if (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) return 'reserved';
  }
  return undefined;
}
/** Key used to reject case/normalization collisions across platforms. */
export function pathKey(input: string) { return input.normalize('NFC').toLocaleLowerCase('en-US'); }

/** Glob-like exclusion: "dir/" matches a directory at any depth; "*.ext" and "name" match a file name. */
export function excluded(path: string, rules: readonly string[]) {
  const segments = path.split('/');
  const name = segments.at(-1)!;
  for (const rule of rules) {
    if (rule.endsWith('/')) { const dir = rule.slice(0, -1).toLowerCase(); if (segments.slice(0, -1).some(s => s.toLowerCase() === dir)) return rule; continue; }
    const pattern = new RegExp('^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    if (rule.includes('/') ? pattern.test(path) : pattern.test(name)) return rule;
  }
  return undefined;
}

/** Heuristic secret detector for preview. It never claims complete detection. */
export function suspiciousSecret(text: string) {
  const patterns: [string, RegExp][] = [
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
    ['token', /\b(?:ghp|gho|github_pat|glpat|xox[bpas])[-_][A-Za-z0-9_]{16,}/],
    ['api_key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ['password_assignment', /(?:password|passwd|pwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
    ['connection_string', /(?:Password|Pwd)\s*=\s*[^;"'\s]{6,}\s*;/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([id]) => id);
}

/** Interval [validFrom, validTo) in YYYY-MM-DD; returns the selection result without guessing. */
export function selectByDate<T extends { id: string; validFrom?: string; validTo?: string }>(items: T[], date: string):
  { kind: 'one'; item: T } | { kind: 'none' } | { kind: 'conflict'; items: T[] } | { kind: 'invalid' } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { kind: 'invalid' };
  const matching = items.filter(item => item.validFrom && item.validFrom <= date && (!item.validTo || date < item.validTo));
  if (!matching.length) return { kind: 'none' };
  if (matching.length > 1) return { kind: 'conflict', items: matching };
  return { kind: 'one', item: matching[0] };
}
/** Overlaps among periods of the given snapshots; used to warn managers before approval. */
export function periodConflicts<T extends { id: string; validFrom?: string; validTo?: string }>(items: T[]) {
  const dated = items.filter(i => i.validFrom).sort((a, b) => a.validFrom!.localeCompare(b.validFrom!));
  const conflicts: [string, string][] = [];
  for (let i = 0; i < dated.length; i++) for (let j = i + 1; j < dated.length; j++) {
    const a = dated[i], b = dated[j];
    if (!a.validTo || b.validFrom! < a.validTo) conflicts.push([a.id, b.id]);
  }
  return conflicts;
}
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
/** Business date in a project time zone, e.g. Europe/Moscow. */
export function businessDate(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
