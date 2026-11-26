/** Project library: shared contracts for the server and the browser. A library folder has exactly one current content. */
export const externalProviders = ['dropbox', 'google', 'yandex'] as const;
export type ExternalProvider = typeof externalProviders[number];
export const externalLabels = { dropbox: 'Dropbox', google: 'Google Drive', yandex: 'Яндекс Диск' };
export interface DriveAccount { id: string; provider: ExternalProvider; name: string; libraries: number }
export interface ExternalSelection { connection: string; folder: string }
export interface ExternalFolder { id: string; name: string }
export interface ExternalSummary { accountName?: string; provider: ExternalProvider; folder: string; checkedAt?: string; error?: string; syncing: boolean; preparingFiles?: number }
export type LibraryProfile = 'code' | 'documents';
export type LibraryClassification = 'shared' | 'restricted';
export type OutputPolicy = 'explanation_only' | 'excerpts_allowed';
/** Internal content states; users see only the current one. */
export type ContentState = 'preparing' | 'ready' | 'failed' | 'superseded' | 'cancelled';
export type OperationMode = 'replace' | 'add';
export type OperationStatus = 'open' | 'preparing' | 'complete' | 'unchanged' | 'cancelled' | 'expired' | 'failed';
export type UploadFileState = 'pending' | 'uploading' | 'verified' | 'reused' | 'failed';
export type ExtractionState = 'pending' | 'indexed' | 'limited' | 'unsupported_format' | 'unsupported_encoding' | 'failed' | 'timeout' | 'ocr_required';
export const libraryActions = ['manage', 'upload', 'connect', 'view_original', 'download_original', 'delete'] as const;
export type LibraryAction = typeof libraryActions[number];
export const actionLabels: Record<LibraryAction, string> = {
  manage: 'Управление', upload: 'Загрузка и обновление', connect: 'Подключение к проектам', view_original: 'Просмотр оригиналов', download_original: 'Скачивание оригиналов', delete: 'Удаление',
};
export interface Coverage { files: number; bytes: number; indexed: number; unsupported: number; errors: number; acceptedBy?: string }
export interface OperationSummary {
  id: string; folderId: string; mode: OperationMode; status: OperationStatus; expiresAt: string; reservedBytes: number;
  manifestPages: number; manifestComplete: boolean;
  files: { total: number; pending: number; uploading: number; verified: number; reused: number; failed: number };
  bytes: { total: number; transferred: number; reused: number };
  partBytes: number; failure?: string;
  /** Changes against the current content, known once the whole manifest is received. */
  diff?: { added: number; changed: number; removed: number };
  /** Processing of the prepared content (after completion). */
  processing?: { state: ContentState; coverage: Coverage; failure?: string };
}
export interface LibraryFolderSummary {
  external?: ExternalSummary;
  id: string; name: string; description: string; profile: LibraryProfile; classification: LibraryClassification; outputPolicy: OutputPolicy;
  active: boolean;
  quotaBytes: number; usedBytes: number; revision: number; createdAt: string;
  /** Date of the last successful update of the current content. */
  updatedAt?: string;
  current?: Coverage;
  /** Unfinished upload or processing; one per folder. */
  operation?: OperationSummary;
  /** The last update that failed processing and was not published; can be retried or accepted with partial coverage. */
  failed?: { stateId: string; coverage: Coverage; failure?: string };
  managers: { userId: string; actions: LibraryAction[] }[];
  projects: { id: string; name?: string }[];
  canManage: boolean; canUpload: boolean; canDelete: boolean;
}
export interface ManifestEntry { path: string; size: number; sha256: string }
export interface UploadFileStatus { fileId: string; path: string; size: number; sha256: string; state: UploadFileState; partsTotal: number; partsReceived: number[] }
export interface LibraryConnection {
  projectId: string; folderId: string; folderName: string; description: string; profile: LibraryProfile; classification: LibraryClassification;
  folderActive: boolean;
  outputPolicy: OutputPolicy; enabled: boolean; revision: number; current?: Coverage; updatedAt?: string; preparing: boolean; canManage: boolean;
}
export interface LibraryCell { folderId: string; profileId: string; granted: boolean; allowed: boolean; outputPolicy?: OutputPolicy; files?: number; reasons: string[] }
export interface ProjectLibraryView {
  projectId: string; connections: LibraryConnection[]; profiles: { id: string; name: string }[]; cells: LibraryCell[];
  /** Folders this manager may connect to the project. */
  available: { id: string; name: string }[];
}
export const libraryDefaults = {
  maxFiles: 50_000, maxFileBytes: 100 * 1024 * 1024, maxDepth: 64, maxPathLength: 1024, partBytes: 8 * 1024 * 1024,
  manifestPageEntries: 1000, defaultQuotaBytes: 20 * 1024 * 1024 * 1024, uploadTtlMs: 24 * 3600_000,
};
export const toolLimits = { treeEntries: 200, searchMatches: 20, readLines: 200, responseBytes: 32 * 1024, callsPerRun: 200, bytesPerRun: 4 * 1024 * 1024 };

/** Default exclusions; the full list is shown to the user and stored with the session. */
export const defaultExclusions = [
  '.git/', '.svn/', '.hg/', 'node_modules/', 'bin/', 'obj/', '.vs/', '.idea/', '__pycache__/', '.cache/', 'packages/',
  '.gradle/', '.pytest_cache/', '.mypy_cache/', '.next/', '.nuxt/', '.output/', 'dist/', 'build/', 'out/', 'target/', 'artifacts/', '.artifacts/', 'publish/', 'coverage/', 'TestResults/',
  '*.dll', '*.exe', '*.pdb', '*.so', '*.so.*', '*.dylib', '*.a', '*.lib', '*.o', '*.obj', '*.class', '*.pyc', '*.pyo', '*.wasm',
  '*.nupkg', '*.nupkg.sha512', '.nupkg.metadata', '.signature.p7s', '*.snupkg', '*.jar', '*.war', '*.ear', '*.whl', '*.msi', '*.msix', '*.appx', '*.deb', '*.rpm',
  '*.tsbuildinfo', '*.js.map', '*.mjs.map', '*.cjs.map', '*.css.map', '*.suo', '*.csproj.user', '*.vbproj.user',
  '*.tmp', '*.temp', '~$*', '*.swp', 'Thumbs.db', '.DS_Store',
  '.env', '.env.*', '*.pfx', '*.p12', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.kdbx',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.bmp', '*.ico', '*.webp', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  '*.fkpx', '*.br', '*.dump', '*.bak', '*.backup', '*.zip', '*.7z', '*.rar', '*.tar', '*.gz',
];

export type PathProblem = 'empty' | 'absolute' | 'drive' | 'dot' | 'empty_segment' | 'control' | 'backslash' | 'encoded_separator' | 'too_long' | 'too_deep' | 'reserved' | 'not_normalized';
/** Validates a client-provided relative path. Never apply the result as a filesystem path on the server. */
export function pathProblem(input: string, limits = { maxPathLength: libraryDefaults.maxPathLength, maxDepth: libraryDefaults.maxDepth }): PathProblem | undefined {
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

/** Profile for client documents: only system, temporary and key files are excluded; folder names are never a reason. */
export const documentExclusions = ['.git/', '.svn/', '*.tmp', '*.temp', '~$*', '*.swp', 'Thumbs.db', '.DS_Store', 'desktop.ini',
  '.env', '.env.*', '*.pfx', '*.p12', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.kdbx'];
export const profileExclusions = (profile: LibraryProfile) => profile === 'code' ? defaultExclusions : documentExclusions;
