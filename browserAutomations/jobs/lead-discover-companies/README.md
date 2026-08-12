# Lead discover companies

Finds companies that may need software/IT consulting (LinkedIn company search primary).

Applies genuineness + ICP quality gates. Stores `websiteSearchHint` (`"{name}" official site`) so **enrich** can resolve public websites web-first.

**Seeds are off by default.** If LinkedIn returns 0 companies, the job fails with a clear error. Set `LEAD_ALLOW_SEEDS=true` only for local smoke tests — never for live outreach.

```powershell
$env:LEAD_MAX_COMPANIES="2"
npm run jobs:run -- lead-discover-companies --dry-run
```

Creates `data/leads/<runId>/companies.json` + `meta.json`. Sets `LEAD_RUN_ID` for later steps when unset.
