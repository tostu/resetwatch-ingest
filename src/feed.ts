export interface FeedItem {
	guid: string;
	title: string;
	pubDate: string; // ISO
	text: string; // stripped, truncated
}

const MAX_TEXT = 4000;

export function extractGuids(xml: string): string[] {
	return [...xml.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)].map((m) => m[1].trim());
}

export function stripHtml(s: string): string {
	return s
		.replace(/<!\[CDATA\[|\]\]>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function tag(item: string, name: string): string {
	const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
	return m ? m[1] : '';
}

/** Slice one <item> by guid. */
export function itemFor(xml: string, guid: string): FeedItem | null {
	const items = xml.split(/<item[\s>]/).slice(1);
	const raw = items.find((i) => extractGuids(i)[0] === guid);
	if (!raw) return null;
	const pub = new Date(stripHtml(tag(raw, 'pubDate')));
	return {
		guid,
		title: stripHtml(tag(raw, 'title')),
		pubDate: isNaN(pub.getTime()) ? new Date().toISOString() : pub.toISOString(),
		text: stripHtml(tag(raw, 'description')).slice(0, MAX_TEXT)
	};
}

export type FetchResult = { status: 'unchanged' } | { status: 'ok'; xml: string; etag: string | null };

export async function fetchFeed(url: string, etag: string | null): Promise<FetchResult> {
	const res = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {} });
	if (res.status === 304) return { status: 'unchanged' };
	if (!res.ok) throw new Error(`feed ${res.status}`);
	return { status: 'ok', xml: await res.text(), etag: res.headers.get('etag') };
}
