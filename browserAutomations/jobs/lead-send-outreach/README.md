# Send outreach — LinkedIn connect (email optional)

**Not part of the default pipeline.** Review `leads.outreach.json` first.

## Default strategy (current)

| Situation | Action |
|-----------|--------|
| `person.linkedinUrl` | **Connect** (+ optional note from LinkedIn draft) |
| No LinkedIn URL | Skip |
| Email | **Skipped** unless `LEAD_SEND_EMAIL=true` |

Accepted connections → follow up with `lead-followup-accepted` (short LinkedIn DM after Message appears).

## Run

```powershell
$env:LEAD_RUN_ID="20260804-164648"
npm run jobs:run -- lead-send-outreach --dry-run
npm run jobs:run -- lead-send-outreach --no-dry-run
# after some accepts:
npm run jobs:run -- lead-followup-accepted --dry-run
```

Env: `LEAD_SEND_MAX`, `LEAD_SEND_ADD_NOTE`, `LEAD_SEND_EMAIL` (default false), `LI_SAFE_MAX_CONNECTS_PER_DAY`.

Artifacts: `data/leads/<runId>/leads.sent.json`
