# Lead find decision makers

Order:

1. **Reuse LinkedIn harvest** from enrich (`linkedin.harvest.json`) — People already collected on company page
2. **Website** leadership/team crawl
3. **Company People tab** local title search (if still needed)
4. **Global LinkedIn people search** — **off by default** (`LEAD_PEOPLE_LINKEDIN_SEARCH=false`)

```powershell
$env:LEAD_RUN_ID="…"
npm run jobs:run -- lead-find-decision-makers --no-dry-run
```
