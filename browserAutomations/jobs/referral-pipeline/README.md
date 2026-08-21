# referral-pipeline

Orchestrates:

```
referral-search-jobs → referral-find-people → referral-draft → referral-export
```

Connect + follow-up are **not** included — review `targets.json` first.

```bash
export REFERRAL_MAX_JOBS=5
npm run referral:pipeline -- --dry-run
# or
npm run jobs:run -- referral-pipeline --dry-run
```

Artifacts: `data/referral/<runId>/` and `output/referral/<runId>/`.
