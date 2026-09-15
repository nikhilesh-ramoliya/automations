# Browser Automations — Agent notes

See also `.cursor/rules/browser-automations.mdc` (always applied in this workspace).

## Quick commands

| Intent | Command |
|--------|---------|
| List jobs | `npm run jobs:list` |
| Run job (dry) | `npm run jobs:run -- <jobId> --dry-run` |
| Run job (live) | `npm run jobs:run -- <jobId> --no-dry-run` |
| Lanatus invites | `npm run invite:lanatus` |
| Lead pipeline | `npm run leads:pipeline -- --dry-run` |
| Visibility pipeline | `npm run visibility:pipeline -- --dry-run` |
| Content engine (topics → drafts) | `npm run content:pipeline -- --dry-run` |
| LinkedIn login | `npm run auth:linkedin` |
| Google / Gmail login | `npm run auth:google` |
| Send outreach (email or LI connect) | `npm run jobs:run -- lead-send-outreach --dry-run` |
| Follow up accepted connects / message after connect | `npm run jobs:run -- lead-followup-accepted --dry-run` |

## Lead generation

Company research defaults to **LinkedIn About → website crawl** (`LEAD_SKIP_WEB_SEARCH=true`) — no Bing/Google CAPTCHA. Optional paid Brave/Bing APIs only if you set `LEAD_SKIP_WEB_SEARCH=false`. HTML SERP only if `LEAD_HTML_SEARCH=true`. Tech signals crawl the company site. Decision makers: website leadership → filtered LI company employees → optional global people search (`LEAD_PEOPLE_*`; site visits via `LEAD_WEB_CONCURRENCY` max 2).

Recommended chain:

```
discover → dedupe → enrich → tech-signals → find-decision-makers →
suppress → verify-contact → qualify → draft-outreach → export
```

| Intent | Job id |
|--------|--------|
| Full lead pipeline | `lead-pipeline` |
| Discover companies | `lead-discover-companies` |
| Dedupe | `lead-dedupe` |
| Enrich company | `lead-enrich-company` |
| Tech / buying signals | `lead-tech-signals` |
| Find decision makers | `lead-find-decision-makers` |
| Suppress lists | `lead-suppress` |
| Verify contact | `lead-verify-contact` |
| Qualify / score | `lead-qualify` |
| Draft outreach | `lead-draft-outreach` |
| Send outreach (Gmail / LI connect) | `lead-send-outreach` |
| Follow up accepted connects / message after connect | `lead-followup-accepted` |
| Export CSV/JSON | `lead-export` |

**Send strategy:** LinkedIn URL → connection request (+ optional note); email only if `LEAD_SEND_EMAIL=true`. After accepts, run `lead-followup-accepted` for a short DM. Neither send nor follow-up is in the default pipeline — review drafts first.

Artifacts: `data/leads/<runId>/` (companies, people, leads, …) and `output/leads/<runId>/leads.csv` + `leads.json`. Shared types/helpers: `lib/leads/` (`search-api.ts` for Brave/Bing).

```powershell
$env:LEAD_MAX_COMPANIES="2"
npm run jobs:run -- lead-pipeline --dry-run
# single step:
npm run jobs:run -- lead-qualify --dry-run
# web-only enrich (skip LinkedIn):
$env:LEAD_ENRICH_LINKEDIN="false"
npm run jobs:run -- lead-enrich-company --dry-run
# smoke search API (skips if no key):
npm run verify:search-api
```

### Company research (default: no web search)

**Default:** LinkedIn company **About** → website URL → **crawl** the site.  
`LEAD_SKIP_WEB_SEARCH` defaults to **true** (also set in `.env`).

| Env | Default | Notes |
|-----|---------|--------|
| `LEAD_SKIP_WEB_SEARCH` | `true` | No API/HTML search |
| `LEAD_ENRICH_LINKEDIN_WEBSITE` | `true` | Read website from LinkedIn About |
| `LEAD_HTML_SEARCH` | `false` | Opt-in browser SERP (CAPTCHA risk) |
| `LEAD_PEOPLE_WEB_SEARCH` | `false` | Web→LI `/in/` search |

To use paid Brave/Bing APIs: set `LEAD_SKIP_WEB_SEARCH=false` and the API key. See `.env.example`.

Env (other): `LEAD_ENRICH_WEB_FIRST`, `LEAD_ENRICH_LINKEDIN`, `LEAD_PEOPLE_WEB_FIRST` / `LEAD_PEOPLE_LINKEDIN_COMPANY` / `LEAD_PEOPLE_LINKEDIN_SEARCH`, `LEAD_WEB_CONCURRENCY` (default 1, max 2, **sites only**), `LEAD_TECH_CRAWL_MAX_PAGES`.

## Visibility (personal LinkedIn brand — not lead-gen)

**Default (content-first):** search topic posts → meaningful like/comment on the SERP.  
**Connect only** when a post scores high on software-dev lead fit (hiring eng, building product, custom software need, transformation, seeking a partner, etc.).

Does **not** open random ICP profiles by default. Optional people mode: `VISIBILITY_TARGETED=true`.

```
find-posts + engage (content) → draft-posts
# connect: only if leadFit ≥ VISIBILITY_CONNECT_MIN_LEAD_SCORE (80)
```

| Intent | Job id |
|--------|--------|
| Full visibility pipeline (content default) | `visibility-pipeline` |
| Find related posts | `visibility-find-posts` |
| React + comment (+ rare lead-fit connect) | `visibility-engage` |
| ICP people mode (optional) | `visibility-targeted-engage` |
| Draft your posts | `visibility-draft-posts` |

```powershell
$env:VISIBILITY_MAX_REACTIONS="6"
$env:VISIBILITY_MAX_COMMENTS="4"
$env:VISIBILITY_MAX_CONNECTS="2"
$env:VISIBILITY_CONNECT_MIN_LEAD_SCORE="80"
npm run visibility:pipeline -- --dry-run
```

## Content engine (authority drafts — not lead-gen, not engage)

Offline LinkedIn **topic research → multi-angle post generation → scoring**. Positions Lanatus as an engineering partner (founders, CTOs, eng managers, product leaders, outsourcing / AI automation buyers). **Never publishes.** Separate from `visibility-*` engage and from `lead-*`.

```
research-topics → generate-posts (score + persist drafts)
```

| Intent | Job id |
|--------|--------|
| Full content pipeline | `content-pipeline` |
| Research topic ideas | `content-research-topics` |
| Generate & score drafts | `content-generate-posts` |

Uses **Cursor CLI** (`agent -p --mode ask`) to generate unique posts from `instructions.md`. Set `CURSOR_API_KEY` or run `agent login`. Optional OpenAI-compatible fallback. Artifacts: `data/content/<runId>/`.

**Instructions:** edit `data/content/instructions.md` (**Interests** / Must / Never / Prefer / **Image**). Interests drive topic + post themes; usage is tracked in `data/content/interest-usage.json` (auto). **Image** rules (style, palette, headline, byline) design the 1200×627 title card at compose. Loaded on research, generate, and compose; conflicting drafts are refined before score/compose.

**Schedule (Windows):** Mon & Thu 14:00 via Task Scheduler — `scripts/register-content-pipeline-schedule.ps1` (task `Lanatus-ContentPipeline-MonThu`).

```powershell
$env:CONTENT_MAX_TOPICS="4"
$env:CONTENT_MAX_VARIATIONS="3"
npm run content:pipeline -- --dry-run
```

## Layout

- `jobs/<id>/` — one folder per automation (`job.json` + `run.ts`)
- `jobs/_template/` — copy to scaffold a new job
- `lib/` — auth, pacing, ranking, logging, runner, heal, leads, **visibility**, **content**, **ai**, **linkedin-safety**
- `automations/` — login/record utilities + thin shims for old paths
- `logs/` — job + heal JSONL (gitignored)
- `data/leads/` — lead run artifacts (gitignored except suppress examples)
- `data/visibility/` — visibility run artifacts (gitignored)
- `data/content/` — content engine artifacts (gitignored except `instructions.md`)
- `data/content/interest-usage.json` — interest rotation counters (gitignored, auto)
- `data/linkedin-safety/` — daily usage counters + job lock (gitignored)
- `output/leads/` — CRM/spreadsheet exports (gitignored)
- `output/visibility/` — draft posts export (gitignored)
- `output/content/` — scored content drafts export (gitignored)

## LinkedIn safety (risk reduction — not a ban guarantee)

Shared helpers in `lib/linkedin-safety.ts` used by invite, lead LinkedIn jobs, **visibility LinkedIn jobs**, auth, record, session:

- **Daily caps** (local day, established-account mid-range): searches 70, profile views 180, page views 250, connects 20, messages 20, invites 20, reactions 40; active job runtime 60 min (burst pauses excluded)
- **Burst breaks**: pause ~5–20 min after every 15–25 recorded actions (spreads activity over the day)
- **Human delays** via `humanDelay(op)` — ~3–15s between actions, ~20–60s on profiles; `humanScroll` / `humanBrowseProfile`; global `LI_SAFE_DELAY_MULT=1.5`–`2` if challenged
- **One concurrent session** per LinkedIn account (profile lock)
- **Varied** connection notes (no identical blast messages)
- **One LinkedIn job at a time**: runner acquires `data/linkedin-safety/job.lock` up front; a second starter **exits immediately** with `[linkedin-lock] …`. Nested guards in the same process are re-entrant.
- Prefer **headed**; `HEADLESS=true` increases detection risk
- Cap hit → soft exit (partial artifacts OK). Checkpoint/restriction → **abort, no heal retry**

Ops: daytime hours, low volume, dry-run first; if challenged, cool down 24–48h before any automation.

Env: see `LI_SAFE_*` in `.env.example`. Counters: `data/linkedin-safety/usage.json`. Verify delays: `npx tsx scripts/verify-linkedin-safety.ts`.

## Heal

Runner (`lib/runner.ts` + `lib/heal.ts`) auto-handles login redirect hints, profile lock (kill our Chromium for the job profile once), selector miss retry once, and soft-success for zero batch / safety caps. **Does not** auto-retry LinkedIn restriction/checkpoint pages — instruct cool-down instead. Prefer reading heal logs over inventing new recovery strategies.
