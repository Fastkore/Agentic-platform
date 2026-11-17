# Stand verification of project sources on the Docker test stack (B7, E6, F3).
# Run from the repository root on the Docker host:  powershell -ExecutionPolicy Bypass -File deploy/Test-ProjectSources.ps1 [-SkipUpdate]
# Writes work/project-sources-agent/stand-report.json. Prints no secrets.
param([switch]$SkipUpdate)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$project = 'agentic-platformin'
$stack = @('compose', '-p', $project, '-f', 'compose.yaml', '-f', 'compose.codex.yaml', '-f', 'compose.sso.yaml',
    '-f', 'compose.fastkore-cli-worker.yaml', '-f', 'compose.minio.yaml', '-f', 'compose.sources.yaml')
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Docker failed with exit code $LASTEXITCODE." } }
function Capture-Docker { $out = & docker @args 2>&1; [pscustomobject]@{ code = $LASTEXITCODE; out = ($out | Out-String).Trim() } }
$report = [ordered]@{ startedAt = (Get-Date).ToString('o'); host = $env:COMPUTERNAME }
New-Item -ItemType Directory -Force -Path 'work/project-sources-agent' | Out-Null

# 1. Deploy the current tree (tests run inside the image build) with source storage enabled.
if (!$SkipUpdate) {
    & powershell -ExecutionPolicy Bypass -File deploy/Update-TestStack.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Update-TestStack.ps1 failed.' }
}
Invoke-Docker @stack up -d --no-build --wait --wait-timeout 120 app

# 2. Storage from the platform container: bucket check and a probe object (write, size, read back, delete).
$probe = @'
import { sourceStorageFromEnv, blobKey } from './dist/server/sources/blob-store.js';
const s = sourceStorageFromEnv(process.env);
if (!s.store) { console.log(JSON.stringify({ ok: false, problem: s.problem })); process.exit(0); }
await s.store.check();
const key = blobKey('src_standprobe', 'b_' + Date.now());
const body = Buffer.from('stand probe ' + new Date().toISOString());
await s.store.put(key, body);
const head = await s.store.head(key);
let read = ''; for await (const c of await s.store.stream(key)) read += c;
await s.store.delete(key);
console.log(JSON.stringify({ ok: head?.size === body.length && read === body.toString(), kind: s.store.kind, bucket: s.bucket }));
'@
$report.storage = (Capture-Docker @stack exec -T app node --input-type=module -e $probe).out

# 3. S3 integration test against the stack's MinIO, from a disposable container on the internal storage network.
$network = "${project}_file_storage"
Invoke-Docker volume create agentic-sources-test-modules | Out-Null
$src = (Get-Location).Path
Invoke-Docker run --rm -v "${src}:/src:ro" -v agentic-sources-test-modules:/w/node_modules node:24.19.0-bookworm-slim sh -c `
    "cd /src && tar cf - --exclude=node_modules --exclude=data --exclude=work --exclude=private --exclude='*.zip' . | (mkdir -p /w && cd /w && tar xf -) && cd /w && npm ci --no-audit --no-fund >/dev/null && echo modules-ready"
$s3 = Capture-Docker run --rm --network $network -v "${src}:/src:ro" -v agentic-sources-test-modules:/w/node_modules `
    -v "${src}/private/minio-password:/run/minio-password:ro" -e BRIDGE_SOURCES_TEST_S3_ENDPOINT=http://minio:9000 -e BRIDGE_SOURCES_TEST_S3_ACCESS_KEY=agentic-platform `
    node:24.19.0-bookworm-slim sh -c "cd /src && tar cf - --exclude=node_modules --exclude=data --exclude=work --exclude=private --exclude='*.zip' . | (mkdir -p /w && cd /w && tar xf -) && cd /w && BRIDGE_SOURCES_TEST_S3_SECRET_KEY=`$(cat /run/minio-password) npx tsx --test tests/sources-s3.test.ts 2>&1 | grep -E '^# (tests|pass|fail|skipped)|^not ok'"
$report.minioIntegration = $s3.out

# 4. Executor isolation (E6): no storage keys, no route to MinIO, no source database, read-only root file system.
$iso = @'
const dns = require('node:dns');
const fs = require('node:fs');
const names = Object.keys(process.env).filter(k => /^(BRIDGE_SOURCES_|BRIDGE_S3_|MINIO_)/.test(k));
const ro = (() => { try { fs.writeFileSync('/isolation-probe', 'x'); return false; } catch { return true; } })();
dns.lookup('minio', error => {
  const net = require('node:net');
  const socket = net.connect({ host: '192.168.2.110', port: 9000, timeout: 3000 });
  const done = hostReachable => console.log(JSON.stringify({ storageEnvNames: names, minioResolvable: !error, sourcesDb: fs.existsSync('/data/sources.sqlite'),
    dataDir: fs.existsSync('/data'), readOnlyRoot: ro, hostMinioReachable: hostReachable, user: process.getuid() }));
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('timeout', () => { socket.destroy(); done(false); });
  socket.once('error', () => done(false));
});
'@
$report.executorIsolation = (Capture-Docker @stack exec -T codex node -e $iso).out
$report.executorNetworks = (Capture-Docker inspect -f '{{json .NetworkSettings.Networks}}' "${project}-codex-1").out -replace '"IPAddress":"[^"]*"', '"IPAddress":"…"'

# 5. Consistent backup and restore verification inside the platform container.
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$report.backup = (Capture-Docker @stack exec -T app node dist/server/sources/maintenance-cli.js backup --data /data --target "/tmp/sources-backup-$stamp").out
$report.verifyBackupCopy = (Capture-Docker @stack exec -T app node dist/server/sources/maintenance-cli.js verify --data "/tmp/sources-backup-$stamp" --deep).out
$report.resume = (Capture-Docker @stack exec -T app node dist/server/sources/maintenance-cli.js resume --data /data).out
Invoke-Docker @stack exec -T app sh -c "rm -rf /tmp/sources-backup-$stamp" | Out-Null

$report.finishedAt = (Get-Date).ToString('o')
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 'work/project-sources-agent/stand-report.json'
$report | ConvertTo-Json -Depth 6
