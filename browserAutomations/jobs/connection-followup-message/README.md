# Message accepted connections (Supabase → LinkedIn)

Downstream agent for the [LinkedIn Connection Tracker](https://github.com/nikhilesh-ramoliya/linkedIn-connection-extension) Chrome extension.

## Flow

```
Extension captures Connect clicks → Supabase connection_requests (status=pending)
        ↓
This job: visit profile → if Message available → send DM → DELETE row
```

## Prerequisites

1. Extension installed and saving rows to Supabase
2. `npm run auth:linkedin` — headed LinkedIn session
3. `.env` Supabase keys (same project as the extension)
4. **`SUPABASE_SERVICE_ROLE_KEY`** — required for live runs (delete row after send). Get from Supabase → Settings → API Keys → `service_role` (secret). Never commit.

The extension schema only grants anon SELECT/INSERT. Delete uses the service role key from this automation job only.

## Run

```bash
cd browserAutomations

# Dry-run: type message, do not Send, do not delete
npm run connections:followup

# Live: Send + delete row on success
npm run jobs:run -- connection-followup-message --no-dry-run
```

| Env | Default | Notes |
|-----|---------|--------|
| `CONNECTION_FOLLOWUP_DRY_RUN` | `true` | Type DM, no Send/delete |
| `CONNECTION_FOLLOWUP_MAX` | `10` | Max rows per run |
| `CONNECTION_FOLLOWUP_ONLY_ACCEPTED` | `true` | Skip still-pending connects |
| `CONNECTION_FOLLOWUP_SERVICE` | `custom software` | Template variable |
| `SUPABASE_URL` | — | Same as `VITE_SUPABASE_URL` |
| `SUPABASE_PUBLISHABLE_KEY` | — | For reading pending rows |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Required for live delete |
| `LI_SAFE_MAX_MESSAGES_PER_DAY` | `20` | Soft cap |

Artifacts: `data/connections/followup-<timestamp>.json`  
Logs: `logs/connection-followup-message-*.jsonl`

## Behavior

- Fetches `connection_requests` where `status = pending`, oldest first
- Opens each `profile_url` in Playwright (human delays + daily message cap)
- **Pending connect** → leave row in Supabase (try again later)
- **Message button** (accepted) → send follow-up DM using `invitation_note` as optional hook
- **Live send success** → `DELETE` row via service role
- **Dry-run** → types message, logs preview, row stays in Supabase
