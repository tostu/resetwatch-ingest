import { describe, expect, it } from 'vitest';
import { shouldRun } from '../src/schedule';

// 2026-11-17 is a Tuesday. LA is PST (UTC-8) => 09:00 LA = 17:00Z.
describe('shouldRun', () => {
	it('Tue 09:05 LA runs', () => {
		expect(shouldRun(new Date('2026-11-17T17:05:00Z'), [])).toBe(true);
	});
	it('Tue 14:00 LA falls to daily slot (no)', () => {
		expect(shouldRun(new Date('2026-11-17T22:00:00Z'), [])).toBe(false);
	});
	it('Wed 09:15 runs, 09:05 does not', () => {
		expect(shouldRun(new Date('2026-11-18T17:15:00Z'), [])).toBe(true);
		expect(shouldRun(new Date('2026-11-18T17:05:00Z'), [])).toBe(false);
	});
	it('Sat only once at 09:00', () => {
		expect(shouldRun(new Date('2026-11-21T17:00:00Z'), [])).toBe(true);
		expect(shouldRun(new Date('2026-11-21T17:05:00Z'), [])).toBe(false);
		expect(shouldRun(new Date('2026-11-21T03:00:00Z'), [])).toBe(false);
	});
	it('launch day runs all day', () => {
		expect(shouldRun(new Date('2026-11-21T03:05:00Z'), ['2026-11-20'])).toBe(true);
	});
	it('handles DST (PDT in summer: 09:00 LA = 16:00Z)', () => {
		expect(shouldRun(new Date('2026-07-14T16:05:00Z'), [])).toBe(true);
	});
});
