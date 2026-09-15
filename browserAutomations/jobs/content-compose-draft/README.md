# content-compose-draft

Opens LinkedIn → **Start a post** → types the top scored draft from `drafts.json`.

## Dry-run (default)

Types the full post (body + hashtags) into the share box, generates a title card, and attaches it. **Does not click Post**.
Leaves the composer visible briefly for review, then discards/closes.

```powershell
# Ensure drafts exist for a run:
npm run content:pipeline -- --dry-run

# Type into LinkedIn without publishing:
npm run jobs:run -- content-compose-draft --dry-run
```

## Live publish (explicit)

Requires both `--no-dry-run` **and** `CONTENT_DO_PUBLISH=true`.

```powershell
$env:CONTENT_DO_PUBLISH="true"
npm run jobs:run -- content-compose-draft --no-dry-run
```

## Env

| Var | Default | Notes |
|-----|---------|--------|
| `CONTENT_RUN_ID` | latest | Must have `drafts.json` |
| `CONTENT_COMPOSE_DRAFT_ID` | — | Pin a specific draft |
| `CONTENT_MIN_SCORE` | 55 | Auto-pick threshold |
| `CONTENT_COMPOSE_REVIEW_MS` | 12000 | How long to show typed text |
| `CONTENT_DO_PUBLISH` | false | Click Post only when live |
| `CONTENT_ATTACH_IMAGE` | true | Generate a title card and attach it |
| `CONTENT_IMAGE_AI` | true | Use Cursor/AI to design card copy from `## Image` |
| `CONTENT_IMAGE_NAME` / `_ROLE` / `_HANDLE` | — | Card byline; overrides `## Image` |
| `CONTENT_IMAGE_STYLE` / `_PALETTE` / `_LAYOUT` / `_HEADLINE` | — | Override `## Image` keyed fields |
| `CONTENT_IMAGE_PATH` | — | Optional PNG/JPG instead of the generated card |

Card rules live in `data/content/instructions.md` under **## Image** (style, palette, headline length, must/never for the PNG). Compose regenerates the card each run unless `CONTENT_IMAGE_PATH` is set.
