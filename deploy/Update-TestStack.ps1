param([string]$BuildContext)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker failed with exit code $LASTEXITCODE." }
}

$stack = @('compose', '-p', 'agentic-platformin',
    '-f', 'compose.yaml', '-f', 'compose.codex.yaml', '-f', 'compose.sso.yaml',
    '-f', 'compose.fastkore-cli-worker.yaml', '-f', 'compose.minio.yaml')
$cli = @('compose', '-p', 'fastkore-cli', '-f', 'deploy/compose.fastkore-cli-pilot.yaml')
$buildStack = $stack
if ($BuildContext) {
    $contextPath = (Resolve-Path -LiteralPath $BuildContext).Path
    if (!(Test-Path -LiteralPath (Join-Path $contextPath 'Dockerfile') -PathType Leaf)) { throw 'Build context has no Dockerfile.' }
    $overridePath = Join-Path (Get-Location) 'work/deploy-build-context.json'
    @{ services = @{ app = @{ build = @{ context = $contextPath } }; codex = @{ build = @{ context = $contextPath } } } } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $overridePath -Encoding utf8
    $buildStack = $stack + @('-f', $overridePath)
}
$previousTickets = $env:BRIDGE_FASTKORE_CLI_TICKETS
$appStopped = $false
try {
    Invoke-Docker info --format '{{.ServerVersion}}'
    $env:BRIDGE_FASTKORE_CLI_TICKETS = '1'
    Invoke-Docker @stack config --quiet
    Invoke-Docker @cli config --quiet
    Invoke-Docker @buildStack build app codex
    Invoke-Docker @cli build cli

    $activeJobs = @'
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('/data/state.sqlite', {readOnly:true});
const jobs = db.prepare('SELECT payload FROM runs').all().map(r=>JSON.parse(r.payload));
console.log(jobs.filter(r=>r.status==='running'||r.status==='queued').length);
db.close();
'@
    $active = Invoke-Docker @stack exec -T app node -e $activeJobs
    if ([string]$active -ne '0') {
        throw "There are active or queued jobs ($active). Run this update again after they finish."
    }

    Invoke-Docker volume create fastkore_cli_ticket_socket
    Invoke-Docker @stack stop --timeout 30 app
    $appStopped = $true
    Invoke-Docker @cli up -d --no-build --wait --wait-timeout 90 cli
    Invoke-Docker @stack up -d --no-build --wait --wait-timeout 120 app codex
    $appStopped = $false

    $verify = @'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FastkoreCli } from './dist/server/fastkore-cli.js';
const source = readFileSync('./dist/server/fastkore.js','utf8');
assert.match(source,/ticketRoles/);
assert.match(source,/maxTicketResponseBytes\s*=\s*64\s*\*\s*1024/);
assert.equal(process.env.BRIDGE_FASTKORE_CLI_TICKETS,'1');
const cli = new FastkoreCli(process.env.BRIDGE_FASTKORE_CLI_SOCKET);
const catalog = await cli.describe();
assert.equal(catalog.ok,true);
console.log(JSON.stringify({rolesSupported:true,ssoLimitBytes:65536,cliReady:true}));
'@
    Invoke-Docker @stack exec -T app node --input-type=module -e $verify
    Invoke-Docker @stack ps
    Invoke-Docker @cli ps
} finally {
    if ($appStopped) {
        Write-Warning 'Update failed after stopping the app. Attempting to start it again.'
        & docker @stack up -d --no-build app
    }
    if ($null -eq $previousTickets) { Remove-Item Env:BRIDGE_FASTKORE_CLI_TICKETS -ErrorAction SilentlyContinue }
    else { $env:BRIDGE_FASTKORE_CLI_TICKETS = $previousTickets }
}
