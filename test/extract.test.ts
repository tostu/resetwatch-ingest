import { describe, expect, it } from 'vitest';
import { regexExtract, validateLlm, classify } from '../src/extract';
import { extractGuids, itemFor, stripHtml } from '../src/feed';

const item = (title: string, text: string, pubDate: string) => ({ guid: 'g', title, text, pubDate });

describe('regexExtract', () => {
	it('range with year rollover', () => {
		const [e] = regexExtract(item('Winter Wonderland event', 'Runs December 16 - January 6.', '2026-12-10T00:00:00Z'));
		expect(e.kind).toBe('event');
		expect(e.starts_at.startsWith('2026-12-16')).toBe(true);
		expect(e.ends_at?.startsWith('2027-01-06')).toBe(true);
	});
	it('season start single date', () => {
		const [e] = regexExtract(item('Season 6 now live', 'Starts December 8.', '2026-12-01T00:00:00Z'));
		expect(e.kind).toBe('season_start');
		expect(e.starts_at).toBe('2026-12-08T19:00:00Z');
	});
	it('no keywords -> none', () => {
		expect(regexExtract(item('Patch notes', 'Bug fixes on March 3', '2026-03-01T00:00:00Z'))).toEqual([]);
	});
	it('classify', () => {
		expect(classify('Season 5 ends')).toBe('season_end');
	});
});

describe('validateLlm', () => {
	const pub = new Date('2026-12-01T00:00:00Z');
	it('accepts valid', () => {
		const r = validateLlm(
			{ events: [{ kind: 'event', name: 'X', starts_at: '2026-12-08T19:00:00Z', ends_at: null }] },
			pub
		);
		expect(r).toHaveLength(1);
	});
	it('rejects bad kind, bad date, end<start, far year', () => {
		const bad = [
			{ kind: 'nope', name: 'a', starts_at: '2026-12-08T19:00:00Z' },
			{ kind: 'event', name: 'a', starts_at: 'Dec 8' },
			{ kind: 'event', name: 'a', starts_at: '2026-12-08T19:00:00Z', ends_at: '2026-12-01T19:00:00Z' },
			{ kind: 'event', name: 'a', starts_at: '2030-12-08T19:00:00Z' }
		];
		expect(validateLlm({ events: bad }, pub)).toEqual([]);
	});
	it('garbage in', () => {
		expect(validateLlm('x', pub)).toEqual([]);
	});
});

describe('feed', () => {
	const xml = `<rss><channel>
<item><title>A &amp; B</title><guid isPermaLink="false">1</guid><pubDate>Tue, 01 Dec 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Hi <b>there</b></p>]]></description></item>
<item><title>C</title><guid>2</guid><pubDate>Tue, 02 Dec 2026 10:00:00 GMT</pubDate><description>x</description></item>
</channel></rss>`;
	it('guids', () => expect(extractGuids(xml)).toEqual(['1', '2']));
	it('item slice', () => {
		const i = itemFor(xml, '1');
		expect(i?.title).toBe('A & B');
		expect(i?.text).toBe('Hi there');
		expect(i?.pubDate).toBe('2026-12-01T10:00:00.000Z');
	});
	it('strip', () => expect(stripHtml('<p>a&nbsp;b</p>')).toBe('a b'));
});
