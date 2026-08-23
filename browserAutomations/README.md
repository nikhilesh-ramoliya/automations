# Browser Automations

Self-contained Playwright + TypeScript automations (LinkedIn first), structured as **one job per folder** with a shared runner, registry, and deterministic auto-heal.

## Setup

```powershell
cd D:\Projects\lanatus\Lanatus-Systems\business-automation\browserAutomations
npm install
npx playwright install chromium
Copy-Item .env.example .env
# Edit .env with your LinkedIn credentials
```

Never commit `.env`, `auth/`, `.pw-user-data/`, or `logs/`.

### Playwright MCP (Cursor)

Project MCP config lives in `.cursor/mcp.json`. In Cursor: **Settings → MCP**, enable the **playwright** server for this workspace.

## Multi-job workflow

```powershell
npm run jobs:list
npm run jobs:run -- <jobId> --dry-run
npm run jobs:run -- <jobId> --no-dry-run
```

| Path | Role |
|------|------|
| `jobs/<id>/job.json` | Metadata (id, tags, env, heal hints) |
| `jobs/<id>/run.ts` | Entry — `export async function run()` |
| `jobs/registry.json` | Snapshot written by `jobs:list` |
| `jobs/_template/` | Copy to scaffold a new job |
| `lib/runner.ts` | Load job, validate env, run + heal |
| `lib/heal.ts` | Login / profile-lock / selector retries |
| `AGENTS.md` / `.cursor/rules/` | How agents pick & heal jobs |

### Add a job

```powershell
Copy-Item -Recurse jobs\_template jobs\my-job-id
# Edit job.json (id = folder name) and implement run.ts
npm run jobs:list
npm run jobs:run -- my-job-id --dry-run
```

## LinkedIn login

```powershell
npm run auth:linkedin
```

Saves session to `auth/linkedin.json` and uses persistent profile `.pw-user-data/linkedin`.

## Invite connections to follow Lanatus

Job id: **`linkedin-invite-follow-lanatus`**

```powershell
# Dry-run (default)
npm run jobs:run -- linkedin-invite-follow-lanatus --dry-run
# Alias (same thing)
npm run invite:lanatus

# Live send
npm run jobs:run -- linkedin-invite-follow-lanatus --no-dry-run
```

### Monthly pacing

Each run reads remaining credits from the invite popup, then spreads them across the rest of the calendar month:

```
remainingDays = lastDayOfMonth - todayDate + 1   # includes today
batchSize     = ceil(remainingCredits / remainingDays)
```

- Credits or batch `0` → clean soft success (nothing to send).
- Optional `INVITE_MAX` caps the paced batch (`INVITE_MAX_MODE=cap`, default).

### Env vars

| Variable | Required | Notes |
|----------|----------|--------|
| `LINKEDIN_EMAIL` | Yes* | Or `EMAIL` (for `auth:linkedin`) |
| `LINKEDIN_PASSWORD` | Yes* | Or `PASSWORD` |
| `HEADLESS` | No | Prefer headed until session is stable |
| `LANATUS_COMPANY_URL` | No | Defaults to Lanatus company Page |
| `INVITE_MAX` | No | Optional **cap** on paced batch |
| `INVITE_MAX_MODE` | No | `cap` (default) or `override` |
| `INVITE_DELAY_MS` | No | Default `2000` |
| `INVITE_DRY_RUN` | No | Default `true` |
| `INVITE_QUERY` | No | Optional modal name search |
| `INVITE_PRIORITY_KEYWORDS` | No | Ranking keywords |

See `jobs/linkedin-invite-follow-lanatus/README.md` for job-specific notes.

## Limits

LinkedIn actively detects automation. These controls **reduce risk** — they do **not** prevent bans/restrictions 100%.

### LinkedIn safety (`lib/linkedin-safety.ts`)

Shared by invite, lead LinkedIn steps, auth, record, and session tools:

| Control | Default | Env |
|---------|---------|-----|
| Searches / day | 70 | `LI_SAFE_MAX_SEARCHES_PER_DAY` |
| Profile views / day | 180 | `LI_SAFE_MAX_PROFILE_VIEWS_PER_DAY` |
| Page views / day | 250 | `LI_SAFE_MAX_PAGE_VIEWS_PER_DAY` |
| Connection requests / day | 20 | `LI_SAFE_MAX_CONNECTS_PER_DAY` |
| Messages / day | 20 | `LI_SAFE_MAX_MESSAGES_PER_DAY` |
| Invites (page follow) / day | 20 | `LI_SAFE_MAX_INVITES_PER_DAY` |
| Reactions / day | 40 | `LI_SAFE_MAX_REACTIONS_PER_DAY` |
| Active job runtime | 60 min | `LI_SAFE_MAX_JOB_RUNTIME_MIN` (burst pauses excluded) |
| Burst break | every 15–25 actions, pause 5–20 min | `LI_SAFE_BURST_*` |
| Delay multiplier | 1.0 | `LI_SAFE_DELAY_MULT` (try 1.5–2 if challenged) |

Also: one LinkedIn session at a time, ~3–15s think times, ~20–60s profile dwell + human scroll, varied connect notes.

Counters live in `data/linkedin-safety/usage.json` (gitignored). Cap hits exit cleanly (soft success).

**Operating tips**

- Run **one** LinkedIn job at a time. The runner takes `data/linkedin-safety/job.lock` before starting; a second job **exits** with a clear `[linkedin-lock]` message (no heal retry).
- Prefer **headed** browsing; only set `HEADLESS=true` if you accept higher risk.
- Prefer daytime human hours and low volume; dry-run first.
- If you see checkpoint / unusual activity: **cool down 24–48h**, browse manually, do not loop retries.
- Reuse the persistent profile (`.pw-user-data/linkedin`); never rapid login/logout.

Invite batch = `min(monthly paced batch, INVITE_MAX, remaining daily invite cap)`.

## Auto-heal

When run via `jobs:run` / `invite:lanatus`, failures are classified and handled once:

1. **Login redirect** — clear message; suggest `auth:linkedin`; brief wait + one retry if auth appears
2. **Profile lock** — kill only Chromium processes using our profile path; remove SingletonLock if possible; retry once (advisory “another job running” aborts without kill)
3. **Selector / label miss** — one full-job retry (job already has alternate locators)
4. **Zero batch / no credits** — soft success (exit 0)
5. **Daily safety cap / runtime** — soft success (exit 0); continue tomorrow
6. **Restriction / checkpoint** — **abort, no auto-retry**; cool down before any re-run

Heal attempts are logged under `logs/<jobId>-heal-*.jsonl`.

## Scripts

| Script | Command |
|--------|---------|
| List jobs | `npm run jobs:list` |
| Run job | `npm run jobs:run -- <jobId>` |
| LinkedIn login | `npm run auth:linkedin` |
| Invite Lanatus (alias) | `npm run invite:lanatus` |
| Lead pipeline | `npm run leads:pipeline` |
| Visibility pipeline | `npm run visibility:pipeline` |
| Content engine | `npm run content:pipeline` |
| Referral / job hunt | `npm run referral:pipeline` |
| Naukri pipeline | `npm run naukri:pipeline` |
| Naukri login | `npm run auth:naukri` |
| Session logger | `npm run session:linkedin` |
| Record actions | `npm run record:linkedin` |
| Workflow from recording | `npm run workflow:from-recording` |
| Typecheck | `npm run typecheck` |
| Verify search API | `npm run verify:search-api` |
| Install Chromium | `npm run playwright:install` |

### Lead company research (default: no web search)

**Default path (no CAPTCHA):** LinkedIn company **About** → website URL → **crawl** that site (enrich + tech-signals).  
`LEAD_SKIP_WEB_SEARCH=true` (code default). Set `LEAD_SKIP_WEB_SEARCH=false` only if you add a paid Brave/Bing API key or accept HTML SERP CAPTCHA risk (`LEAD_HTML_SEARCH`).

Optional APIs when search is enabled: `BRAVE_SEARCH_API_KEY`, `BING_SEARCH_API_KEY`. See `AGENTS.md` and `.env.example`.

Legacy path `automations/linkedin-invite-follow-lanatus.ts` is a thin re-export shim.

