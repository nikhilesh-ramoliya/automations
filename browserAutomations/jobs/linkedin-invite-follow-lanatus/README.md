# Invite connections to follow Lanatus

Monthly-paced LinkedIn **Page admin → Invite to follow** for [Lanatus Systems](https://www.linkedin.com/company/lanatus/).

## Run

```powershell
# Dry-run (default)
npm run jobs:run -- linkedin-invite-follow-lanatus --dry-run
# Alias
npm run invite:lanatus

# Live send
npm run jobs:run -- linkedin-invite-follow-lanatus --no-dry-run
```

Requires prior `npm run auth:linkedin`.

## Env

| Variable | Notes |
|----------|--------|
| `LANATUS_COMPANY_URL` | Default company Page URL |
| `INVITE_DRY_RUN` | Default `true` |
| `INVITE_MAX` / `INVITE_MAX_MODE` | Cap or override paced batch |
| `INVITE_DELAY_MS` | UI pacing (default 2000) |
| `INVITE_QUERY` | Optional modal search |
| `INVITE_PRIORITY_KEYWORDS` | Ranking keywords |

See root `.env.example` and `README.md` for pacing details.

## Heal hints

- Login redirect → `npm run auth:linkedin`, re-run
- Profile lock → runner kills stuck Chromium for `.pw-user-data/linkedin`, retries once
- Selector miss → one automatic retry
- Zero credits / batch 0 → soft success (exit 0)
