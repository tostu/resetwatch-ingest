import { describe, expect, it } from 'vitest';
import {
	regexExtract,
	regexExtractPost,
	validateLlm,
	classify,
	extract,
	datedSections,
	dayGrounded,
	launchPost,
	CLEF_MODEL,
	MODEL
} from '../src/extract';
import { parseArticle, parseNewsIndex, parsePatchNotes, stripHtml, textFragment, type Post } from '../src/feed';
import { normName, sameEvent } from '../src/save';

const item = (title: string, text: string, pubDate: string) => ({ title, text, pubDate });
const post = (sections: { heading: string | null; text: string }[], pubDate = '2026-11-03T19:00:00Z'): Post => ({
	guid: 'https://overwatch.blizzard.com/en-us/news/1/x',
	url: 'https://overwatch.blizzard.com/en-us/news/1/x',
	title: 'Reign of Talon – Season 5: A Grim Doctrine',
	pubDate,
	sections: sections.map((s) => ({
		...s,
		url: s.heading ? textFragment('https://overwatch.blizzard.com/en-us/news/1/x', s.heading) : 'u'
	}))
});

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
	it('keywordless post with month range still extracts', () => {
		const [e] = regexExtract(
			item(
				'Excavation Initiative',
				'The Excavation Initiative is back with Loot Boxes. Start digging November 3-December 7.',
				'2026-11-03T20:00:44Z'
			)
		);
		expect(e.kind).toBe('event');
		expect(e.starts_at).toBe('2026-11-03T17:00:00Z');
		expect(e.ends_at).toBe('2026-12-07T17:00:00Z');
	});
	it('patch-notes slash range', () => {
		const [e] = regexExtract(
			item("Junkrat's Loot Hunt + Double XP Weekend", "Junkrat's Loot Hunt returns from 11/19 - 11/23 for a weekend.", '2026-11-03T12:00:00Z')
		);
		expect(e.starts_at).toBe('2026-11-19T17:00:00Z');
		expect(e.ends_at).toBe('2026-11-23T17:00:00Z');
	});
	it('no keywords -> none', () => {
		expect(regexExtract(item('Patch notes', 'Bug fixes on March 3', '2026-03-01T00:00:00Z'))).toEqual([]);
	});
	it('classify', () => {
		expect(classify('Season 5 ends')).toBe('season_end');
	});
	it('per-section regex names events after the heading and links the section', () => {
		const out = regexExtractPost(
			post([
				{ heading: null, text: 'Something wicked broke loose.' },
				{ heading: 'Drive Your Way', text: 'Quick Play and Competitive Drives run December 3–7.' }
			])
		);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('Drive Your Way');
		expect(out[0].source_url).toContain('#:~:text=Drive%20Your%20Way');
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
	it('accepts millisecond timestamps, normalized', () => {
		const [e] = validateLlm(
			{ events: [{ kind: 'event', name: 'X', starts_at: '2026-12-08T19:00:00.000Z', ends_at: '2026-12-15T19:00:00.000Z' }] },
			pub
		);
		expect(e.starts_at).toBe('2026-12-08T19:00:00Z');
		expect(e.ends_at).toBe('2026-12-15T19:00:00Z');
	});
	it('garbage in', () => {
		expect(validateLlm('x', pub)).toEqual([]);
	});
	it('maps section to deep link, keeps grounded facts, drops invented numbers', () => {
		const p = post([
			{ heading: null, text: 'Intro.' },
			{
				heading: 'An Eventful Reunion',
				text: 'The five-week event features 24 tiers of rewards. Upgrade the Event Pass for 1,000 Overwatch Coins. Runs November 3 to December 7.'
			}
		]);
		const [e] = validateLlm(
			{
				events: [
					{
						section: 1,
						kind: 'event',
						name: 'Taking Reign',
						starts_at: '2026-11-03T18:00:00Z',
						ends_at: '2026-12-07T18:00:00Z',
						summary: 'Five-week story event with a free and premium reward track.',
						facts: [
							{ label: 'Reward tiers', value: '24' },
							{ label: 'Event Pass', value: '1,000 Coins' },
							{ label: 'Loot Boxes', value: '50' },
							{ label: 'x', value: '' }
						]
					}
				]
			},
			new Date(p.pubDate),
			p
		);
		expect(e.source_url).toBe(
			'https://overwatch.blizzard.com/en-us/news/1/x#:~:text=An%20Eventful%20Reunion'
		);
		expect(e.source_title).toBe(p.title);
		expect(e.facts).toEqual([
			{ label: 'Reward tiers', value: '24' },
			{ label: 'Event Pass', value: '1,000 Coins' }
		]);
		expect(e.summary).toMatch(/^Five-week/);
	});
	it('falls back to the post url for a bad section index and trims long summaries', () => {
		const p = post([{ heading: null, text: 'x' }]);
		const [e] = validateLlm(
			{
				events: [
					{ section: 9, kind: 'event', name: 'X', starts_at: '2026-11-03T18:00:00Z', summary: 'word '.repeat(80) }
				]
			},
			new Date(p.pubDate),
			p
		);
		expect(e.source_url).toBe(p.url);
		expect(e.summary!.length).toBeLessThanOrEqual(220);
		expect(e.summary!.endsWith('…')).toBe(true);
	});
});

describe('dayGrounded', () => {
	it('accepts days written in the text', () => {
		expect(dayGrounded('2026-12-07T18:00:00Z', 'Runs November 3 to December 7.')).toBe(true);
		expect(dayGrounded('2026-12-07T18:00:00Z', 'Drives run December 3–7.')).toBe(true);
		expect(dayGrounded('2026-11-23T18:00:00Z', 'Returns from 11/19 - 11/23.')).toBe(true);
		expect(dayGrounded('2026-11-23T18:00:00Z', 'Loot Hunt returns November 20–23, but this time')).toBe(true);
	});
	it('rejects invented days', () => {
		expect(dayGrounded('2026-12-07T18:00:00Z', 'Mythic Roadhog arrives November 3. Level 1 to Level 4.')).toBe(false);
		expect(dayGrounded('2026-12-24T18:00:00Z', 'Earn 24 tiers of rewards from November 3.')).toBe(false);
		expect(dayGrounded('2026-12-03T18:00:00Z', 'Up to 3,000 Competitive Points.')).toBe(false);
		expect(dayGrounded('2026-09-04T18:00:00Z', 'Season 4 Midcycle. Unvaulted Passes arrive with Season 5.')).toBe(false);
	});
	it('launch post rule', () => {
		const p = post([{ heading: null, text: 'x' }], '2026-10-06T17:00:00Z');
		const at = Date.parse('2026-10-06T18:00:00Z');
		p.title = 'Feed Your Hunger in Reign of Talon – Season 5: A Grim Doctrine';
		expect(launchPost(p, 'season_start', 'Season 5: A Grim Doctrine', at)).toBe(true);
		expect(launchPost(p, 'season_start', 'Season 6', at)).toBe(false);
		p.title = 'Season 4 Midcycle Takes You To The BlizzCon Stage!';
		expect(launchPost(p, 'season_start', 'Season 5', at)).toBe(false);
		expect(launchPost(p, 'event', 'Team Drives', at)).toBe(false);
	});
	it('drops an event whose start is not in the text (not a launch post)', () => {
		const p = post([{ heading: 'Better Together', text: 'A 6v6 mini season comes with Season 6.' }], '2026-11-10T17:00:00Z');
		p.title = "Director's Take: 5v5 and 6v6";
		const out = validateLlm(
			{ events: [{ section: 0, kind: 'season_start', name: 'Season 6', starts_at: '2026-11-10T18:00:00Z' }] },
			new Date(p.pubDate),
			p
		);
		expect(out).toEqual([]);
	});
	it('drops an ungrounded end but keeps the event', () => {
		const p = post([{ heading: 'Hunger Without End', text: 'Mythic Roadhog arrives November 3.' }]);
		const [e] = validateLlm(
			{
				events: [
					{ section: 0, kind: 'event', name: 'Roadhog', starts_at: '2026-11-03T18:00:00Z', ends_at: '2026-12-07T18:00:00Z' }
				]
			},
			new Date(p.pubDate),
			p
		);
		expect(e.ends_at).toBeNull();
	});
});

describe('datedSections', () => {
	it('keeps intro and dated sections only', () => {
		const p = post([
			{ heading: null, text: 'Intro without date.' },
			{ heading: 'Lore', text: 'Long story, no dates.' },
			{ heading: 'Drives', text: 'Run December 3–7.' },
			{ heading: 'Hotfix', text: 'Returns 11/19 - 11/23.' }
		]);
		expect(datedSections(p).map((s) => s.index)).toEqual([0, 2, 3]);
	});
});

describe('extract gating', () => {
	type Handler = (model: string) => unknown;
	const fakeAi = (h: Handler) => {
		const calls: string[] = [];
		const ai = {
			run: async (model: string) => {
				calls.push(model);
				return h(model);
			}
		} as unknown as Ai;
		return { ai, calls };
	};
	const plain = post([{ heading: 'Loot Box news', text: 'Nothing dated here, just vibes.' }]);
	const llmOk = {
		response: {
			events: [{ section: 0, kind: 'event', name: 'X', starts_at: '2026-11-03T17:00:00Z', ends_at: null }]
		}
	};
	const winter = post([{ heading: 'Winter event', text: 'Runs December 16 - January 6.' }], '2026-12-10T00:00:00Z');

	it('clef says no -> [] without calling llama', async () => {
		const { ai, calls } = fakeAi(() => ({ answers: { dated: { type: 'noul', noul: 0.01 } } }));
		expect(await extract(ai, plain)).toEqual([]);
		expect(calls).toEqual([CLEF_MODEL]);
	});
	it('clef says yes -> llama result', async () => {
		const { ai, calls } = fakeAi((m) => (m === CLEF_MODEL ? { answers: { dated: { noul: 0.9 } } } : llmOk));
		expect(await extract(ai, plain)).toHaveLength(1);
		expect(calls).toEqual([CLEF_MODEL, MODEL]);
	});
	it('clef error fails open', async () => {
		const { ai, calls } = fakeAi((m) => {
			if (m === CLEF_MODEL) throw new Error('boom');
			return llmOk;
		});
		expect(await extract(ai, plain)).toHaveLength(1);
		expect(calls).toEqual([CLEF_MODEL, MODEL]);
	});
	it('keyword post skips clef', async () => {
		const { ai, calls } = fakeAi(() => llmOk);
		await extract(ai, winter);
		expect(calls).toEqual([MODEL]);
	});
	it('llama error + no regex hit -> null (retry)', async () => {
		const { ai } = fakeAi((m) => {
			if (m === CLEF_MODEL) return { answers: { dated: { noul: 0.9 } } };
			throw new Error('down');
		});
		expect(await extract(ai, plain)).toBeNull();
	});
	it('llama error but regex hits -> regex events', async () => {
		const { ai } = fakeAi(() => {
			throw new Error('down');
		});
		const r = await extract(ai, winter);
		expect(r).toHaveLength(1);
		expect(r![0].name).toBe('Winter event');
	});
});

describe('blizzard parsing', () => {
	const index = `<blz-gallery>
<a slot="gallery-items" href="/news/24303010/reign-of-talon-s5-midcycle-sets-up-the-showdown" target="_blank"><blz-card><h3 slot="heading">Reign of Talon &#8211; S5 Midcycle</h3><blz-timestamp slot="footer" timestamp="2026-11-03T19:00:00.000Z"></blz-timestamp></blz-card></a>
<a href="/news/24303010/reign-of-talon-s5-midcycle-sets-up-the-showdown"><blz-list-item headingtext="dup"><blz-timestamp timestamp="2026-11-03T19:00:00.000Z"></blz-timestamp></blz-list-item></a>
<a href="/en-us/news/24316733/directors-take"><blz-list-item headingtext="Director&#8217;s Take"><blz-timestamp timestamp="2026-11-10T17:00:00.000Z"></blz-timestamp></blz-list-item></a>
<a href="/en-us/news/patch-notes/">Patch notes</a>
</blz-gallery>`;
	it('news index: absolute en-us urls, decoded titles, deduped', () => {
		expect(parseNewsIndex(index)).toEqual([
			{
				guid: 'https://overwatch.blizzard.com/en-us/news/24303010/reign-of-talon-s5-midcycle-sets-up-the-showdown',
				url: 'https://overwatch.blizzard.com/en-us/news/24303010/reign-of-talon-s5-midcycle-sets-up-the-showdown',
				title: 'Reign of Talon – S5 Midcycle',
				pubDate: '2026-11-03T19:00:00.000Z'
			},
			{
				guid: 'https://overwatch.blizzard.com/en-us/news/24316733/directors-take',
				url: 'https://overwatch.blizzard.com/en-us/news/24316733/directors-take',
				title: 'Director’s Take',
				pubDate: '2026-11-10T17:00:00.000Z'
			}
		]);
	});

	const article = `<meta property="og:title" content="Reign of Talon &#8211; S5 Midcycle">
<blz-timestamp class="publish-date" timestamp="2026-11-03T19:00:00.000Z"></blz-timestamp>
<blz-content-block class="article-body"><div slot="description"><p>Something wicked.</p>
<h2>An Eventful Reunion</h2><p>Taking Reign runs from November 3 to December 7.<img src="x.png" /></p>
<h2>Drive Your Way</h2><p>Drives run December 3&#8211;7.</p>
</div></blz-content-block><div class="article-sidebar"><h2 slot="heading">Recent Articles</h2></div>`;
	it('article: sections split on h2, sidebar excluded, deep links', () => {
		const p = parseArticle(article, {
			guid: 'g',
			url: 'https://overwatch.blizzard.com/en-us/news/1/x',
			title: 'fallback',
			pubDate: '2026-01-01T00:00:00.000Z'
		});
		expect(p.title).toBe('Reign of Talon – S5 Midcycle');
		expect(p.pubDate).toBe('2026-11-03T19:00:00.000Z');
		expect(p.sections.map((s) => s.heading)).toEqual([null, 'An Eventful Reunion', 'Drive Your Way']);
		expect(p.sections[2].text).toBe('Drives run December 3–7.');
		expect(p.sections[1].url).toBe('https://overwatch.blizzard.com/en-us/news/1/x#:~:text=An%20Eventful%20Reunion');
	});

	const patch = `<div class="PatchNotes-list">
<div class="PatchNotes-patch" id="patch-2026-11-16"><h3 class="PatchNotes-patchTitle">Overwatch Retail Patch Notes – November 16, 2026</h3>
<div class="PatchNotes-section"><h4 class="PatchNotes-sectionTitle">Hotfix Update</h4><div class="PatchNotes-sectionDescription"><p>Fixed a bug.</p></div></div></div>
<div class="PatchNotes-patch" id="patch-2026-11-03"><h3 class="PatchNotes-patchTitle">Overwatch Retail Patch Notes – November 3, 2026</h3>
<div class="PatchNotes-section"><h4 class="PatchNotes-sectionTitle">Junkrat&#39;s Loot Hunt + Double XP Weekend</h4><div class="PatchNotes-sectionDescription"><p>Returns from 11/19 - 11/23.</p>
</div></div>
<div class="PatchNotes-section"><h4 class="PatchNotes-sectionTitle">Tank</h4><h5 class="PatchNotesHeroUpdate-name">Winston</h5></div></div></div>`;
	it('patch notes: one post per patch with anchored url and described sections', () => {
		const ps = parsePatchNotes(patch, 'https://overwatch.blizzard.com/en-us/news/patch-notes/');
		expect(ps.map((p) => p.guid)).toEqual(['patch-notes#patch-2026-11-16', 'patch-notes#patch-2026-11-03']);
		expect(ps[1].url).toBe('https://overwatch.blizzard.com/en-us/news/patch-notes/#patch-2026-11-03');
		expect(ps[1].sections).toEqual([
			{
				heading: "Junkrat's Loot Hunt + Double XP Weekend",
				text: 'Returns from 11/19 - 11/23.',
				url: 'https://overwatch.blizzard.com/en-us/news/patch-notes/#patch-2026-11-03'
			}
		]);
	});

	it('strip', () => expect(stripHtml('<p>a&nbsp;b &amp; c</p>')).toBe('a b & c'));
	it('text fragment escapes dashes and commas', () => {
		expect(textFragment('u', 'Drive-In, Now')).toBe('u#:~:text=Drive%2DIn%2C%20Now');
	});
});

describe('sameEvent', () => {
	const base = { kind: 'event', name: "Junkrat's Loot Hunt", starts_at: '2026-11-20T18:00:00Z', ends_at: '2026-11-23T18:00:00Z' };
	it('matches longer name and shifted dates from another source', () => {
		expect(
			sameEvent(base, {
				kind: 'event',
				name: "Junkrat's Loot Hunt + Double XP Weekend",
				starts_at: '2026-11-19T17:00:00Z',
				ends_at: '2026-11-23T17:00:00Z'
			})
		).toBe(true);
	});
	it('different event or far apart -> no match', () => {
		expect(sameEvent(base, { ...base, name: 'Junkrat Kart' })).toBe(false);
		expect(sameEvent(base, { ...base, starts_at: '2026-07-09T18:00:00Z', ends_at: '2026-07-12T18:00:00Z' })).toBe(false);
		expect(sameEvent(base, { ...base, kind: 'season_start' })).toBe(false);
	});
	it('seasons match by number', () => {
		expect(
			sameEvent(
				{ kind: 'season_start', name: 'Season 5: A Grim Doctrine', starts_at: '2026-10-06T18:00:00Z', ends_at: null },
				{ kind: 'season_start', name: 'Reign of Talon – Season 5', starts_at: '2026-10-06T19:00:00Z', ends_at: null }
			)
		).toBe(true);
	});
	it('normName', () => expect(normName('The Junkrat’s Loot Hunt + Double XP Weekend')).toBe('junkrats loot hunt double xp'));
});
