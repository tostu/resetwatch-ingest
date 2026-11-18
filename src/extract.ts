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

/**
 * Cheap pre-filter before the LLM. Keywords, or an explicit month-day range
 * ("November 3-December 7"): some event posts ("Excavation Initiative") use none of the keywords.
 */
export function passesGate(item: FeedItem): boolean {
	const s = item.title + ' ' + item.text;
	return KEYWORD_GATE.test(s) || RANGE.test(s);
}

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
	if (!passesGate(item)) return [];
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

// Must support response_format json_schema (llama-3.1-8b-instruct-fp8 does not: error 5025).
export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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
					ends_at: { type: 'string' }
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
		if (typeof ends_at === 'string' && ISO.test(ends_at)) {
			// non-ISO ends_at ("", "null") skipped above -> treated as no end
			const en = Date.parse(ends_at);
			if (isNaN(en) || en < s || en - s > 366 * 86_400_000) continue;
			end = ends_at;
		}
		out.push({ kind, name: eventName(name), starts_at, ends_at: end, raw_text: 'llm' });
	}
	return out;
}

/* ---------- clef-flash gate ---------- */

export const CLEF_MODEL = '@cf/cloudflare/clef-flash';
/** Low on purpose: gate favors recall; llama + validateLlm reject false positives. */
export const CLEF_THRESHOLD = 0.2;

/** Does the post plausibly announce a dated season/event? Fails open (true) on any error. */
export async function clefGate(ai: Ai, item: FeedItem): Promise<boolean> {
	try {
		const res = (await ai.run(CLEF_MODEL as keyof AiModels, {
			model: 'clef-flash',
			state: `Published ${item.pubDate}\nTitle: ${item.title}\n\n${item.text.slice(0, 6000)}`,
			questions: {
				dated: {
					type: 'noul',
					instructions:
						'Does this Overwatch news post announce a season start/end or a limited-time event, challenge, or promotion that runs on specific dates?'
				}
			}
		} as never)) as { answers?: { dated?: { noul?: unknown } } };
		const p = res.answers?.dated?.noul;
		return typeof p === 'number' ? p >= CLEF_THRESHOLD : true;
	} catch (err) {
		console.error('clef gate failed, failing open', {
			message: err instanceof Error ? err.message : String(err)
		});
		return true;
	}
}

/** null = LLM call failed (retry later); [] = LLM ran and found nothing. */
export async function llmExtract(ai: Ai, item: FeedItem): Promise<ExtractedEvent[] | null> {
	const prompt =
		`Post published ${item.pubDate}. Title: ${item.title}\n\n${item.text.slice(0, 6000)}\n\n` +
		'Extract Overwatch season starts/ends and limited-time events with dates. ' +
		'Use UTC ISO 8601 like 2026-12-08T19:00:00Z. Return {"events":[]} if none stated. ' +
		'The "name" must be a short display title with no marketing filler: drop leading phrases like ' +
		'"Everything New in Overwatch", "Everything You Need to Know About", "Overwatch 2:", "Patch Notes:". ' +
		'Example: "Everything New in Overwatch Season 4: Heroes of Busan" -> "Season 4: Heroes of Busan".';
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
		console.error('llm failed', {
				model: MODEL,
				promptChars: prompt.length,
				message: err instanceof Error ? err.message : String(err)
			});
		return null;
	}
}

/**
 * Returns null when the post should be retried next run (LLM failed and regex found nothing).
 * Cheap keyword/range gate first; clef-flash only for posts that miss it.
 */
export async function extract(ai: Ai, item: FeedItem): Promise<ExtractedEvent[] | null> {
	const cheap = passesGate(item);
	if (!cheap && !(await clefGate(ai, item))) return [];
	// LLM first so names get cleaned; regex is the fallback.
	const viaLlm = await llmExtract(ai, item);
	if (viaLlm?.length) return viaLlm;
	const viaRegex = regexExtract(item); // gated internally
	if (viaLlm === null && viaRegex.length === 0) return null;
	return viaRegex;
}
