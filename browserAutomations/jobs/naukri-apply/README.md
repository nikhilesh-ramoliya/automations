# naukri-apply

**Not in the default pipeline.** After reviewing the job list, apply one by one.

```bash
npm run jobs:run -- naukri-apply --dry-run
npm run jobs:run -- naukri-apply --no-dry-run
```

Skips company-website-only applies by default (`NAUKRI_SKIP_EXTERNAL_APPLY=true`).
Writes `data/naukri/<runId>/applied.json`.
