import { postText, type Post, type Section } from './feed';

export type Kind = 'season_start' | 'season_end' | 'event';

export interface Fact {
	label: string;
	value: string;
}

export interface ExtractedEvent {
	kind: Kind;
	name: string;
	starts_at: string; // UTC ISO
	ends_at: string | null;
	raw_text: string;
	/** One-sentence summary in our own words, or null. */
	summary: string | null;
	/** Key values stated in the source (reward counts, prices, ...). */
	facts: Fact[];
	/** Deep link to the section the event was found in. */
	source_url: string | null;
	source_title: string | null;
}

/** Minimal text unit the regex parser works on (one article section). */
export interface Snippet {
	title: string;
	text: string;
	pubDate: string;
}

export const KEYWORD_GATE = /season|now live|event|ends|starts|begins/i;

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MON = `(?:${MONTHS}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?`;
const RANGE = new RegExp(`(${MON})\\s+(\\d{1,2})\\s*(?:-|–|—|to)\\s*(?:(${MON})\\s+)?(\\d{1,2})`, 'i');
const SINGLE = new RegExp(`(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i');
/** US numeric range as used in patch notes: `11/19 - 11/23`, `11/3-12/7`. */
const SLASH_RANGE = /\b(\d{1,2})\/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\/(\d{1,2})\b/;

/**
 * Cheap pre-filter before the LLM. Keywords, or an explicit date range
 * ("November 3-December 7", "11/3-12/7"): some event posts use none of the keywords.
 */
export function passesGate(s: Snippet): boolean {
	const t = s.title + ' ' + s.text;
	return KEYWORD_GATE.test(t) || RANGE.test(t) || SLASH_RANGE.test(t);
}

/** Section mentions a concrete date at all (month name + day, or M/D). */
export function hasDate(text: string): boolean {
	return SINGLE.test(text) || SLASH_RANGE.test(text);
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

const noDetails = { summary: null, facts: [], source_url: null, source_title: null };

/** Regex-only extraction. Returns [] when nothing found. */
export function regexExtract(item: Snippet): ExtractedEvent[] {
	if (!passesGate(item)) return [];
	const pub = new Date(item.pubDate);
	const kind = classify(item.title);
	const name = eventName(item.title);
	const hour = kind === 'event' ? 17 : 19; // default UTC wall time; seasons 19:00Z
	const body = item.text;
	const range = (m1: number, d1: number, m2: number, d2: number, raw: string) => {
		if (m1 < 0 || m2 < 0 || m1 > 11 || m2 > 11 || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) return null;
		const y1 = resolveYear(m1, d1, pub);
		const y2 = m2 < m1 ? y1 + 1 : y1;
		return [
			{
				kind,
				name,
				starts_at: iso(y1, m1, d1, hour),
				ends_at: iso(y2, m2, d2, hour),
				raw_text: raw,
				...noDetails
			}
		];
	};

	const r = body.match(RANGE);
	if (r) {
		const m1 = monthIndex(r[1]);
		const hit = range(m1, Number(r[2]), r[3] ? monthIndex(r[3]) : m1, Number(r[4]), r[0]);
		if (hit) return hit;
	}
	const sl = body.match(SLASH_RANGE);
	if (sl) {
		const hit = range(Number(sl[1]) - 1, Number(sl[2]), Number(sl[3]) - 1, Number(sl[4]), sl[0]);
		if (hit) return hit;
	}
	const s = body.match(SINGLE);
	if (s) {
		const m = monthIndex(s[1]);
		const d = Number(s[2]);
		if (m >= 0 && d >= 1 && d <= 31) {
			const y = resolveYear(m, d, pub, s[3] ? Number(s[3]) : undefined);
			return [{ kind, name, starts_at: iso(y, m, d, hour), ends_at: null, raw_text: s[0], ...noDetails }];
		}
	}
	return [];
}

/* ---------- Sections sent to the model ---------- */

const MAX_PROMPT_TEXT = 9000;

/**
 * Sections worth sending: the intro (season launches often state "now live" there) plus every
 * section that names a date. Long undated lore sections are dropped to stay under the limit.
 */
export function datedSections(post: Post): { section: Section; index: number }[] {
	const out: { section: Section; index: number }[] = [];
	let used = 0;
	post.sections.forEach((section, index) => {
		if (index !== 0 && !hasDate(section.text)) return;
		const len = (section.heading?.length ?? 0) + section.text.length;
		if (used + len > MAX_PROMPT_TEXT) return;
		used += len;
		out.push({ section, index });
	});
	return out;
}

/* ---------- LLM ---------- */

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
					section: { type: 'integer' },
					kind: { type: 'string', enum: ['season_start', 'season_end', 'event'] },
					name: { type: 'string' },
					starts_at: { type: 'string' },
					ends_at: { type: 'string' },
					summary: { type: 'string' },
					facts: {
						type: 'array',
						items: {
							type: 'object',
							properties: { label: { type: 'string' }, value: { type: 'string' } },
							required: ['label', 'value']
						}
					}
				},
				required: ['section', 'kind', 'name', 'starts_at', 'summary', 'facts']
			}
		}
	},
	required: ['events']
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Model sometimes adds milliseconds (`...T19:00:00.000Z`): normalize, reject everything else. */
export function normIso(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.trim().replace(/\.\d{1,3}Z$/, 'Z');
	return ISO.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}
const MAX_FACTS = 4;

/** Numbers in a fact value (`1,000`, `24`) must appear verbatim in the source text. */
function factGrounded(value: string, source: string): boolean {
	const nums = value.match(/\d[\d,.]*\d|\d/g) ?? [];
	return nums.every((n) => source.includes(n));
}

/**
 * The day of a date must be written in the section ("December 7", "12/7", "3–7"): the model likes
 * to give open-ended releases ("arrives November 3") the season's end date, or to use the publish
 * date as a start. +-1 day for UTC shifts.
 */
export function dayGrounded(iso: string, text: string): boolean {
	const t = Date.parse(iso);
	return [-1, 0, 1].some((off) => {
		const date = new Date(t + off * 86_400_000);
		const d = date.getUTCDate();
		const m = date.getUTCMonth();
		const name = MONTHS.split('|')[m];
		const mon = `(?:${name}|${name.slice(0, 3)})\\.?`;
		const end = `${d}(?!\\d)(?:st|nd|rd|th)?`;
		return (
			new RegExp(`${mon}\\s+${end}`, 'i').test(text) || // December 7
			new RegExp(`(?<!\\d)${m + 1}/${end}`).test(text) || // 12/7
			new RegExp(`${mon}\\s+\\d{1,2}\\s*(?:-|–|—|to|through)\\s*${end}`, 'i').test(text) // December 3–7
		);
	});
}

function cleanSummary(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.replace(/\s+/g, ' ').trim();
	// Short ones are "Play for rewards": worse than nothing.
	if (s.length < 30 || s.split(' ').length < 6) return null;
	if (s.length <= 220) return s;
	const cut = s.slice(0, 217);
	return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function cleanFacts(v: unknown, source: string): Fact[] {
	if (!Array.isArray(v)) return [];
	const out: Fact[] = [];
	for (const f of v) {
		if (!f || typeof f !== 'object') continue;
		const { label, value } = f as Record<string, unknown>;
		if (typeof label !== 'string' || typeof value !== 'string') continue;
		const l = label.replace(/\s+/g, ' ').trim();
		const val = value.replace(/\s+/g, ' ').trim();
		if (!l || !val || l.length > 28 || val.length > 40) continue;
		if (!factGrounded(val, source)) continue;
		out.push({ label: l, value: val });
		if (out.length === MAX_FACTS) break;
	}
	return out;
}

const seasonNo = (s: string) => s.match(/season\s*(\d+)/i)?.[1];

/**
 * An undated start is only trusted on a season launch post ("Season 5: A Grim Doctrine ... live"),
 * published that day. Midcycle posts ("Season 4 Midcycle ...") mention the next season too, so a
 * season_start also needs the same season number as the post title.
 */
export function launchPost(post: Post, kind: Kind, name: string, start: number): boolean {
	if (Math.abs(start - Date.parse(post.pubDate)) > 1.5 * 86_400_000) return false;
	const n = seasonNo(post.title);
	if (!n || /mid-?cycle|mid-?season/i.test(post.title)) return false;
	return kind !== 'season_start' || seasonNo(name) === n;
}

/**
 * Manual validation of untrusted LLM output. `post` maps the section index to a source link
 * and grounds facts; without it (tests) details are dropped.
 */
export function validateLlm(raw: unknown, pub: Date, post?: Post): ExtractedEvent[] {
	if (!raw || typeof raw !== 'object') return [];
	const arr = (raw as { events?: unknown }).events;
	if (!Array.isArray(arr)) return [];
	const source = post ? postText(post) : '';
	const out: ExtractedEvent[] = [];
	for (const e of arr.slice(0, 8)) {
		if (!e || typeof e !== 'object') continue;
		const { kind, name, section, summary, facts } = e as Record<string, unknown>;
		if (kind !== 'season_start' && kind !== 'season_end' && kind !== 'event') continue;
		if (typeof name !== 'string' || !name.trim()) continue;
		const starts_at = normIso((e as Record<string, unknown>).starts_at);
		// non-ISO ends_at ("", "null") -> treated as no end
		const ends_at = normIso((e as Record<string, unknown>).ends_at);
		if (!starts_at) continue;
		const s = Date.parse(starts_at);
		if (Math.abs(s - pub.getTime()) > 366 * 86_400_000) continue;
		const sec =
			post && typeof section === 'number' && Number.isInteger(section) ? post.sections[section] : undefined;
		const secText = sec ? sec.text : source;
		if (post && !dayGrounded(starts_at, secText) && !launchPost(post, kind, name, s)) continue;
		let end: string | null = null;
		if (ends_at) {
			const en = Date.parse(ends_at);
			if (en < s || en - s > 366 * 86_400_000) continue;
			// Invented end date: keep the event, drop the end (it then shows no countdown).
			end = !post || dayGrounded(ends_at, secText) ? ends_at : null;
		}
		out.push({
			kind,
			name: eventName(name),
			starts_at,
			ends_at: end,
			raw_text: 'llm',
			summary: post ? cleanSummary(summary) : null,
			facts: post ? cleanFacts(facts, source) : [],
			source_url: post ? (sec?.url ?? post.url) : null,
			source_title: post ? post.title : null
		});
	}
	return out;
}

/* ---------- clef-flash gate ---------- */

export const CLEF_MODEL = '@cf/cloudflare/clef-flash';
/** Low on purpose: gate favors recall; llama + validateLlm reject false positives. */
export const CLEF_THRESHOLD = 0.2;

/** Does the post plausibly announce a dated season/event? Fails open (true) on any error. */
export async function clefGate(ai: Ai, post: Post): Promise<boolean> {
	try {
		const res = (await ai.run(CLEF_MODEL as keyof AiModels, {
			model: 'clef-flash',
			state: `Published ${post.pubDate}\nTitle: ${post.title}\n\n${postText(post).slice(0, 6000)}`,
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

export function buildPrompt(post: Post, picked: { section: Section; index: number }[]): string {
	const body = picked
		.map(({ section, index }) => `[${index}] ${section.heading ?? '(intro)'}\n${section.text}`)
		.join('\n\n');
	return (
		`Official Overwatch post published ${post.pubDate}. Title: ${post.title}\n\n${body}\n\n` +
		'Extract Overwatch season launches and limited-time events, challenges, drives, sales and ' +
		'collaborations that have stated dates. One entry per event. Skip single cosmetic releases ' +
		'(a new skin "arrives November 3") and anything without a stated date. ' +
		'Use kind "season_start" only for a season launch; use "season_end" only if the text states the ' +
		'date a season ends. ' +
		'"section" is the [number] of the section the event is described in. ' +
		'Use UTC ISO 8601 like 2026-12-08T19:00:00Z. If only a day is given, use 18:00:00Z. ' +
		'"ends_at" is the last day stated (e.g. "November 3 to December 7" -> 2026-12-07); ' +
		'leave it out when the text gives no end. ' +
		'The "name" is the event\'s own name, not the section heading, with no marketing filler: drop ' +
		'leading phrases like "Everything New in Overwatch", "Overwatch 2:", "Patch Notes:". ' +
		'Example: "Everything New in Overwatch Season 4: Heroes of Busan" -> "Season 4: Heroes of Busan". ' +
		'"summary": one factual sentence of 12 to 25 words in your own words, naming the specific ' +
		'activity and the specific rewards (skins, Loot Boxes, points). Do not copy sentences from the ' +
		'post. Good: "Win three digs each week for a Loot Box, and keep digging for Epic and Legendary ' +
		'Loot Boxes." Bad (too vague, too short): "Play for rewards." ' +
		'"facts": up to 4 key values stated explicitly in the text, as short label/value pairs, e.g. ' +
		'{"label":"Reward tiers","value":"24"}, {"label":"Premium pass","value":"1,000 Coins"}, ' +
		'{"label":"Loot Boxes","value":"Up to 9"}, {"label":"Bonus","value":"Double XP"}. ' +
		'Copy numbers exactly; never invent them. ' +
		'Return {"events":[]} if nothing dated is announced.'
	);
}

/** null = LLM call failed (retry later); [] = LLM ran and found nothing. */
export async function llmExtract(
	ai: Ai,
	post: Post,
	picked: { section: Section; index: number }[]
): Promise<ExtractedEvent[] | null> {
	const prompt = buildPrompt(post, picked);
	try {
		const res = (await ai.run(MODEL as keyof AiModels, {
			messages: [
				{ role: 'system', content: 'You output only JSON matching the schema.' },
				{ role: 'user', content: prompt }
			],
			response_format: { type: 'json_schema', json_schema: SCHEMA },
			max_tokens: 1500
		} as never)) as { response?: unknown };
		const r = res.response;
		const parsed = typeof r === 'string' ? JSON.parse(r) : r;
		return validateLlm(parsed, new Date(post.pubDate), post);
	} catch (err) {
		console.error('llm failed', {
			model: MODEL,
			promptChars: prompt.length,
			message: err instanceof Error ? err.message : String(err)
		});
		return null;
	}
}

/** Regex over each section separately, so names come from section headings. */
export function regexExtractPost(post: Post): ExtractedEvent[] {
	const out: ExtractedEvent[] = [];
	for (const s of post.sections) {
		const hits = regexExtract({ title: s.heading ?? post.title, text: s.text, pubDate: post.pubDate });
		for (const h of hits) out.push({ ...h, source_url: s.url, source_title: post.title });
	}
	return out;
}

/**
 * Returns null when the post should be retried next run (LLM failed and regex found nothing).
 * Cheap keyword/date gate first; clef-flash only for posts that miss it.
 */
export async function extract(ai: Ai, post: Post): Promise<ExtractedEvent[] | null> {
	const picked = datedSections(post);
	const cheap = post.sections.some((s) =>
		passesGate({ title: s.heading ?? post.title, text: s.text, pubDate: post.pubDate })
	);
	if (!cheap && !(await clefGate(ai, post))) return [];
	// LLM first so names get cleaned and details extracted; regex is the fallback.
	// Nothing dated but clef said yes: send the first sections and let the model judge.
	const input = picked.length
		? picked
		: post.sections.slice(0, 4).map((section, index) => ({ section, index }));
	const viaLlm = await llmExtract(ai, post, input);
	if (viaLlm?.length) return viaLlm;
	const viaRegex = regexExtractPost(post);
	if (viaLlm === null && viaRegex.length === 0) return null;
	return viaRegex;
}
