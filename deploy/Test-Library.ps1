# Stand verification of the project library (LIBRARY-SPEC 2.1). Run on the Docker host from the repository root:
#   powershell -ExecutionPolicy Bypass -File deploy/Test-Library.ps1            # checks only; the running stack is not changed
#   powershell -ExecutionPolicy Bypass -File deploy/Test-Library.ps1 -Update    # first deploys the working tree with Update-TestStack.ps1
# Writes work/library-stand/stand-report.json. Prints no secrets. Exit code 1 when any check fails.
param([switch]$Update)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$project = 'agentic-platformin'
$stack = @('compose', '-p', $project, '-f', 'compose.yaml', '-f', 'compose.codex.yaml', '-f', 'compose.sso.yaml',
    '-f', 'compose.fastkore-cli-worker.yaml', '-f', 'compose.minio.yaml', '-f', 'compose.library.yaml')
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Docker failed with exit code $LASTEXITCODE." } }
function Capture-Docker { $out = & docker @args 2>&1; [pscustomobject]@{ code = $LASTEXITCODE; out = ($out | Out-String).Trim() } }
function Invoke-Probe($service, $mode, $source) {
    $out = $source | & docker @stack exec -T $service node "--input-type=$mode" - 2>&1
    [pscustomobject]@{ code = $LASTEXITCODE; out = ($out | Out-String).Trim() }
}
$report = [ordered]@{ startedAt = (Get-Date).ToString('o'); host = $env:COMPUTERNAME; checks = [ordered]@{} }
$failed = @()
function Record($name, $ok, $detail) { $report.checks[$name] = [ordered]@{ ok = [bool]$ok; detail = $detail }; if (!$ok) { $script:failed += $name } }
New-Item -ItemType Directory -Force -Path 'work/library-stand' | Out-Null

# 0. Optional deployment. Without -Update the running containers are not touched.
if ($Update) {
    & powershell -ExecutionPolicy Bypass -File deploy/Update-TestStack.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Update-TestStack.ps1 failed.' }
}

# 1. Library storage from the platform container: bucket, write, size, read back, delete.
$probe = @'
import { libraryStorageFromEnv, blobKey } from './dist/server/library/blob-store.js';
const s = libraryStorageFromEnv(process.env);
if (!s.store) { console.log(JSON.stringify({ ok: false, problem: s.problem })); process.exit(0); }
await s.store.check();
const key = blobKey('lib_standprobe', 'b_' + Date.now());
const body = Buffer.from('stand probe ' + new Date().toISOString());
await s.store.put(key, body);
const head = await s.store.head(key);
let read = ''; for await (const c of await s.store.stream(key)) read += c;
await s.store.delete(key);
console.log(JSON.stringify({ ok: head?.size === body.length && read === body.toString(), kind: s.store.kind, bucket: s.bucket }));
'@
$storage = Invoke-Probe app module $probe
Record 'storage' ($storage.code -eq 0 -and $storage.out -match '"ok":true' -and $storage.out -match '"kind":"s3"') $storage.out

# 2. Library database and retired subsystem inside the platform container.
$db = @'
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const out = { library: fs.existsSync('/data/library.sqlite'), oldSources: fs.existsSync('/data/sources.sqlite'), oldModule: fs.existsSync('dist/server/sources') };
if (out.library) { const d = new DatabaseSync('/data/library.sqlite', { readOnly: true }); out.schema = d.prepare('PRAGMA user_version').get().user_version;
  out.folders = d.prepare('SELECT count(*) n FROM folders WHERE deleted_at IS NULL').get().n; out.imports = d.prepare('SELECT key FROM imports').all().map(r => r.key); d.close(); }
console.log(JSON.stringify(out));
'@
$database = Invoke-Probe app commonjs $db
Record 'database' ($database.code -eq 0 -and $database.out -match '"library":true' -and $database.out -match '"schema":2' -and $database.out -match '"oldModule":false') $database.out

# 3. Executor boundary: library tools allowed by the worker, no storage keys, no route to MinIO, no library database, read-only root.
$iso = @'
const dns = require('node:dns');
const fs = require('node:fs');
const names = Object.keys(process.env).filter(k => /^(BRIDGE_LIBRARY_|BRIDGE_S3_|MINIO_)/.test(k));
let worker = '';
try { worker = fs.readFileSync('dist/server/codex-worker.js', 'utf8'); } catch {}
const ro = (() => { try { fs.writeFileSync('/isolation-probe', 'x'); return false; } catch { return true; } })();
dns.lookup('minio', error => console.log(JSON.stringify({ libraryToolsAllowed: worker.includes('library_(?:list|tree|search|read)'), retiredToolsAllowed: worker.includes('project_files_'),
  storageEnvNames: names, minioResolvable: !error, libraryDb: fs.existsSync('/data/library.sqlite'), readOnlyRoot: ro })));
'@
$executor = Invoke-Probe codex commonjs $iso
Record 'executor' ($executor.code -eq 0 -and $executor.out -match '"libraryToolsAllowed":true' -and $executor.out -match '"retiredToolsAllowed":false' -and
    $executor.out -match '"storageEnvNames":\[\]' -and $executor.out -match '"minioResolvable":false' -and $executor.out -match '"libraryDb":false' -and $executor.out -match '"readOnlyRoot":true') $executor.out
$networks = Capture-Docker inspect -f '{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}' "${project}-codex-1"
Record 'executorNetworks' ($networks.code -eq 0 -and $networks.out -and $networks.out -notmatch 'file_storage') $networks.out

# 4. S3 integration tests against the stack's MinIO, from a disposable container on the storage network (test buckets are separate).
$network = "${project}_file_storage"
$testImage = "${project}-library-test:local"
Invoke-Docker build --target build -t $testImage .
$secretPath = (Resolve-Path -LiteralPath 'private/minio-password').Path
$s3 = Capture-Docker run --rm --network $network `
    --mount "type=bind,source=$secretPath,target=/run/minio-password,readonly" `
    -e BRIDGE_LIBRARY_TEST_S3_ENDPOINT=http://minio:9000 -e BRIDGE_LIBRARY_TEST_S3_ACCESS_KEY=agentic-platform `
    $testImage sh -c 'BRIDGE_LIBRARY_TEST_S3_SECRET_KEY=$(cat /run/minio-password) exec ./node_modules/.bin/tsx --test --test-reporter=tap tests/library-s3.test.ts'
Record 'minioIntegration' ($s3.code -eq 0 -and $s3.out -match '(?m)^# pass 2\s*$' -and $s3.out -match '(?m)^# fail 0\s*$' -and $s3.out -match '(?m)^# skipped 0\s*$') $s3.out

# 5. Health of the running stack.
$ps = Capture-Docker @stack ps --format '{{.Service}} {{.State}} {{.Health}}'
Record 'stack' ($ps.code -eq 0 -and $ps.out -match 'app running healthy' -and $ps.out -match 'codex running') $ps.out

$report.finishedAt = (Get-Date).ToString('o')
$report.failed = $failed
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 'work/library-stand/stand-report.json'
$report | ConvertTo-Json -Depth 6
if ($failed.Count) { Write-Host ('FAILED: ' + ($failed -join ', ')); exit 1 }
Write-Host 'All stand checks passed.'
