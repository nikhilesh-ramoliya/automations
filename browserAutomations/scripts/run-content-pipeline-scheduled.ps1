# LinkedIn content engine — intended for Windows Task Scheduler (Mon/Thu 14:00).
# Live: generates drafts and publishes the top scored post (CONTENT_DO_PUBLISH=true).
# Requires: logged-in desktop session, prior `npm run auth:linkedin`, Node on PATH.
#
# Dry-run instead of publish:
#   $env:CONTENT_SCHEDULE_DRY_RUN = "true"
#
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
$logFile = Join-Path $logDir "scheduled-content-pipeline-$stamp.log"

# Sensible scheduled caps (one publish)
$env:CONTENT_MAX_TOPICS = if ($env:CONTENT_MAX_TOPICS) { $env:CONTENT_MAX_TOPICS } else { "4" }
$env:CONTENT_MAX_VARIATIONS = if ($env:CONTENT_MAX_VARIATIONS) { $env:CONTENT_MAX_VARIATIONS } else { "1" }
$env:CONTENT_USE_AI = if ($env:CONTENT_USE_AI) { $env:CONTENT_USE_AI } else { "true" }
# Prefer Cursor Agent for generation (set in User env or Task Scheduler):
#   CURSOR_API_KEY=...
# Optional: CONTENT_CURSOR_MODEL=composer-2.5

$env:HEADLESS = if ($env:HEADLESS) { $env:HEADLESS } else { "false" }
$env:CONTENT_COMPOSE_REVIEW_MS = if ($env:CONTENT_COMPOSE_REVIEW_MS) { $env:CONTENT_COMPOSE_REVIEW_MS } else { "5000" }

$dry = $env:CONTENT_SCHEDULE_DRY_RUN -eq "true" -or $env:CONTENT_SCHEDULE_DRY_RUN -eq "1"
if ($dry) {
  $env:CONTENT_DO_PUBLISH = "false"
  $modeFlag = "--dry-run"
  $modeLabel = "dry-run (type only, no Post click)"
} else {
  $env:CONTENT_DO_PUBLISH = "true"
  $modeFlag = "--no-dry-run"
  $modeLabel = "LIVE publish"
}

"[$stamp] Starting content pipeline ($modeLabel) from $Root" | Tee-Object -FilePath $logFile
"[$stamp] CONTENT_MAX_TOPICS=$($env:CONTENT_MAX_TOPICS) VARIATIONS=$($env:CONTENT_MAX_VARIATIONS)" |
  Tee-Object -FilePath $logFile -Append

& $npm run content:pipeline -- $modeFlag *>&1 | Tee-Object -FilePath $logFile -Append
$code = $LASTEXITCODE
"[$stamp] Exit code: $code" | Tee-Object -FilePath $logFile -Append
exit $code
