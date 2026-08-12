# Follow up accepted LinkedIn connects

**Not part of the default pipeline.** Run after `lead-send-outreach` has sent connection requests.

## What it does

1. Loads `leads.sent.json` rows with `action=linkedin_connect`, `ok=true`, and `detail` in `connected` | `note_sent` | `pending`.
2. Skips leads already messaged live (`status=messaged` && `dryRun=false` in `leads.followup.json`).
3. Opens each profile (shared LinkedIn session + safety caps).
4. Detects state:
   - **Pending** → leave / record pending (or `skipped` / `not_accepted` if `LEAD_FOLLOWUP_ONLY_ACCEPTED=true`)
   - **Message** visible → short follow-up DM
   - **Connect** still available → skip (`connect_still_available`)
5. Dry-run: types the message, does **not** click Send.

## Run

```powershell
$env:LEAD_RUN_ID="20260804-164648"
npm run jobs:run -- lead-followup-accepted --dry-run
npm run jobs:run -- lead-followup-accepted --no-dry-run
```

| Env | Default | Notes |
|-----|---------|--------|
| `LEAD_RUN_ID` | latest | Run folder under `data/leads/` |
| `LEAD_DRY_RUN` | `true` | Type DM, do not Send |
| `LEAD_FOLLOWUP_MAX` | `10` | Max profiles this run |
| `LEAD_FOLLOWUP_ONLY_ACCEPTED` | `false` | Pending → skipped instead of pending |
| `LI_SAFE_MAX_MESSAGES_PER_DAY` | (safety) | Soft-exit when cap hit |

Artifacts: `data/leads/<runId>/leads.followup.json`
