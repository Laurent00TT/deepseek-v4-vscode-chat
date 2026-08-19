/**
 * Pure helpers: DeepSeek V4 peak / off-peak billing window (issue #22).
 * Lives in its own file (zero vscode dependency) so the unit test can
 * import it via Node ESM without mocking VS Code.
 *
 * DeepSeek switched V4 Flash / V4 Pro to time-of-day billing at
 * 2026-08-16 16:00 UTC: peak hours are 01:00–04:00 and 06:00–10:00 UTC
 * daily; every other hour is off-peak.
 *
 * Only the WINDOW is encoded here — never prices or multipliers. Prices
 * drift (see the session-cost rationale in provider.ts) and the real bill
 * is always taken from /user/balance; this module exists purely so the
 * status-bar tooltip can tell the user which side of the boundary the
 * system clock is on right now.
 */

/** Peak windows as [startMinute, endMinute) since UTC midnight. Must be
 * sorted, non-overlapping, non-wrapping (a window that crosses midnight
 * would need to be split into two entries). */
export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
	[1 * 60, 4 * 60], // 01:00–04:00 UTC
	[6 * 60, 10 * 60], // 06:00–10:00 UTC
];

const MINUTES_PER_DAY = 24 * 60;

function minuteOfUtcDay(date: Date): number {
	return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** True when `date` falls inside a peak window. Boundaries follow the
 * half-open convention: peak starts exactly AT the start minute and ends
 * exactly AT the end minute (04:00:00 is already off-peak). */
export function isPeakTime(date: Date): boolean {
	const m = minuteOfUtcDay(date);
	return PEAK_WINDOWS_UTC.some(([start, end]) => m >= start && m < end);
}

/**
 * The next UTC instant at which the peak/off-peak state flips — i.e. the
 * next window edge strictly after `date`. Always within the next 24h.
 * Sub-minute precision is intentional: called at second N of a minute it
 * still returns the exact :00 edge, so a timer armed with
 * `nextBoundary(now) - now` fires at the flip, not up to 59s late.
 */
export function nextBoundary(date: Date): Date {
	const edges = PEAK_WINDOWS_UTC.flatMap(([start, end]) => [start, end]);
	const msIntoMinute = date.getUTCSeconds() * 1000 + date.getUTCMilliseconds();
	const m = minuteOfUtcDay(date) + msIntoMinute / 60_000;
	const nextEdge = edges.find((edge) => edge > m);
	const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	return nextEdge !== undefined
		? new Date(utcMidnight + nextEdge * 60_000)
		: new Date(utcMidnight + (MINUTES_PER_DAY + edges[0]) * 60_000);
}
