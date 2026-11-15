param(
    [Parameter(Mandatory)][string]$ZipPath,
    [ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$Sha256,
    [switch]$Build
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$zip = (Resolve-Path -LiteralPath $ZipPath).Path
$digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if (!$Sha256 -and (Test-Path -LiteralPath "$zip.sha256" -PathType Leaf)) {
    $Sha256 = ((Get-Content -LiteralPath "$zip.sha256" -TotalCount 1).Trim() -split '\s+')[0]
}
if ($Sha256 -and $digest -ne $Sha256) { throw 'ZIP SHA-256 does not match the supplied digest.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Join-Path $repo 'private/fastkore-cli-pilot'
[IO.Directory]::CreateDirectory($root) | Out-Null
$staged = Join-Path $root ('.import-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staged) | Out-Null
$files = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
$required = @('package-manifest.json','fastkore-cli','README-LINUX.md','app/FastkoreCLI.dll',
    'app/FastkoreCLI.runtimeconfig.json','Docs/FastkoreCLI-Agent-Guide.md','Docs/FastkoreCLI-Agent-Contract.md')
try {
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        if ($archive.Entries.Count -gt 10000) { throw 'Too many ZIP entries.' }
        $bytes = 0L
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name -notmatch '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*/?$' -or
                ($name.Split('/') | Where-Object { $_ -in '.', '..' -or $_.EndsWith('.') }) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Invalid ZIP entry: $name" }
            if ($name.EndsWith('/')) { continue }
            $bytes += $entry.Length
            if ($bytes -gt 512MB) { throw 'Unpacked package exceeds 512 MiB.' }
            $target = Join-Path $staged $name
            $files.Add($name, $target)
            [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        }
    } finally { $archive.Dispose() }
    if (!$files.ContainsKey('SHA256SUMS')) { throw 'SHA256SUMS is missing.' }
    $verified = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in Get-Content -LiteralPath $files['SHA256SUMS']) {
        if ($line -notmatch '^([A-Fa-f0-9]{64}) [ *](.+)$') { throw 'Invalid SHA256SUMS entry.' }
        $expected = $Matches[1]
        $name = $Matches[2]
        if (!$files.ContainsKey($name) -or !$verified.Add($name) -or
            (Get-FileHash -LiteralPath $files[$name] -Algorithm SHA256).Hash -ne $expected) { throw "Checksum verification failed: $name" }
    }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $digest) { throw 'ZIP changed while it was being imported.' }
    if ($verified.Contains('SHA256SUMS') -or $verified.Count -ne $files.Count - 1) { throw 'SHA256SUMS must cover all package files.' }
    foreach ($name in $required) { if (!$verified.Contains($name)) { throw "Required package file is missing: $name" } }
    $manifest = Get-Content -LiteralPath $files['package-manifest.json'] -Raw | ConvertFrom-Json
    $version = $manifest.productVersion
    if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $manifest.runtime -ne 'linux-x64' -or !$manifest.packageId) { throw 'Expected a versioned linux-x64 SSO package.' }
    $folder = Join-Path $root "$version-sso"
    $receipt = Join-Path $folder '.agent-platform-import.json'
    if (Test-Path -LiteralPath $folder) {
        if (!(Test-Path -LiteralPath $receipt -PathType Leaf) -or (Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).sha256 -ne $digest) {
            throw "A different package already occupies $folder. Publish a new version."
        }
        foreach ($name in $files.Keys) {
            $installed = Join-Path $folder $name
            if (!(Test-Path -LiteralPath $installed -PathType Leaf) -or
                (Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $files[$name]).Hash) {
                throw "Installed package differs from the verified archive: $name"
            }
        }
    } else {
        @{ version = $version; packageId = $manifest.packageId; sha256 = $digest } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staged '.agent-platform-import.json') -Encoding utf8
        Move-Item -LiteralPath $staged -Destination $folder
    }
    if ($Build) {
        $before = $env:BRIDGE_FASTKORE_CLI_PACKAGE_VERSION
        try {
            $env:BRIDGE_FASTKORE_CLI_PACKAGE_VERSION = $version
            & docker compose -p fastkore-cli -f (Join-Path $PSScriptRoot 'compose.fastkore-cli-pilot.yaml') build cli
            if ($LASTEXITCODE -ne 0) { throw 'CLI image build failed.' }
            $capabilities = & docker run --rm --network none --read-only --tmpfs '/tmp:rw,nosuid,nodev' `
                "fastkore-cli:$version-sso" fastkore-cli agent capabilities --json
            if ($LASTEXITCODE -ne 0) { throw 'Offline CLI capability check failed.' }
            $contract = ($capabilities -join "`n") | ConvertFrom-Json
            if (!$contract.success -or $contract.data.schema -ne 'fastkore-cli-capabilities/v1') { throw 'CLI did not return the expected capability catalog.' }
        } finally { $env:BRIDGE_FASTKORE_CLI_PACKAGE_VERSION = $before }
    }
    [pscustomobject]@{ Version = $version; PackageId = $manifest.packageId; Sha256 = $digest; Directory = $folder; ImageBuilt = [bool]$Build }
} finally {
    if (Test-Path -LiteralPath $staged) {
        $resolved = (Resolve-Path -LiteralPath $staged).Path
        $parent = (Resolve-Path -LiteralPath $root).Path
        if ((Split-Path -Parent $resolved) -eq $parent -and (Split-Path -Leaf $resolved) -match '^\.import-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
