# referral-search-jobs

Search LinkedIn Jobs for configured roles × geos, open each JD, keep postings that match any `REFERRAL_JD_KEYWORDS`.

Writes `data/referral/<runId>/jobs.json`.

```bash
export REFERRAL_MAX_JOBS=5
npm run jobs:run -- referral-search-jobs --dry-run
```

Defaults: Full Stack / MERN / React · Ahmedabad, Bengaluru, Pune.
