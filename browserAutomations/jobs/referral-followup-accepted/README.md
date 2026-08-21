# referral-followup-accepted

**Not in the default pipeline.** After connects from `referral-send-connect`, poll profiles and send the static referral DM when Message is available.

```bash
npm run jobs:run -- referral-followup-accepted --dry-run
npm run jobs:run -- referral-followup-accepted --no-dry-run
```

Writes `data/referral/<runId>/followup.json`.
