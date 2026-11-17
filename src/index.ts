import { shouldRun, clockGate, laDate } from './schedule';
import { extractGuids, fetchFeed, itemFor } from './feed';
import { extract } from './extract';
import { save, triggerRebuild, type Processed } from './save';

const MAX_PER_RUN = 3;

/** LA dates of events starting within +-1 day; only queried when clock gate defers. */
async function launchDates(db: D1Database, now: Date): Promise<string[]> {
	const from = new Date(now.getTime() - 2 * 86_400_000).toISOString();
	const to = new Date(now.getTime() + 2 * 86_400_000).toISOString();
	const { results } = await db
		.prepare('SELECT starts_at FROM events WHERE starts_at BETWEEN ? AND ?')
		.bind(from, to)
		.all<{ starts_at: string }>();
	return results.map((r) => laDate(r.starts_at));
}

async function run(env: Env, now: Date): Promise<void> {
	const gate = clockGate(now);
	const dates = gate === true ? [] : await launchDates(env.DB, now);
	if (!shouldRun(now, dates)) return;

	const etagRow = await env.DB.prepare("SELECT value FROM kv WHERE key = 'feed_etag'").first<{ value: string }>();
	const feed = await fetchFeed(env.FEED_URL, etagRow?.value ?? null);
	if (feed.status === 'unchanged') return;

	const guids = extractGuids(feed.xml);
	if (guids.length === 0) return;
	const ph = guids.map(() => '?').join(',');
	const { results: known } = await env.DB.prepare(`SELECT guid FROM posts WHERE guid IN (${ph})`)
		.bind(...guids)
		.all<{ guid: string }>();
	const seen = new Set(known.map((r) => r.guid));
	const fresh = guids.filter((g) => !seen.has(g)).slice(0, MAX_PER_RUN);

	const batch: Processed[] = [];
	for (const guid of fresh) {
		const item = itemFor(feed.xml, guid);
		if (!item) continue;
		batch.push({ item, events: await extract(env.AI, item) });
	}
	const changed = await save(env.DB, batch);

	// ETag only when everything new was handled; else retry next run.
	if (feed.etag && guids.filter((g) => !seen.has(g)).length <= MAX_PER_RUN) {
		await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('feed_etag', ?)")
			.bind(feed.etag)
			.run();
	}
	if (changed > 0) await triggerRebuild(env.REBUILD_HOOK_URL);
}

export default {
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(run(env, new Date(controller.scheduledTime)));
	}
} satisfies ExportedHandler<Env>;
