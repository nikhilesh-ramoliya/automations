# Register Windows Task Scheduler: content pipeline Mon + Thu at 14:00 local time.
# Run once (as your user) from an elevated or normal PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\register-content-pipeline-schedule.ps1
#
# Remove:
#   schtasks /Delete /TN "Lanatus-ContentPipeline-MonThu" /F
#
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $Root "scripts\run-content-pipeline-scheduled.ps1"
if (-not (Test-Path $script)) {
  throw "Missing $script"
}

$taskName = "Lanatus-ContentPipeline-MonThu"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$tr = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$script`""

# WEEKLY Mon+Thu at 14:00 — runs only when you are logged on (headed LinkedIn).
& schtasks.exe /Create /F `
  /TN $taskName `
  /TR $tr `
  /SC WEEKLY `
  /D MON,THU `
  /ST 14:00 `
  /RL LIMITED `
  /IT

if ($LASTEXITCODE -ne 0) {
  throw "schtasks create failed (exit $LASTEXITCODE)"
}

Write-Host ""
Write-Host "Scheduled task created: $taskName"
Write-Host "  When:  Monday and Thursday at 14:00 (local)"
Write-Host "  Runs:  $script"
Write-Host "  Mode:  LIVE publish (set CONTENT_SCHEDULE_DRY_RUN=true in task env to dry-run)"
Write-Host "  Needs: logged-on desktop session + npm run auth:linkedin"
Write-Host ""
Write-Host "Verify:  schtasks /Query /TN `"$taskName`" /V /FO LIST"
Write-Host "Run now: schtasks /Run /TN `"$taskName`""
Write-Host "Delete:  schtasks /Delete /TN `"$taskName`" /F"
Write-Host ""
