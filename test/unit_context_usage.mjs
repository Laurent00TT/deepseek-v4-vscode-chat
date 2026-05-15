// Tests for the pure helpers in src/context_usage.ts. Covers the four
// invariants called out in the design doc:
//
//   1. updateFromApi overrides estimate-only `usedTokens`.
//   2. updateEstimate does NOT clobber API-reported values (same model).
//   3. clear (via undefined previous) resets to a clean slate.
//   4. Switching model variant drops stale API/estimate data.
//
// Imports the REAL implementations from compiled `out/context_usage.js`.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { snapshotFromEstimate, snapshotFromApi } from "../out/context_usage.js";

const NOW = 1_700_000_000_000;

// A representative model. Pro thinking budgets from src/provider.ts.
const PRO_THINKING = {
	modelId: "deepseek-v4-pro::thinking",
	modelDisplayName: "DeepSeek V4 Pro (thinking)",
	thinking: true,
	maxInputTokens: 655360,
	maxOutputTokens: 393216,
};

const PRO_FAST = {
	modelId: "deepseek-v4-pro",
	modelDisplayName: "DeepSeek V4 Pro",
	thinking: false,
	maxInputTokens: 983040,
	maxOutputTokens: 65536,
};

const TOTAL_WINDOW_THINKING = PRO_THINKING.maxInputTokens + PRO_THINKING.maxOutputTokens; // 1,048,576
const TOTAL_WINDOW_FAST = PRO_FAST.maxInputTokens + PRO_FAST.maxOutputTokens;             // 1,048,576

function assertEq(label, got, expected) {
	if (got === expected) {
		console.log(`  ✓ ${label}`);
		return true;
	}
	console.log(`  ✗ ${label}`);
	console.log(`      expected=${JSON.stringify(expected)}`);
	console.log(`      got     =${JSON.stringify(got)}`);
	return false;
}

function approxEq(got, expected, eps = 1e-6) {
	return Math.abs(got - expected) < eps;
}

let passed = 0;
let failed = 0;
function check(ok) {
	if (ok) passed++; else failed++;
}

// === Case 1: First estimate, no previous snapshot ===
console.log("Case 1: First estimate from empty state");
{
	const snap = snapshotFromEstimate(
		{ ...PRO_THINKING, estimatedPromptTokens: 50_000, estimatedToolTokens: 5_000 },
		undefined,
		NOW,
	);
	check(assertEq("modelId set", snap.modelId, PRO_THINKING.modelId));
	check(assertEq("apiPromptTokens still undefined", snap.apiPromptTokens, undefined));
	check(assertEq("usedTokens falls back to estimate", snap.usedTokens, 50_000));
	check(assertEq("percentage uses estimate over full window", approxEq(snap.percentage, 50_000 / TOTAL_WINDOW_THINKING), true));
	check(assertEq("updatedAt", snap.updatedAt, NOW));
}

// === Case 2: API value populates, then later estimate must NOT clobber it ===
console.log("");
console.log("Case 2: API value survives a later estimate on same model");
{
	const afterApi = snapshotFromApi(
		{
			...PRO_THINKING,
			apiPromptTokens: 73_402,
			apiCompletionTokens: 4_096,
			apiCacheHitTokens: 60_000,
			apiCacheMissTokens: 13_402,
			apiReasoningTokens: 2_048,
		},
		undefined,
		NOW,
	);
	check(assertEq("API usedTokens uses apiPromptTokens", afterApi.usedTokens, 73_402));
	check(assertEq("apiPromptTokens populated", afterApi.apiPromptTokens, 73_402));
	check(assertEq("apiCacheHitTokens populated", afterApi.apiCacheHitTokens, 60_000));

	const afterEstimate = snapshotFromEstimate(
		{ ...PRO_THINKING, estimatedPromptTokens: 5_000, estimatedToolTokens: 1_000 },
		afterApi,
		NOW + 1000,
	);
	check(assertEq("apiPromptTokens preserved across new estimate", afterEstimate.apiPromptTokens, 73_402));
	check(assertEq("apiCacheHitTokens preserved", afterEstimate.apiCacheHitTokens, 60_000));
	check(assertEq("estimate fields updated", afterEstimate.estimatedPromptTokens, 5_000));
	check(assertEq("usedTokens still uses API (authoritative)", afterEstimate.usedTokens, 73_402));
}

// === Case 3: Empty previous state (post-clear) ===
console.log("");
console.log("Case 3: Estimate after a clear");
{
	const snap = snapshotFromEstimate(
		{ ...PRO_THINKING, estimatedPromptTokens: 1_000, estimatedToolTokens: 0 },
		undefined, // simulates getSnapshot() after clear()
		NOW,
	);
	check(assertEq("no API fields after clear", snap.apiPromptTokens, undefined));
	check(assertEq("usedTokens is the fresh estimate", snap.usedTokens, 1_000));
}

// === Case 4: Switching model variant drops stale API values ===
console.log("");
console.log("Case 4: Model-variant switch invalidates prior API data");
{
	const onThinking = snapshotFromApi(
		{ ...PRO_THINKING, apiPromptTokens: 73_402, apiCompletionTokens: 4_096 },
		undefined,
		NOW,
	);

	// User flips to non-thinking variant; new estimate arrives.
	const afterSwitch = snapshotFromEstimate(
		{ ...PRO_FAST, estimatedPromptTokens: 10_000, estimatedToolTokens: 500 },
		onThinking,
		NOW + 1000,
	);
	check(assertEq("modelId switched", afterSwitch.modelId, PRO_FAST.modelId));
	check(assertEq("API tokens dropped on model switch", afterSwitch.apiPromptTokens, undefined));
	check(assertEq("estimatedPromptTokens reflects new variant", afterSwitch.estimatedPromptTokens, 10_000));
	check(assertEq("usedTokens falls back to new estimate", afterSwitch.usedTokens, 10_000));
	check(assertEq("maxInputTokens reflects new variant", afterSwitch.maxInputTokens, PRO_FAST.maxInputTokens));
	check(assertEq("percentage over new variant's window", approxEq(afterSwitch.percentage, 10_000 / TOTAL_WINDOW_FAST), true));
}

// === Case 5: snapshotFromApi over same model preserves prior estimate as breadcrumb ===
console.log("");
console.log("Case 5: API snapshot keeps prior same-model estimate as breadcrumb");
{
	const afterEst = snapshotFromEstimate(
		{ ...PRO_THINKING, estimatedPromptTokens: 12_345, estimatedToolTokens: 678 },
		undefined,
		NOW,
	);
	const afterApi = snapshotFromApi(
		{ ...PRO_THINKING, apiPromptTokens: 13_000, apiCompletionTokens: 500 },
		afterEst,
		NOW + 500,
	);
	check(assertEq("estimatedPromptTokens carried over", afterApi.estimatedPromptTokens, 12_345));
	check(assertEq("estimatedToolTokens carried over", afterApi.estimatedToolTokens, 678));
	check(assertEq("API values populated", afterApi.apiPromptTokens, 13_000));
	check(assertEq("usedTokens prefers API even when estimate exists", afterApi.usedTokens, 13_000));
}

// === Case 6: Cross-model API snapshot drops prior estimate ===
console.log("");
console.log("Case 6: API snapshot on different model drops prior estimate");
{
	const afterEstOnThinking = snapshotFromEstimate(
		{ ...PRO_THINKING, estimatedPromptTokens: 12_345, estimatedToolTokens: 678 },
		undefined,
		NOW,
	);
	const afterApiOnFast = snapshotFromApi(
		{ ...PRO_FAST, apiPromptTokens: 7_000, apiCompletionTokens: 100 },
		afterEstOnThinking,
		NOW + 500,
	);
	check(assertEq("estimate reset (different model)", afterApiOnFast.estimatedPromptTokens, 0));
	check(assertEq("API values are from new model", afterApiOnFast.apiPromptTokens, 7_000));
}

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
