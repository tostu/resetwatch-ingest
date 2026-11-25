/**
 * Source: official Overwatch site (news articles + patch notes).
 * Both pages are server-rendered, so plain fetch + regex slicing is enough.
 */

export interface Section {
	/** `null` for the article intro (text before the first heading). */
	heading: string | null;
	text: string;
	/** Deep link to this section on the source page. */
	url: string;
}

export interface Post {
	/** Stable id: article URL, or `patch-notes#patch-YYYY-MM-DD`. */
	guid: string;
	url: string;
	title: string;
	pubDate: string; // ISO
	sections: Section[];
}

export interface PostRef {
	guid: string;
	url: string;
	title: string;
	pubDate: string;
}

export const ORIGIN = 'https://overwatch.blizzard.com';
const UA = 'resetwatch-ingest/2 (+https://resetwatch.tostu.net/about)';

export function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

export function stripHtml(s: string): string {
	return decodeEntities(
		s
			.replace(/<!\[CDATA\[|\]\]>/g, '')
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<[^>]*>/g, ' ')
	)
		.replace(/\s+/g, ' ')
		.trim();
}

const attr = (html: string, re: RegExp): string | null => {
	const m = html.match(re);
	return m ? decodeEntities(m[1]).trim() : null;
};

const isoOr = (s: string | null, fallback: string): string => {
	const t = s ? Date.parse(s) : NaN;
	return Number.isNaN(t) ? fallback : new Date(t).toISOString();
};

/** Scroll-to-text fragment: Blizzard headings have no ids. `-`, `&` and `,` must be escaped. */
export function textFragment(url: string, heading: string): string {
	const enc = encodeURIComponent(heading).replace(/-/g, '%2D').replace(/,/g, '%2C');
	return `${url}#:~:text=${enc}`;
}

/* ---------- News list ---------- */

/** Cards on /en-us/news/: link, heading, timestamp. Deduped by article id. */
export function parseNewsIndex(html: string): PostRef[] {
	const out: PostRef[] = [];
	const seen = new Set<string>();
	for (const chunk of html.split(/<a\s/).slice(1)) {
		const href = chunk.match(/^[^>]*href="((?:\/[a-z]{2}-[a-z]{2})?\/news\/(\d+)\/[^"#?]+)/);
		if (!href || seen.has(href[2])) continue;
		const close = chunk.indexOf('</a>');
		const card = close >= 0 ? chunk.slice(0, close) : chunk;
		const title =
			attr(card, /<h3[^>]*>([^<]+)</) ??
			attr(card, /headingtext="([^"]+)"/) ??
			attr(card, /slot="heading"[^>]*>([^<]+)</);
		const ts = attr(card, /timestamp="([^"]+)"/);
		if (!title || !ts) continue;
		seen.add(href[2]);
		const path = href[1].replace(/^\/[a-z]{2}-[a-z]{2}/, '');
		const url = `${ORIGIN}/en-us${path.replace(/\/$/, '')}`;
		out.push({ guid: url, url, title, pubDate: isoOr(ts, new Date().toISOString()) });
	}
	return out;
}

/* ---------- Article ---------- */

/** Split article body on <h2>. Intro (before first h2) gets `heading: null`. */
export function parseArticle(html: string, ref: PostRef): Post {
	const title = attr(html, /<meta property="og:title" content="([^"]*)"/) ?? ref.title;
	const pub = attr(html, /class="publish-date"[^>]*timestamp="([^"]+)"/);
	const start = html.search(/class="article-body"/);
	let body = start >= 0 ? html.slice(start) : '';
	const open = body.indexOf('<div slot="description">');
	if (open >= 0) body = body.slice(open + '<div slot="description">'.length);
	const end = body.indexOf('</blz-content-block>');
	if (end >= 0) body = body.slice(0, end);

	const sections: Section[] = [];
	const parts = body.split(/<h2[^>]*>/i);
	const intro = stripHtml(parts[0]);
	if (intro) sections.push({ heading: null, text: intro, url: ref.url });
	for (const p of parts.slice(1)) {
		const close = p.search(/<\/h2>/i);
		const heading = stripHtml(close >= 0 ? p.slice(0, close) : '');
		const text = stripHtml(close >= 0 ? p.slice(close) : p);
		if (!heading && !text) continue;
		sections.push({
			heading: heading || null,
			text,
			url: heading ? textFragment(ref.url, heading) : ref.url
		});
	}
	return { guid: ref.guid, url: ref.url, title, pubDate: isoOr(pub, ref.pubDate), sections };
}

/* ---------- Patch notes ---------- */

/**
 * One Post per patch (`id="patch-YYYY-MM-DD"`), newest first. Sections are the <h4> blocks
 * that carry a free-text description (events, modes); hero balance lists are skipped.
 */
export function parsePatchNotes(html: string, pageUrl: string, max = 4): Post[] {
	const out: Post[] = [];
	const chunks = html.split(/(?=id="patch-\d{4}-\d{2}-\d{2}")/).slice(1);
	for (const chunk of chunks.slice(0, max)) {
		const id = chunk.match(/^id="(patch-(\d{4}-\d{2}-\d{2}))"/);
		if (!id) continue;
		const url = `${pageUrl}#${id[1]}`;
		const title = attr(chunk, /class="PatchNotes-patchTitle">([^<]+)</) ?? `Patch Notes ${id[2]}`;
		const sections: Section[] = [];
		const re =
			/class="PatchNotes-sectionTitle">([^<]+)<\/h4>\s*<div class="PatchNotes-sectionDescription">([\s\S]*?)<\/div>/g;
		for (const m of chunk.matchAll(re)) {
			const text = stripHtml(m[2]);
			if (text) sections.push({ heading: decodeEntities(m[1]).trim(), text, url });
		}
		out.push({
			guid: `patch-notes#${id[1]}`,
			url,
			title,
			// Patch notes go live at the reset; noon UTC keeps the calendar date in every US zone.
			pubDate: `${id[2]}T12:00:00.000Z`,
			sections
		});
	}
	return out;
}

/* ---------- Fetch ---------- */

export async function fetchHtml(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: { 'User-Agent': UA, Accept: 'text/html' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`${url} ${res.status}`);
	return res.text();
}

/** Full plain text of a post, for validation (facts must appear in it). */
export function postText(p: Post): string {
	return p.sections.map((s) => (s.heading ? `${s.heading}. ${s.text}` : s.text)).join('\n');
}
