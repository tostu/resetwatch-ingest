# resetwatch-ingest

Cloudflare Worker that keeps [Resetwatch](../resetwatch) supplied with season and event dates. It watches the Overwatch Steam news feed, pulls dates out of new posts, stores them in D1 and triggers a site rebuild when something new shows up.

No HTTP surface. The Worker only has a `scheduled` handler (`workers_dev` and preview URLs are off).

## Flow

```
cron */5 * * * *
  └─ schedule gate ── skip? ──> done
       └─ fetch Steam feed (If-None-Match ETag) ── 304? ──> done
            └─ new guids (max 3 per run) not in `posts`
                 └─ extract dates: Workers AI, regex fallback
                      └─ save posts + events to D1 (one batch)
                           └─ new events? POST REBUILD_HOOK_URL
```

1. **Gate.** The cron fires every 5 minutes, but most ticks exit early. Times are `America/Los_Angeles`:
   - Tue 09:00-14:00: every 5 min (patch day, posts land around the 11 AM reset).
   - Mon, Wed, Thu 09:00-13:00: every 15 min.
   - Any day that has an event or season starting (looked up in D1, +-2 days window): every tick, all day.
   - Everything else: once a day, 09:00-09:04.
   - The first tick after each deploy ignores the gate and the ETag, so a fresh version always does one full run.
2. **Fetch.** Conditional GET against `FEED_URL` (Steam news feed for app 2357570). The ETag is stored in `kv` and only advanced once every new post of that run was handled, otherwise the rest is retried next tick.
3. **Extract** ([`src/extract.ts`](src/extract.ts)). Posts that match no keyword (`season|now live|event|ends|starts|begins`) are skipped. Otherwise `@cf/meta/llama-3.3-70b-instruct-fp8-fast` is asked for JSON via `json_schema` and the result is validated by hand (known kind, ISO dates, within a year of publish date, end after start). If the model fails or returns nothing, a regex parser reads date ranges like `Dec 8 - Jan 12` from the text.
4. **Save** ([`src/save.ts`](src/save.ts)). Posts and events are inserted with `INSERT OR IGNORE` in one D1 batch. Events are unique on `(kind, name, starts_at)`, so reprocessing is harmless.
5. **Rebuild.** If any event row was actually inserted, `POST` to `REBUILD_HOOK_URL`. The site build then runs `fetch-events` and bakes D1 into `events.json`.

## Data

Schema in [`schema.sql`](schema.sql):

| Table | Purpose |
| --- | --- |
| `posts` | Processed feed items, keyed by guid |
| `events` | `season_start`, `season_end` or `event`, with `starts_at` / `ends_at` as UTC ISO strings |
| `kv` | `feed_etag` and `deploy_version` |

The schema file also seeds Season 6 start (2026-12-08) as a manual row.

## Configuration

| Name | Where | Notes |
| --- | --- | --- |
| `FEED_URL` | `vars` in `wrangler.jsonc` | Steam news RSS |
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
bun run db:schema:remote    # first time, or after schema changes
bunx wrangler secret put REBUILD_HOOK_URL
bun run deploy
```

## Known limits

- Max 3 new posts are processed per run; the remainder is picked up on following ticks.
- Date extraction depends on post wording. Check the `events` table after a big patch post, and fix or insert rows manually if needed.
- The regex fallback assumes fixed UTC times (19:00 for seasons, 17:00 for events). The site snaps every date to the nearest weekly reset anyway.
