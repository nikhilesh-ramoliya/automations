# naukri-search-jobs

Search Naukri for configured roles × geos, keep keyword matches, write `data/naukri/<runId>/jobs.json`.

```bash
export NAUKRI_MAX_JOBS=5
npm run jobs:run -- naukri-search-jobs --dry-run
```

Requires `npm run auth:naukri` first.
