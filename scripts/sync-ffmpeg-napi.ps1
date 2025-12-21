# Sync FFmpeg NAPI files from submodule to bin directories
# Run after making changes in libs/ffmpeg-napi-interface/

$ErrorActionPreference = "Stop"

$submodulePath = Join-Path $PSScriptRoot "..\libs\ffmpeg-napi-interface\lib"
$winBin = Join-Path $PSScriptRoot "..\bin\win_bin"
$linuxBin = Join-Path $PSScriptRoot "..\bin\linux_bin"

if (-not (Test-Path $submodulePath)) {
    Write-Host "ERROR: Submodule not found at $submodulePath" -ForegroundColor Red
    Write-Host "Run: git submodule update --init" -ForegroundColor Yellow
    exit 1
}

Write-Host "Syncing FFmpeg NAPI files from submodule..." -ForegroundColor Green

$files = @(
    "player.js",
    "ffmpeg-worklet-processor.js",
    "index.js"
)

foreach ($file in $files) {
    $src = Join-Path $submodulePath $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $winBin $file) -Force
        Copy-Item $src (Join-Path $linuxBin $file) -Force
        Write-Host "  Copied $file" -ForegroundColor DarkGray
    } else {
        Write-Host "  WARNING: $file not found in submodule" -ForegroundColor Yellow
    }
}

Write-Host "`nDone! Files synced to bin/win_bin/ and bin/linux_bin/" -ForegroundColor Green
Write-Host "Note: Native binaries (.node) are updated separately via update-napi-binaries.ps1" -ForegroundColor Gray
