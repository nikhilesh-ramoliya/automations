# Lead pipeline

Runs the full chain in one process (each step’s `run()`):

```
discover → dedupe → enrich (web-first) → tech-signals (website/careers) →
find-decision-makers → suppress → verify-contact → qualify → draft-outreach → export
```

Company intel prefers the **public web**; LinkedIn is secondary (see `LEAD_ENRICH_*`).

```powershell
$env:LEAD_MAX_COMPANIES="2"
npm run jobs:run -- lead-pipeline --dry-run
# or
npm run leads:pipeline -- --dry-run
```

Subset via env:

```powershell
$env:LEAD_PIPELINE_FROM="lead-qualify"
$env:LEAD_PIPELINE_TO="lead-export"
npm run jobs:run -- lead-pipeline --dry-run
```

Individual steps remain runnable with `npm run jobs:run -- <jobId>`.
