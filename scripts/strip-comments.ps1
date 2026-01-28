param(
    [string]$FilePath = "js\stage.js",
    [string]$BackupSuffix = ".backup"
)

$content = Get-Content $FilePath -Raw

# Backup original
Copy-Item $FilePath "$FilePath$BackupSuffix" -Force

# Section headers to preserve (exact match)
$sectionHeaders = @(
    '// Init',
    '// ###########################################################################',
    '// Controls',
    '// Keyboard',
    '// Window Management',
    '// Playback',
    '// Audio',
    '// UI'
)

# Process line by line
$lines = $content -split "`r?`n"
$cleaned = @()

foreach ($line in $lines) {
    # Preserve section headers
    $isSectionHeader = $false
    foreach ($header in $sectionHeaders) {
        if ($line.Trim() -eq $header -or $line.Trim() -eq ($header + ' ' + '#' * 50)) {
            $isSectionHeader = $true
            break
        }
    }
    
    if ($isSectionHeader) {
        $cleaned += $line
        continue
    }
    
    # Remove lines that are ONLY comments
    if ($line -match '^\s*//') {
        continue
    }
    
    if ($line -match '^\s*/\*' -and $line -match '\*/\s*$') {
        continue
    }
    
    # For lines with code, remove trailing comments
    # But be careful about strings containing //
    if ($line -match '//') {
        # Simple heuristic: if // appears after code (not at start), remove it
        # This is not perfect but safer than nothing
        if ($line -notmatch '^\s*//' -and $line -match '^(.+?)\s+//') {
            $cleaned += $Matches[1].TrimEnd()
            continue
        }
    }
    
    $cleaned += $line
}

# Remove multi-line comments /* ... */
$result = $cleaned -join "`n"
$result = $result -replace '/\*[\s\S]*?\*/', ''

# Remove consecutive blank lines (max 2)
$result = $result -replace '(\r?\n){3,}', "`n`n"

# Write back
Set-Content $FilePath $result -NoNewline

Write-Host "Comments stripped from $FilePath"
Write-Host "Backup saved as $FilePath$BackupSuffix"
Write-Host "Original lines: $($lines.Count)"
Write-Host "Cleaned lines: $(($result -split "`n").Count)"
