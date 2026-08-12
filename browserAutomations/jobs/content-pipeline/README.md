# content-pipeline

Orchestrates the LinkedIn **content engine** (offline, never publishes):

```
content-research-topics → content-generate-posts → content-compose-draft
```

Compose (last step) opens LinkedIn, types the top draft, and **does not click Post** in dry-run.
Skip compose with:

```powershell
$env:CONTENT_PIPELINE_TO="content-generate-posts"
npm run content:pipeline -- --dry-run
```

## Run

```powershell
$env:CONTENT_MAX_TOPICS="4"
$env:CONTENT_MAX_VARIATIONS="3"
npm run content:pipeline -- --dry-run
```

Slice steps:

```powershell
$env:CONTENT_PIPELINE_FROM="content-generate-posts"
npm run content:pipeline -- --dry-run
```

## Scheduling

Windows Task Scheduler — **Monday & Thursday 14:00** local:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-content-pipeline-schedule.ps1
```

Task name: `Lanatus-ContentPipeline-MonThu`  
Runner: `scripts/run-content-pipeline-scheduled.ps1` (live publish; logs under `logs/scheduled-content-pipeline-*.log`)

```powershell
schtasks /Query /TN "Lanatus-ContentPipeline-MonThu" /V /FO LIST
schtasks /Run /TN "Lanatus-ContentPipeline-MonThu"   # test now
schtasks /Delete /TN "Lanatus-ContentPipeline-MonThu" /F
```

Dry-run schedule: set task env `CONTENT_SCHEDULE_DRY_RUN=true` (or edit the runner script).
Requires a logged-on desktop session (`/IT`) for headed LinkedIn.

## Related

- Engage / react on others' posts: `visibility-pipeline` (separate)
- Simple template drafts inside visibility: `visibility-draft-posts`
