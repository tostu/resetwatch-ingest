import { shouldRun, clockGate, laDate } from './schedule';
import { fetchHtml, parseArticle, parseNewsIndex, parsePatchNotes, type Post, type PostRef } from './feed';
import { extract } from './extract';
import { save, triggerRebuild, type Processed } from './save';

const MAX_PER_RUN = 4;
/** Older articles cannot announce anything still running. */
const MAX_AGE_DAYS = 90;

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

/** True once per deployed version: first cron tick after a deploy ignores gates. */
async function firstRunOfDeploy(env: Env): Promise<boolean> {
	const id = env.CF_VERSION_METADATA.id;
	const row = await env.DB.prepare("SELECT value FROM kv WHERE key = 'deploy_version'").first<{ value: string }>();
	if (row?.value === id) return false;
	await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('deploy_version', ?)").bind(id).run();
	return true;
}

/** A source that failed this tick yields nothing; the other one still runs. */
async function settle<T>(label: string, p: Promise<T[]>): Promise<T[]> {
	try {
		return await p;
	} catch (err) {
		console.error(`${label} failed`, { message: err instanceof Error ? err.message : String(err) });
		return [];
	}
}

type Candidate = { ref: PostRef; post?: Post };

async function run(env: Env, now: Date): Promise<void> {
	const force = await firstRunOfDeploy(env);
	if (!force) {
		const gate = clockGate(now);
		const dates = gate === true ? [] : await launchDates(env.DB, now);
		if (!shouldRun(now, dates)) return;
	}

	const minDate = now.getTime() - MAX_AGE_DAYS * 86_400_000;
	const [news, patches] = await Promise.all([
		settle('news index', fetchHtml(env.NEWS_URL).then(parseNewsIndex)),
		settle('patch notes', fetchHtml(env.PATCH_NOTES_URL).then((h) => parsePatchNotes(h, env.PATCH_NOTES_URL)))
	]);
	// Articles first: they carry the richer text for summaries and facts.
	const candidates: Candidate[] = [
		...news.filter((r) => Date.parse(r.pubDate) >= minDate).map((ref) => ({ ref })),
		...patches.filter((p) => Date.parse(p.pubDate) >= minDate).map((p) => ({ ref: p, post: p }))
	];
	if (candidates.length === 0) return;

	const guids = candidates.map((c) => c.ref.guid);
	const ph = guids.map(() => '?').join(',');
	const { results: known } = await env.DB.prepare(`SELECT guid FROM posts WHERE guid IN (${ph})`)
		.bind(...guids)
		.all<{ guid: string }>();
	const seen = new Set(known.map((r) => r.guid));
	const fresh = candidates.filter((c) => !seen.has(c.ref.guid)).slice(0, MAX_PER_RUN);

	const batch: Processed[] = [];
	for (const c of fresh) {
		let post = c.post;
		if (!post) {
			try {
				post = parseArticle(await fetchHtml(c.ref.url), c.ref);
			} catch (err) {
				console.error('article fetch failed', {
					url: c.ref.url,
					message: err instanceof Error ? err.message : String(err)
				});
				continue; // retry next run
			}
		}
		const events = await extract(env.AI, post);
		if (events === null) continue; // LLM failed: leave unsaved so next run retries
		batch.push({ post, events });
	}
	const changed = await save(env.DB, batch);
	if (changed > 0) await triggerRebuild(env.REBUILD_HOOK_URL);
}

export default {
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(run(env, new Date(controller.scheduledTime)));
	}
} satisfies ExportedHandler<Env>;
