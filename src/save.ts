import type { FeedItem } from './feed';
import type { ExtractedEvent } from './extract';

export interface Processed {
	item: FeedItem;
	events: ExtractedEvent[];
}

/** Save posts + events atomically. Returns number of newly inserted events. */
export async function save(db: D1Database, batch: Processed[]): Promise<number> {
	if (batch.length === 0) return 0;
	const now = new Date().toISOString();
	const stmts: D1PreparedStatement[] = [];
	const eventIdx: number[] = [];
	for (const { item, events } of batch) {
		stmts.push(
			db
				.prepare('INSERT OR IGNORE INTO posts (guid, title, published_at, processed_at) VALUES (?, ?, ?, ?)')
				.bind(item.guid, item.title, item.pubDate, now)
		);
		for (const e of events) {
			eventIdx.push(stmts.length);
			stmts.push(
				db
					.prepare(
						'INSERT OR IGNORE INTO events (post_guid, kind, name, starts_at, ends_at, raw_text) VALUES (?, ?, ?, ?, ?, ?)'
					)
					.bind(item.guid, e.kind, e.name, e.starts_at, e.ends_at, e.raw_text)
			);
		}
	}
	const results = await db.batch(stmts);
	return eventIdx.reduce((n, i) => n + (results[i].meta.changes ?? 0), 0);
}

export async function triggerRebuild(url: string | undefined): Promise<void> {
	if (!url) {
		console.warn('REBUILD_HOOK_URL not set; skipping rebuild');
		return;
	}
	const res = await fetch(url, { method: 'POST' });
	if (!res.ok) console.error('rebuild hook failed', res.status);
}
