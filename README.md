# resetwatch-ingest

Cloudflare Worker that keeps [Resetwatch](../resetwatch) supplied with season and event dates. It reads the official Overwatch news articles and patch notes on overwatch.blizzard.com, pulls out dates, a short summary, key values (reward tiers, prices, Loot Box counts) and a deep link to the section each event came from, stores them in D1 and triggers a site rebuild when something new shows up.

No HTTP surface. The Worker only has a `scheduled` handler (`workers_dev` and preview URLs are off).

## Flow

```
cron */5 * * * *
  └─ schedule gate ── skip? ──> done
       └─ fetch news index + patch notes page (server-rendered HTML)
            └─ posts from the last 90 days not in `posts` (max 4 per run, articles first)
                 └─ fetch article, split into sections (<h2> in news, <h4> per patch)
                      └─ extract: Workers AI (dates, summary, facts, section), regex fallback
                           └─ save: insert new events, or enrich a matching existing row
                                └─ anything inserted/enriched? POST REBUILD_HOOK_URL
```

The same event usually shows up twice (news article and patch notes, with slightly different names and dates). `sameEvent` in [`src/save.ts`](src/save.ts) treats rows as one event when kind matches, one name is a prefix of the other (or the season number matches) and the date windows are within 3 days. The first source wins the dates; later ones only fill in missing summary, facts and link.

### What is trusted from the model

The model output is validated by hand ([`validateLlm`](src/extract.ts)):

- Start and end dates must be written in the section text (`December 7`, `12/7`, `December 3–7`). An invented end is dropped (the event then shows no card); an invented start drops the event. Only a season launch post may give a start without a date (the publish day).
- Every number in a fact value must appear verbatim in the post. Max 4 facts.
- Summaries under 6 words are dropped; long ones are cut at 220 characters. They are the model's own words, never copied text.
- `source_url` is built from the section index, never taken from the model.

1. **Gate.** The cron fires every 5 minutes, but most ticks exit early. Times are `America/Los_Angeles`:
   - Tue 09:00-14:00: every 5 min (patch day, posts land around the 11 AM reset).
   - Mon, Wed, Thu 09:00-13:00: every 15 min.
   - Any day that has an event or season starting (looked up in D1, +-2 days window): every tick, all day.
   - Everything else: once a day, 09:00-09:04.
   - The first tick after each deploy ignores the gate, so a fresh version always does one full run.
2. **Fetch** ([`src/feed.ts`](src/feed.ts)). `NEWS_URL` (article cards with link and timestamp) and `PATCH_NOTES_URL` (one block per patch, `id="patch-YYYY-MM-DD"`). Both are plain server-rendered HTML. A failing source is logged and skipped for that tick. Article pages are only fetched for posts not yet in `posts`.
3. **Extract** ([`src/extract.ts`](src/extract.ts)). Only the intro and sections that name a date go to the model (keeps prompts under ~9k chars). Posts with no keyword/date at all go through the `clef-flash` gate first. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` returns JSON via `json_schema`. If the model fails or returns nothing, a regex parser reads ranges like `Dec 8 - Jan 12` or `11/19 - 11/23` per section, named after the section heading.
4. **Save** ([`src/save.ts`](src/save.ts)). One D1 batch: posts, new events, enrichment updates. Events stay unique on `(kind, name, starts_at)`, so reprocessing is harmless.
5. **Rebuild.** If any event row was inserted or enriched, `POST` to `REBUILD_HOOK_URL`. The site build then runs `fetch-events` and bakes D1 into `events.json` (source links are checked against an allowlist of Blizzard hosts there).

## Data

Schema in [`schema.sql`](schema.sql):

| Table | Purpose |
| --- | --- |
| `posts` | Processed posts, keyed by guid (article URL, or `patch-notes#patch-YYYY-MM-DD`) |
| `events` | `season_start`, `season_end` or `event`, with `starts_at` / `ends_at` as UTC ISO strings, plus `summary`, `facts` (JSON `[{label, value}]`), `source_url`, `source_title` |
| `kv` | `deploy_version` |

The schema file also seeds Season 6 start (2026-12-08) as a manual row. Databases created before 2026-11-23 need the migration once: `bun run db:migrate:remote` (it fails with "duplicate column name" if run twice).

## Configuration

| Name | Where | Notes |
| --- | --- | --- |
| `NEWS_URL` | `vars` in `wrangler.jsonc` | `https://overwatch.blizzard.com/en-us/news/` |
| `PATCH_NOTES_URL` | `vars` in `wrangler.jsonc` | `https://overwatch.blizzard.com/en-us/news/patch-notes/` |
| `DB` | D1 binding | database `resetwatch` |
| `AI` | Workers AI binding | |
| `CF_VERSION_METADATA` | version metadata binding | detects first run after deploy |
| `REBUILD_HOOK_URL` | secret | deploy hook of the Resetwatch site. Without it the Worker logs a warning and skips the rebuild |

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run db:schema:local     # create tables in local D1
bun run dev                 # wrangler dev --test-scheduled
```

Trigger a tick by hand while `dev` is running:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

Local runs outside the gate windows exit early. The first tick after a restart counts as a new deploy and runs fully.

| Command | What it does |
| --- | --- |
| `bun run check` | Types and `tsc --noEmit` |
| `bun run test` | Vitest |
| `bun run gen` | Regenerate `worker-configuration.d.ts` |

## Deploy

```sh
bun run db:schema:remote    # first time
bun run db:migrate:remote   # once, for databases created before 2026-11-23
bunx wrangler secret put REBUILD_HOOK_URL
bun run deploy
```

## Known limits

- Max 4 new posts are processed per run; the first deploy backfills ~10 posts over 3 ticks.
- Parsing depends on Blizzard's markup (`article-body`, `PatchNotes-sectionTitle`, `blz-timestamp`). If they redesign, the index parse returns nothing and the Worker logs it; nothing bad gets written.
- Section links use scroll-to-text fragments (`#:~:text=Heading`). Chromium and Safari jump to the heading; Firefox opens the article top.
- Date extraction depends on post wording. Check the `events` table after a big patch post, and fix or insert rows manually if needed.
- The site snaps multi-week events to the weekly reset and short ones (under 6 days) to 11 AM PT on their own days.
