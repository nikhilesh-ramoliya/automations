# Visibility — targeted people engage

Intentional ICP networking (not keyword content scrolling):

1. Type a people search (CTO, Founder, VP Engineering, …)
2. Open profiles and glance
3. Open recent activity → meaningful comments + selective reacts
4. Optional personalized connection requests

## Run

```powershell
# dry-run first (reacts allowed; comments typed not sent; connects dry-run)
npm run jobs:run -- visibility-targeted-engage --dry-run

# live
npm run jobs:run -- visibility-targeted-engage --no-dry-run
```

Also the default step in `visibility-pipeline` when `VISIBILITY_TARGETED=true` (default).

## Env

| Var | Default | Notes |
|-----|---------|--------|
| `VISIBILITY_ICP_QUERIES` | CTO / Founder / VP Eng… | Comma-separated |
| `VISIBILITY_ICP_QUERIES_PER_RUN` | 1 | Random queries per run |
| `VISIBILITY_MAX_PROFILES` | 12 | Profile views this run |
| `VISIBILITY_MAX_COMMENTS` | 6 | Meaningful comments |
| `VISIBILITY_MAX_REACTIONS` | 12 | Likes on their posts |
| `VISIBILITY_MAX_CONNECTS` | 5 | Personalized connects |
| `VISIBILITY_DO_CONNECT` | true | Toggle connects |
| `VISIBILITY_LIKE_MIN_SCORE` | 55 | Like gate |
| `VISIBILITY_COMMENT_MIN_SCORE` | 75 | Comment gate (lowered slightly on target activity) |

Respects `LI_SAFE_*` caps. Soft-exits when caps hit.
