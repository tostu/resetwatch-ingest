import type { FeedItem } from './feed';

export type Kind = 'season_start' | 'season_end' | 'event';

export interface ExtractedEvent {
	kind: Kind;
	name: string;
	starts_at: string; // UTC ISO
	ends_at: string | null;
	raw_text: string;
}

export const KEYWORD_GATE = /season|now live|event|ends|starts|begins/i;

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MON = `(?:${MONTHS}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?`;
const RANGE = new RegExp(`(${MON})\\s+(\\d{1,2})\\s*(?:-|–|—|to)\\s*(?:(${MON})\\s+)?(\\d{1,2})`, 'i');
const SINGLE = new RegExp(`(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i');

function monthIndex(s: string): number {
	const k = s.slice(0, 3).toLowerCase();
	return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(k);
}

/** Pick year so date lands on/after pubDate (rolls Dec -> Jan). */
function resolveYear(month: number, day: number, pub: Date, explicit?: number): number {
	if (explicit) return explicit;
	let y = pub.getUTCFullYear();
	const candidate = Date.UTC(y, month, day);
	if (candidate < pub.getTime() - 60 * 86_400_000) y++;
	return y;
}

const iso = (y: number, m: number, d: number, h: number) =>
	new Date(Date.UTC(y, m, d, h)).toISOString().replace('.000Z', 'Z');

export function classify(title: string): Kind {
	if (/season/i.test(title) && /(end|final|last)/i.test(title)) return 'season_end';
	if (/season/i.test(title)) return 'season_start';
	return 'event';
}

function eventName(title: string): string {
	return title.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Regex-only extraction. Returns [] when nothing found. */
export function regexExtract(item: FeedItem): ExtractedEvent[] {
	if (!KEYWORD_GATE.test(item.title + ' ' + item.text)) return [];
	const pub = new Date(item.pubDate);
	const kind = classify(item.title);
	const name = eventName(item.title);
	const hour = kind === 'event' ? 17 : 19; // default UTC wall time; seasons 19:00Z
	const body = item.text;

	const r = body.match(RANGE);
	if (r) {
		const m1 = monthIndex(r[1]);
		const d1 = Number(r[2]);
		const m2 = r[3] ? monthIndex(r[3]) : m1;
		const d2 = Number(r[4]);
		if (m1 >= 0 && m2 >= 0 && d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
			const y1 = resolveYear(m1, d1, pub);
			const y2 = m2 < m1 ? y1 + 1 : y1;
			return [
				{
					kind,
					name,
					starts_at: iso(y1, m1, d1, hour),
					ends_at: iso(y2, m2, d2, hour),
					raw_text: r[0]
				}
			];
		}
	}
	const s = body.match(SINGLE);
	if (s) {
		const m = monthIndex(s[1]);
		const d = Number(s[2]);
		if (m >= 0 && d >= 1 && d <= 31) {
			const y = resolveYear(m, d, pub, s[3] ? Number(s[3]) : undefined);
			return [{ kind, name, starts_at: iso(y, m, d, hour), ends_at: null, raw_text: s[0] }];
		}
	}
	return [];
}

/** Ambiguous: multiple distinct dates in text but regex found a lone single. */
export function isAmbiguous(item: FeedItem, found: ExtractedEvent[]): boolean {
	if (found.length === 0) return true;
	const dates = item.text.match(new RegExp(`${MON}\\s+\\d{1,2}`, 'gi')) ?? [];
	return found.every((e) => e.ends_at === null) && new Set(dates.map((d) => d.toLowerCase())).size > 2;
}

/* ---------- LLM fallback ---------- */

export const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SCHEMA = {
	type: 'object',
	properties: {
		events: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: ['season_start', 'season_end', 'event'] },
					name: { type: 'string' },
					starts_at: { type: 'string' },
					ends_at: { type: ['string', 'null'] }
				},
				required: ['kind', 'name', 'starts_at']
			}
		}
	},
	required: ['events']
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Manual validation of untrusted LLM output. */
export function validateLlm(raw: unknown, pub: Date): ExtractedEvent[] {
	if (!raw || typeof raw !== 'object') return [];
	const arr = (raw as { events?: unknown }).events;
	if (!Array.isArray(arr)) return [];
	const out: ExtractedEvent[] = [];
	for (const e of arr.slice(0, 5)) {
		if (!e || typeof e !== 'object') continue;
		const { kind, name, starts_at, ends_at } = e as Record<string, unknown>;
		if (kind !== 'season_start' && kind !== 'season_end' && kind !== 'event') continue;
		if (typeof name !== 'string' || !name.trim()) continue;
		if (typeof starts_at !== 'string' || !ISO.test(starts_at)) continue;
		const s = Date.parse(starts_at);
		if (isNaN(s) || Math.abs(s - pub.getTime()) > 366 * 86_400_000) continue;
		let end: string | null = null;
		if (typeof ends_at === 'string') {
			if (!ISO.test(ends_at)) continue;
			const en = Date.parse(ends_at);
			if (isNaN(en) || en < s || en - s > 366 * 86_400_000) continue;
			end = ends_at;
		}
		out.push({ kind, name: name.trim().slice(0, 120), starts_at, ends_at: end, raw_text: 'llm' });
	}
	return out;
}

export async function llmExtract(ai: Ai, item: FeedItem): Promise<ExtractedEvent[]> {
	const prompt =
		`Post published ${item.pubDate}. Title: ${item.title}\n\n${item.text}\n\n` +
		'Extract Overwatch season starts/ends and limited-time events with dates. ' +
		'Use UTC ISO 8601 like 2026-12-08T19:00:00Z. Return {"events":[]} if none stated.';
	try {
		const res = (await ai.run(MODEL as keyof AiModels, {
			messages: [
				{ role: 'system', content: 'You output only JSON matching the schema.' },
				{ role: 'user', content: prompt }
			],
			response_format: { type: 'json_schema', json_schema: SCHEMA },
			max_tokens: 400
		} as never)) as { response?: unknown };
		const r = res.response;
		const parsed = typeof r === 'string' ? JSON.parse(r) : r;
		return validateLlm(parsed, new Date(item.pubDate));
	} catch (err) {
		console.error('llm failed', err);
		return [];
	}
}

export async function extract(ai: Ai, item: FeedItem): Promise<ExtractedEvent[]> {
	if (!KEYWORD_GATE.test(item.title + ' ' + item.text)) return [];
	const found = regexExtract(item);
	if (!isAmbiguous(item, found)) return found;
	const viaLlm = await llmExtract(ai, item);
	return viaLlm.length ? viaLlm : found;
}
