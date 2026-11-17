/** Window gate. All wall-clock logic in America/Los_Angeles. */

const TZ = 'America/Los_Angeles';

const fmt = new Intl.DateTimeFormat('en-US', {
	timeZone: TZ,
	weekday: 'short',
	hourCycle: 'h23',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: 'numeric',
	minute: 'numeric'
});

export interface LaTime {
	weekday: string; // Mon..Sun
	date: string; // YYYY-MM-DD in LA
	hour: number;
	minute: number;
}

export function laTime(now: Date): LaTime {
	const o: Record<string, string> = {};
	for (const p of fmt.formatToParts(now)) o[p.type] = p.value;
	return {
		weekday: o.weekday,
		date: `${o.year}-${o.month}-${o.day}`,
		hour: Number(o.hour),
		minute: Number(o.minute)
	};
}

/** LA calendar date (YYYY-MM-DD) of a UTC ISO instant. */
export function laDate(iso: string): string {
	return laTime(new Date(iso)).date;
}

/** Cheap check using only the clock. `null` = defer to launch-day lookup. */
export function clockGate(now: Date): boolean | null {
	const t = laTime(now);
	const m = t.minute;
	if (t.weekday === 'Tue' && t.hour >= 9 && t.hour < 14) return m % 5 === 0;
	if (['Mon', 'Wed', 'Thu'].includes(t.weekday) && t.hour >= 9 && t.hour < 13) return m % 15 === 0;
	return null;
}

/** Once-daily slot for everything else. */
export function dailySlot(now: Date): boolean {
	const t = laTime(now);
	return t.hour === 9 && t.minute < 5;
}

/**
 * @param launchDates LA dates (YYYY-MM-DD) of season/event starts.
 * Launch day: every run (cron fires every 5 min) all day.
 */
export function shouldRun(now: Date, launchDates: string[]): boolean {
	const c = clockGate(now);
	if (c === true) return true;
	const t = laTime(now);
	if (launchDates.includes(t.date)) return true;
	if (c === false) return false;
	return dailySlot(now);
}
