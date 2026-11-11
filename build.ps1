$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & npm.cmd ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Checks failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
finally { Pop-Location }
