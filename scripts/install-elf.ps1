# Installs the opencode-elf plugin for OpenCode V2 on Windows.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-elf.ps1 -Tarball .\opencode-elf-0.7.0.tgz
#
# The tarball is produced on the build machine with `npm pack`.
# The plugin is installed under the OpenCode config directory, where OpenCode
# discovers global plugins automatically.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tarball,

    [string]$TargetDir = (Join-Path $env:USERPROFILE ".config\opencode\plugins\opencode-elf")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Tarball)) {
    throw "Tarball not found: $Tarball"
}
$tarballPath = (Resolve-Path $Tarball).Path

Write-Host "Installing opencode-elf from $tarballPath"
Write-Host "Target: $TargetDir"

# Extract into a temp directory first because npm tarballs contain a top-level "package/" folder.
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-elf-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    # Copy the tarball into the temp directory and use a relative name:
    # the tar shipped with Git Bash treats "X:\..." as a remote host.
    Copy-Item $tarballPath (Join-Path $tempDir "plugin.tgz")

    Push-Location $tempDir
    try {
        tar -xzf "plugin.tgz"
        if ($LASTEXITCODE -ne 0) {
            throw "tar failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path (Join-Path $tempDir "package"))) {
        throw "Unexpected tarball layout: no package/ folder inside $tarballPath"
    }

    if (Test-Path $TargetDir) {
        try {
            Remove-Item -Recurse -Force $TargetDir
        }
        catch {
            # Windows locks native addons (onnxruntime.dll) while OpenCode runs.
            # Fall back to replacing everything except node_modules.
            Write-Warning "Could not remove $TargetDir completely (files locked by a running OpenCode). Replacing package files only."
            Get-ChildItem -Path $TargetDir -Force |
                Where-Object { $_.Name -ne "node_modules" } |
                Remove-Item -Recurse -Force
        }
    }
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Copy-Item -Path (Join-Path $tempDir "package\*") -Destination $TargetDir -Recurse -Force

    Push-Location $TargetDir
    try {
        # devDependencies are omitted: the "prepare" script detects the missing
        # typescript and keeps the prebuilt dist/ from the tarball.
        npm install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "opencode-elf installed to $TargetDir"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Remove any 'opencode-elf' entry from the plugins array in your opencode.jsonc."
    Write-Host "     OpenCode auto-discovers plugins under ~/.config/opencode/plugins/."
    Write-Host "  2. Restart the OpenCode service: opencode service restart"
    Write-Host "  3. Verify: opencode plugin list"
    Write-Host ""
    Write-Host "First run downloads the embedding model (~90 MB) into the OpenCode cache."
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
