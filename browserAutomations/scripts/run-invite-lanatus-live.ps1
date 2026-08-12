# Live Lanatus LinkedIn "invite to follow" — intended for Windows Task Scheduler.
# Requires: logged-in desktop session, prior `npm run auth:linkedin`, Node on PATH or default install.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$npm = @(
  "${env:ProgramFiles}\nodejs\npm.cmd",
  "${env:ProgramFiles(x86)}\nodejs\npm.cmd",
  (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $npm) {
  throw "npm.cmd not found. Install Node.js or fix PATH for scheduled runs."
}

$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDir "scheduled-invite-lanatus-$stamp.log"

"[$stamp] Starting live invite job from $Root" | Tee-Object -FilePath $logFile
& $npm run jobs:run -- linkedin-invite-follow-lanatus --no-dry-run *>&1 | Tee-Object -FilePath $logFile -Append
$code = $LASTEXITCODE
"[$stamp] Exit code: $code" | Tee-Object -FilePath $logFile -Append
exit $code
