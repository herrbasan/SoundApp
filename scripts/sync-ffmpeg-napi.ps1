# Sync FFmpeg NAPI files from submodule to bin directories
# Run after making changes in libs/ffmpeg-napi-interface/

param(
    [switch]$IncludeNative
)

$ErrorActionPreference = "Stop"

$isWindows = ($env:OS -eq "Windows_NT") -or ([System.Environment]::OSVersion.Platform -eq "Win32NT")

function Copy-SyncFile {
    param(
        [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][string]$Destination,
        [Parameter(Mandatory=$true)][string]$Label
    )

    try {
        Copy-Item $Source $Destination -Force -ErrorAction Stop
        Write-Host "  Copied $Label" -ForegroundColor DarkGray
        return $true
    } catch [System.IO.IOException] {
        Write-Host "  WARNING: Could not copy $Label (file in use). Close SoundApp/Electron and rerun sync." -ForegroundColor Yellow
        return $false
    }
}

$submoduleLibPath = Join-Path $PSScriptRoot "..\libs\ffmpeg-napi-interface\lib"
$submoduleBuildReleasePath = Join-Path $PSScriptRoot "..\libs\ffmpeg-napi-interface\build\Release"
$winBin = Join-Path $PSScriptRoot "..\bin\win_bin"
$linuxBin = Join-Path $PSScriptRoot "..\bin\linux_bin"

if (-not (Test-Path $submoduleLibPath)) {
    Write-Host "ERROR: Submodule not found at $submoduleLibPath" -ForegroundColor Red
    Write-Host "Run: git submodule update --init" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $winBin)) {
    Write-Host "ERROR: bin directory not found at $winBin" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $linuxBin)) {
    Write-Host "ERROR: bin directory not found at $linuxBin" -ForegroundColor Red
    exit 1
}

Write-Host "Syncing FFmpeg NAPI files from submodule..." -ForegroundColor Green


# Copy all runtime JS files from the submodule lib/ folder.
# (Historically we had additional filenames here; using discovery avoids the script going stale.)
$files = @(Get-ChildItem -Path $submoduleLibPath -File | Where-Object { $_.Extension -eq ".js" } | Select-Object -ExpandProperty Name)

if (-not $files -or $files.Count -eq 0) {
    Write-Host "ERROR: No .js files found in submodule lib/ at $submoduleLibPath" -ForegroundColor Red
    exit 1
}

foreach ($file in $files) {
    $src = Join-Path $submoduleLibPath $file
    if (Test-Path $src) {
        Copy-SyncFile -Source $src -Destination (Join-Path $winBin $file) -Label "$file (win_bin)" | Out-Null
        Copy-SyncFile -Source $src -Destination (Join-Path $linuxBin $file) -Label "$file (linux_bin)" | Out-Null
    } else {
        Write-Host "  WARNING: $file not found in submodule" -ForegroundColor Yellow
    }
}

if ($IncludeNative) {
    if ($isWindows) {
        Write-Host "`nSyncing native addon + DLLs (Windows)..." -ForegroundColor Green

        if (-not (Test-Path $submoduleBuildReleasePath)) {
            Write-Host "ERROR: Build output not found at $submoduleBuildReleasePath" -ForegroundColor Red
            Write-Host "Build the addon first (from libs/ffmpeg-napi-interface): npm run build" -ForegroundColor Yellow
            exit 1
        }

        $nativeFiles = @(
            "ffmpeg_napi.node",
            "avcodec-62.dll",
            "avformat-62.dll",
            "avutil-60.dll",
            "swresample-6.dll"
        )

        foreach ($file in $nativeFiles) {
            $src = Join-Path $submoduleBuildReleasePath $file
            if (Test-Path $src) {
                Copy-SyncFile -Source $src -Destination (Join-Path $winBin $file) -Label $file | Out-Null
            } else {
                Write-Host "  WARNING: $file not found in build output" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "`nSyncing native addon (non-Windows)..." -ForegroundColor Green

        if (-not (Test-Path $submoduleBuildReleasePath)) {
            Write-Host "ERROR: Build output not found at $submoduleBuildReleasePath" -ForegroundColor Red
            Write-Host "Build the addon first (from libs/ffmpeg-napi-interface): npm run build" -ForegroundColor Yellow
            exit 1
        }

        $srcNode = Join-Path $submoduleBuildReleasePath "ffmpeg_napi.node"
        if (Test-Path $srcNode) {
            Copy-SyncFile -Source $srcNode -Destination (Join-Path $linuxBin "ffmpeg_napi.node") -Label "ffmpeg_napi.node" | Out-Null
        } else {
            Write-Host "  WARNING: ffmpeg_napi.node not found in build output" -ForegroundColor Yellow
        }
    }
}

Write-Host "`nDone!" -ForegroundColor Green
Write-Host "JS synced to bin/win_bin/ and bin/linux_bin/." -ForegroundColor Gray
if ($IncludeNative) {
    if ($isWindows) {
        Write-Host "Native addon synced to bin/win_bin/." -ForegroundColor Gray
    } else {
        Write-Host "Native addon synced to bin/linux_bin/." -ForegroundColor Gray
    }
} else {
    Write-Host "Native binaries (.node/.dll) not synced (run with -IncludeNative to copy build artifacts)." -ForegroundColor Gray
}
