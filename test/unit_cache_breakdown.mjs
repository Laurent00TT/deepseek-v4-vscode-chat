// Truth-table test for shouldWarnCacheBreakdown causal-chain logic.
//
// Imports the REAL implementation from compiled `out/cache_breakdown.js`
// rather than inlining a copy. This means the test will fail if anyone
// drifts the implementation away from the documented behaviour — no
// silent passing on stale inline copies.
//
//     npm run compile && node test/unit_cache_breakdown.mjs
//
// `npm test` runs `npm run compile` automatically via the pretest hook.
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { shouldWarnCacheBreakdown } from "../out/cache_breakdown.js";

const now = Date.now();
const FRESH = undefined;
const RECENT = now - 60_000;         // 1 min ago — still throttled
const OLD = now - 6 * 60 * 1000;     // 6 min ago — throttle expired

const cases = [
	// [label, currHit, peakHit, reasoningMisses, lastWarn, expected]

	// === The canonical "should fire" case ===
	["canonical breakdown: peak 80% → curr 10%, 2 misses, no prior warn",
		0.10, 0.80, 2, FRESH, true],

	// === Throttle ===
	["throttle: same breakdown but warned 1 min ago",
		0.10, 0.80, 2, RECENT, false],
	["throttle expired: same breakdown, warned 6 min ago",
		0.10, 0.80, 2, OLD, true],

	// === Reasoning-cache-miss gate (causal chain) ===
	["no reasoning misses: hit drop alone shouldn't fire (could be model switch)",
		0.10, 0.80, 0, FRESH, false],
	["1 reasoning miss enough: just one is the causal signal",
		0.10, 0.80, 1, FRESH, true],

	// === Peak-hit gate (filter never-worked users) ===
	["peak never reached 70%: user's cache never really worked",
		0.10, 0.50, 5, FRESH, false],
	["peak exactly 70%: boundary inclusive",
		0.10, 0.70, 5, FRESH, true],
	["peak just under 70%: boundary exclusive",
		0.10, 0.6999, 5, FRESH, false],

	// === Current-hit gate (only fire on TRUE breakdown) ===
	["current 25%: degradation, not breakdown — too noisy to warn",
		0.25, 0.80, 5, FRESH, false],
	["current 20%: boundary inclusive",
		0.20, 0.80, 5, FRESH, true],
	["current 21%: boundary exclusive",
		0.21, 0.80, 5, FRESH, false],
	["current 0%: complete prefix loss",
		0.00, 0.95, 3, FRESH, true],

	// === Edge: first turn (peak=current=0)
	["first turn, no history at all",
		0.00, 0.00, 0, FRESH, false],
	["first turn with reasoning misses but no peak",
		0.00, 0.00, 3, FRESH, false],
];

let passed = 0;
let failed = 0;
const failures = [];

for (const [label, currHit, peakHit, misses, lastWarn, expected] of cases) {
	const got = shouldWarnCacheBreakdown(currHit, peakHit, misses, lastWarn);
	if (got === expected) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${expected} got=${got}\n      args: curr=${currHit} peak=${peakHit} misses=${misses} lastWarn=${lastWarn}`);
	}
}

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
	console.log("");
	console.log("Failures:");
	for (const f of failures) {
		console.log(f);
	}
	process.exit(1);
}
process.exit(0);
