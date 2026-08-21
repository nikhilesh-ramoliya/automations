# referral-send-connect

**Not in the default pipeline.** After reviewing `targets.json`, send LinkedIn connection requests.

```bash
npm run jobs:run -- referral-send-connect --dry-run
npm run jobs:run -- referral-send-connect --no-dry-run
```

Writes `data/referral/<runId>/sent.json`.
