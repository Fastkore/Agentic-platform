param(
    [Parameter(Mandatory)] [string] $WhisperRoot,
    [int] $Port = 8766
)

$ErrorActionPreference = 'Stop'
$platformRoot = Split-Path -Parent $PSScriptRoot
$privateRoot = Join-Path $platformRoot 'private'
$tokenPath = Join-Path $privateRoot 'dictation\token'
$env:API_TOKEN = [IO.File]::ReadAllText($tokenPath).Trim()
if (!$env:API_TOKEN) { throw 'Dictation token is missing.' }

$env:STORAGE_DIR = Join-Path $privateRoot 'dictation-storage'
$env:PYTHONDONTWRITEBYTECODE = '1'
New-Item -ItemType Directory -Force -Path $env:STORAGE_DIR | Out-Null
Set-Location -LiteralPath $WhisperRoot
$python = Join-Path $WhisperRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Whisper Python environment is missing.' }
$ErrorActionPreference = 'Continue'
& $python -m uvicorn dictation_service:app --app-dir $PSScriptRoot --host 127.0.0.1 --port $Port --no-access-log *> (Join-Path $env:STORAGE_DIR 'service.log')
exit $LASTEXITCODE
