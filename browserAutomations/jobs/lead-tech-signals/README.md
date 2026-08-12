# Lead tech signals

Bounded **same-origin site crawl** from the company homepage: follows scored in-site
links (careers, engineering, about, products, blog, …), aggregates stack + buying
signals → `companies.tech.json`. Does not open LinkedIn.

Falls back to a small hardcoded path list (`/careers`, `/blog`, `/about`, …) only
when the crawl finds zero relevant links.

```powershell
npm run jobs:run -- lead-tech-signals --dry-run

# Re-run Step 4 for an existing enrich run:
$env:LEAD_RUN_ID="20260803-160353"
npm run jobs:run -- lead-tech-signals --no-dry-run
```

Env: `LEAD_TECH_CRAWL_MAX_PAGES` (default 8, includes homepage).
