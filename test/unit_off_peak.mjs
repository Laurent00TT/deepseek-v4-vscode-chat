// Boundary tests for the DeepSeek V4 peak/off-peak window helpers (issue #22).
//
// Imports the REAL implementation from compiled `out/off_peak.js` rather
// than inlining a copy. This means the test will fail if anyone drifts
// the implementation away from the documented behaviour — no silent
// passing on stale inline copies.
//
//     npm run compile && node test/unit_off_peak.mjs
//
// `npm test` runs `npm run compile` automatically via the pretest hook.
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { isPeakTime, nextBoundary, offPeakWindowsUtc, formatWindowsLocal, PEAK_WINDOWS_UTC } from "../out/off_peak.js";

const failures = [];

function check(label, got, expected) {
	if (got !== expected) {
		failures.push(`  ✗ ${label}\n      expected=${expected} got=${got}`);
	}
}

// === isPeakTime: half-open [start, end) at every window edge ===
// Window under test (pinned): peak 01:00–04:00 and 06:00–10:00 UTC.
const peakCases = [
	["00:00:00Z off-peak", "2026-08-19T00:00:00Z", false],
	["00:59:59Z off-peak (last second before window 1)", "2026-08-19T00:59:59Z", false],
	["01:00:00Z peak (window 1 start inclusive)", "2026-08-19T01:00:00Z", true],
	["03:59:59Z peak (last second of window 1)", "2026-08-19T03:59:59Z", true],
	["04:00:00Z off-peak (window 1 end exclusive)", "2026-08-19T04:00:00Z", false],
	["05:00:00Z off-peak (gap between windows)", "2026-08-19T05:00:00Z", false],
	["06:00:00Z peak (window 2 start inclusive)", "2026-08-19T06:00:00Z", true],
	["09:59:59Z peak (last second of window 2)", "2026-08-19T09:59:59Z", true],
	["10:00:00Z off-peak (window 2 end exclusive)", "2026-08-19T10:00:00Z", false],
	["16:30:00Z off-peak (old V3/R1 discount window is NOT peak)", "2026-08-19T16:30:00Z", false],
	["23:59:59Z off-peak", "2026-08-19T23:59:59Z", false],
];
for (const [label, iso, expected] of peakCases) {
	check(`isPeakTime ${label}`, isPeakTime(new Date(iso)), expected);
}

// === nextBoundary: next window edge strictly after `date` ===
const boundaryCases = [
	["from 00:00 → 01:00 same day", "2026-08-19T00:00:00Z", "2026-08-19T01:00:00.000Z"],
	["from 02:30 → 04:00 (inside window 1)", "2026-08-19T02:30:00Z", "2026-08-19T04:00:00.000Z"],
	["from 05:00 → 06:00 (gap)", "2026-08-19T05:00:00Z", "2026-08-19T06:00:00.000Z"],
	["from 07:15 → 10:00 (inside window 2)", "2026-08-19T07:15:00Z", "2026-08-19T10:00:00.000Z"],
	["from 12:00 → 01:00 NEXT day (evening wrap)", "2026-08-19T12:00:00Z", "2026-08-20T01:00:00.000Z"],
	["exactly at 01:00 edge → 04:00 (strictly-after)", "2026-08-19T01:00:00.000Z", "2026-08-19T04:00:00.000Z"],
	["exactly at 10:00 edge → 01:00 NEXT day", "2026-08-19T10:00:00.000Z", "2026-08-20T01:00:00.000Z"],
	["sub-minute: 00:59:30 → 01:00 exact edge, not 01:00:30", "2026-08-19T00:59:30Z", "2026-08-19T01:00:00.000Z"],
	["sub-minute: 01:00:00.001 → 04:00 (already past edge)", "2026-08-19T01:00:00.001Z", "2026-08-19T04:00:00.000Z"],
	["month rollover: Aug 31 23:00 → Sep 1 01:00", "2026-08-31T23:00:00Z", "2026-09-01T01:00:00.000Z"],
];
for (const [label, iso, expectedIso] of boundaryCases) {
	check(`nextBoundary ${label}`, nextBoundary(new Date(iso)).toISOString(), expectedIso);
}

// === structural invariants the tooltip/timer logic relies on ===
// Every boundary genuinely flips the state (timer callbacks assume this),
// probing 1ms each side of every edge on an arbitrary day.
for (const [start, end] of PEAK_WINDOWS_UTC) {
	for (const edge of [start, end]) {
		const at = Date.UTC(2026, 7, 19) + edge * 60_000;
		check(
			`state flips across edge at minute ${edge}`,
			isPeakTime(new Date(at)) !== isPeakTime(new Date(at - 1)),
			true,
		);
	}
}
// nextBoundary is always in the strict future and at most 24h out.
for (const [, iso] of boundaryCases) {
	const d = new Date(iso);
	const delta = nextBoundary(d).getTime() - d.getTime();
	check(`nextBoundary(${iso}) strictly future`, delta > 0, true);
	check(`nextBoundary(${iso}) within 24h`, delta <= 24 * 60 * 60_000, true);
}

// === offPeakWindowsUtc: ring complement of the peak windows ===
check(
	"offPeakWindowsUtc shape (gaps incl. the midnight wrap)",
	JSON.stringify(offPeakWindowsUtc()),
	JSON.stringify([
		[240, 360],
		[600, 1500],
	]),
);
{
	// The two lists partition the day — the tooltip renders both, so a
	// drifted complement would show overlapping or missing hours.
	const peakLen = PEAK_WINDOWS_UTC.reduce((n, [s, e]) => n + (e - s), 0);
	const offLen = offPeakWindowsUtc().reduce((n, [s, e]) => n + (e - s), 0);
	check("peak + off-peak windows cover the full 24h ring", peakLen + offLen, 24 * 60);
}

// === formatWindowsLocal: local wall-clock rendering, sorted by local start ===
const fmtCases = [
	["peak @ UTC+0", PEAK_WINDOWS_UTC, 0, "01:00–04:00 · 06:00–10:00"],
	["off-peak @ UTC+0 (midnight wrap renders as-is)", offPeakWindowsUtc(), 0, "04:00–06:00 · 10:00–01:00"],
	["peak @ UTC+8 (CST)", PEAK_WINDOWS_UTC, 480, "09:00–12:00 · 14:00–18:00"],
	["off-peak @ UTC+8 (overnight range)", offPeakWindowsUtc(), 480, "12:00–14:00 · 18:00–09:00"],
	["peak @ UTC-5 re-sorts by local start", PEAK_WINDOWS_UTC, -300, "01:00–05:00 · 20:00–23:00"],
	["off-peak @ UTC-5 re-sorts, wrap range last", offPeakWindowsUtc(), -300, "05:00–20:00 · 23:00–01:00"],
	["peak @ UTC+5:30 keeps half-hour minutes", PEAK_WINDOWS_UTC, 330, "06:30–09:30 · 11:30–15:30"],
];
for (const [label, windows, offset, expected] of fmtCases) {
	check(`formatWindowsLocal ${label}`, formatWindowsLocal(windows, offset), expected);
}

const total =
	peakCases.length + boundaryCases.length + PEAK_WINDOWS_UTC.length * 2 + boundaryCases.length * 2 + 2 + fmtCases.length;
if (failures.length > 0) {
	console.error(`unit_off_peak: ${failures.length}/${total} FAILED`);
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(`unit_off_peak: all ${total} checks passed`);
