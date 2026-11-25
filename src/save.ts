import type { Post } from './feed';
import type { ExtractedEvent, Kind } from './extract';

export interface Processed {
	post: Post;
	events: ExtractedEvent[];
}

const DAY = 86_400_000;

interface EventKey {
	kind: Kind | string;
	name: string;
	starts_at: string;
	ends_at: string | null;
}

interface StoredEvent extends EventKey {
	id: number;
	summary: string | null;
	facts: string | null;
	source_url: string | null;
}

/** Lowercase, punctuation-free, filler words dropped: `Junkrat's Loot Hunt + Double XP` -> `junkrats loot hunt double xp`. */
export function normName(s: string): string {
	return s
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\b(the|and|event|returns?|weekend|overwatch|reign of talon)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const seasonNo = (s: string) => s.match(/season\s*(\d+)/i)?.[1];

/**
 * Same event reported by two sources (news article and patch notes name and date it slightly
 * differently): same kind, one name a prefix of the other (or same season number), and date
 * windows within 3 days of each other.
 */
export function sameEvent(a: EventKey, b: EventKey): boolean {
	if (a.kind !== b.kind) return false;
	const as = Date.parse(a.starts_at);
	const bs = Date.parse(b.starts_at);
	if (Number.isNaN(as) || Number.isNaN(bs)) return false;
	const ae = a.ends_at ? Date.parse(a.ends_at) : as;
	const be = b.ends_at ? Date.parse(b.ends_at) : bs;
	if (!(as <= be + 3 * DAY && bs <= ae + 3 * DAY)) return false;
	if (a.kind !== 'event') {
		const sa = seasonNo(a.name);
		if (sa && sa === seasonNo(b.name)) return true;
	}
	const na = normName(a.name);
	const nb = normName(b.name);
	if (!na || !nb) return false;
	return na === nb || na.startsWith(nb + ' ') || nb.startsWith(na + ' ');
}

const factsJson = (e: ExtractedEvent) => (e.facts.length ? JSON.stringify(e.facts) : null);
const hasDetails = (e: ExtractedEvent) => !!(e.summary || e.facts.length || e.source_url);

/**
 * Save posts + events in one batch. An event that matches an existing row (see sameEvent) is not
 * inserted again; instead the row gets the summary, facts and source link it is missing.
 * Returns the number of rows inserted or enriched.
 */
export async function save(db: D1Database, batch: Processed[]): Promise<number> {
	if (batch.length === 0) return 0;
	const now = new Date().toISOString();
	const stmts: D1PreparedStatement[] = [];
	const counted: number[] = [];
	const pending: EventKey[] = [];

	for (const { post, events } of batch) {
		stmts.push(
			db
				.prepare(
					'INSERT OR IGNORE INTO posts (guid, title, published_at, processed_at, url) VALUES (?, ?, ?, ?, ?)'
				)
				.bind(post.guid, post.title, post.pubDate, now, post.url)
		);
		for (const e of events) {
			if (pending.some((p) => sameEvent(p, e))) continue; // dup within this run
			const from = new Date(Date.parse(e.starts_at) - 45 * DAY).toISOString();
			const to = new Date(Date.parse(e.starts_at) + 45 * DAY).toISOString();
			const { results } = await db
				.prepare(
					'SELECT id, kind, name, starts_at, ends_at, summary, facts, source_url FROM events WHERE kind = ? AND starts_at BETWEEN ? AND ?'
				)
				.bind(e.kind, from, to)
				.all<StoredEvent>();
			const match = results.find((r) => sameEvent(r, e));
			pending.push(e);
			if (match) {
				const fills = hasDetails(e) && (!match.summary || !match.facts || !match.source_url);
				if (!fills) continue;
				counted.push(stmts.length);
				stmts.push(
					db
						.prepare(
							`UPDATE events SET summary = COALESCE(summary, ?), facts = COALESCE(facts, ?),
							 source_url = COALESCE(source_url, ?), source_title = COALESCE(source_title, ?)
							 WHERE id = ?`
						)
						.bind(e.summary, factsJson(e), e.source_url, e.source_title, match.id)
				);
				continue;
			}
			counted.push(stmts.length);
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO events
						 (post_guid, kind, name, starts_at, ends_at, raw_text, summary, facts, source_url, source_title)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						post.guid,
						e.kind,
						e.name,
						e.starts_at,
						e.ends_at,
						e.raw_text,
						e.summary,
						factsJson(e),
						e.source_url,
						e.source_title
					)
			);
		}
	}
	const results = await db.batch(stmts);
	return counted.reduce((n, i) => n + (results[i].meta.changes ?? 0), 0);
}

export async function triggerRebuild(url: string | undefined): Promise<void> {
	if (!url) {
		console.warn('REBUILD_HOOK_URL not set; skipping rebuild');
		return;
	}
	const res = await fetch(url, { method: 'POST' });
	if (!res.ok) console.error('rebuild hook failed', res.status);
}
