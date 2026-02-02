# Clean build directories workaround for Windows file locking

Write-Host "Cleaning build directories..." -ForegroundColor Cyan

# Kill any running soundapp/electron instances
Get-Process | Where-Object {$_.ProcessName -like "*electron*" -or $_.ProcessName -like "*soundapp*"} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1

# Try direct delete first
try {
    Remove-Item "out" -Recurse -Force -ErrorAction Stop
    Write-Host "✓ Deleted out/" -ForegroundColor Green
} catch {
    Write-Host "! out/ is locked, moving instead..." -ForegroundColor Yellow
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    
    # Move it instead
    try {
        Move-Item "out" "out_old_$timestamp" -Force -ErrorAction Stop
        Write-Host "✓ Moved to out_old_$timestamp" -ForegroundColor Green
    } catch {
        Write-Host "✗ Failed to move. Manual cleanup required." -ForegroundColor Red
        Write-Host "  Close VS Code and try again, or reboot." -ForegroundColor Yellow
        exit 1
    }
}

# Clean webpack cache
if (Test-Path ".webpack") {
    Remove-Item ".webpack" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Deleted .webpack/" -ForegroundColor Green
}

Write-Host "`nReady to build!" -ForegroundColor Green
