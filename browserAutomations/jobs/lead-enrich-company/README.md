# Lead enrich company

**Default path:** one LinkedIn session per company harvest, then crawl the website.

1. **LinkedIn harvest** (single session): **About** (`/about/` + tab click) → website URL → **People** (local title search on company People tab) → **Posts** (tech/buying signals)
2. Persist `linkedin.harvest.json` + seed `people.json` when people found
3. Crawl company website for page intel / tech keywords
4. Web search stays **off** by default (`LEAD_SKIP_WEB_SEARCH=true`)

```powershell
npm run jobs:run -- lead-enrich-company --no-dry-run
```

Env: `LEAD_SKIP_WEB_SEARCH` (default true), `LEAD_ENRICH_LINKEDIN` / `LEAD_ENRICH_LINKEDIN_WEBSITE`, `LEAD_MAX_PEOPLE_PER_COMPANY`.
