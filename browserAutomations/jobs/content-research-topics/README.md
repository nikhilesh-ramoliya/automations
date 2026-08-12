# content-research-topics

Offline job: generate LinkedIn **topic ideas** for authority / inbound (founders, CTOs, eng managers, product leaders, outsourcing & AI automation buyers).

## Run

```powershell
npm run jobs:run -- content-research-topics --dry-run
```

Creates `data/content/<runId>/topics.json` and mirrors to `output/content/<runId>/topics.json`.

## Env

| Var | Default | Notes |
|-----|---------|--------|
| `CONTENT_MAX_TOPICS` | 8 | Cap |
| `CONTENT_CATEGORIES` | AI, SaaS, DevOps, … | Comma list |
| `CONTENT_AUDIENCES` | Founders, CTOs, … | Comma list |
| `CONTENT_USE_AI` | true | Use LLM if key present |
| `OPENAI_API_KEY` / `CONTENT_AI_API_KEY` | — | Optional |
| `CONTENT_AI_MODEL` | gpt-4o-mini | Optional |
| `CONTENT_RUN_ID` | auto | Reuse a run folder |

Without an API key, a curated template bank is used (same shape as AI output).

Topics include an `interest` field from `## Interests` in [`data/content/instructions.md`](../../data/content/instructions.md). Underused interests are preferred each run; counts live in `data/content/interest-usage.json`.

## Cadence

Recommended: **once daily** via your existing external scheduler (Task Scheduler / CI cron). This repo has no built-in cron — same as other jobs.
