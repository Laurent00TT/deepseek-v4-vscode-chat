// Tests for the reasoning cache and its assistant-turn fingerprint
// (src/reasoning_cache.ts) — the set-time vs get-time symmetry that
// issue #19 exposed as a coverage hole. The fingerprint computed over
// STREAMED output (ctx.emittedText / ctx.emittedToolCalls) must equal
// the fingerprint computed over the HOST-reconstructed history turn,
// or the turn's reasoning_content is unrecoverable and every later
// request eats a guaranteed cache miss.
//
// Imports the REAL implementation from compiled `out/reasoning_cache.js`.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { ReasoningCache, fingerprintAssistantTurn } from "../out/reasoning_cache.js";

let passed = 0;
let failed = 0;
function assertEq(label, got, expected) {
	if (got === expected) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.log(`  ✗ ${label}`);
		console.log(`      expected=${JSON.stringify(expected)}`);
		console.log(`      got     =${JSON.stringify(got)}`);
		failed++;
	}
}
function assertNeq(label, a, b) {
	if (a !== b) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.log(`  ✗ ${label} (both=${JSON.stringify(a)})`);
		failed++;
	}
}

console.log("Case 1: tc: branch — tool calls are the anchor, text is ignored");
{
	const tcs = [
		{ id: "call_abc", name: "read_file" },
		{ id: "call_def", name: "run_terminal" },
	];
	const a = fingerprintAssistantTurn({ text: "I'll read the file now.", toolCalls: tcs });
	const b = fingerprintAssistantTurn({ text: "TOTALLY DIFFERENT interleaved text", toolCalls: tcs });
	assertEq("same tool calls, different text → same fp", a, b);
	assertEq("tc: prefix used", a.startsWith("tc:"), true);

	const reversed = fingerprintAssistantTurn({ text: "", toolCalls: [tcs[1], tcs[0]] });
	assertEq("tool-call order does not matter (sorted)", reversed, a);

	const otherId = fingerprintAssistantTurn({
		text: "",
		toolCalls: [{ id: "call_abc", name: "read_file" }, { id: "call_XYZ", name: "run_terminal" }],
	});
	assertNeq("different call id → different fp", otherId, a);
}

console.log("");
console.log("Case 2: tx: branch — set-time vs get-time text symmetry");
{
	// Whitespace differences (streaming chunk boundaries, trailing newline
	// added by the host) must NOT change the key.
	const streamed = fingerprintAssistantTurn({ text: "The answer\nis  42.\n", toolCalls: [] });
	const fromHistory = fingerprintAssistantTurn({ text: " The answer is\t42. ", toolCalls: [] });
	assertEq("whitespace-only divergence → same fp", streamed, fromHistory);
	assertEq("tx: prefix used", streamed.startsWith("tx:"), true);

	// Unicode composed vs decomposed forms (NFKC).
	const composed = fingerprintAssistantTurn({ text: "café", toolCalls: [] });
	const decomposed = fingerprintAssistantTurn({ text: "café", toolCalls: [] });
	assertEq("NFKC: composed é == decomposed e+́", composed, decomposed);

	// Any character-level rewrite DOES change the key — this documents the
	// sensitivity that makes host-side history rewriting a miss source.
	const rewritten = fingerprintAssistantTurn({ text: "The answer is 43.", toolCalls: [] });
	assertNeq("real content divergence → different fp", rewritten, streamed);
}

console.log("");
console.log("Case 3: degenerate anchors");
{
	assertEq("no text, no tool calls → empty fp (unkeyable)", fingerprintAssistantTurn({ text: "", toolCalls: [] }), "");
	assertEq("whitespace-only text → empty fp", fingerprintAssistantTurn({ text: " \n\t ", toolCalls: [] }), "");
}

console.log("");
console.log("Case 4: tc:/tx: flip — the documented asymmetry behind side-request misses");
{
	// A turn STORED with its tool calls (stream time) can never be FOUND by
	// a request that re-renders the same turn as text only (e.g. Copilot
	// summarization). This is current-contract behaviour, locked down here
	// so any future change to it is a conscious one.
	const setTime = fingerprintAssistantTurn({
		text: "Let me check that.",
		toolCalls: [{ id: "call_1", name: "read_file" }],
	});
	const getTimeTextOnly = fingerprintAssistantTurn({ text: "Let me check that.", toolCalls: [] });
	assertNeq("tc-keyed turn re-rendered as text-only → different fp (guaranteed miss)", setTime, getTimeTextOnly);
}

console.log("");
console.log("Case 5: cache set/get round trip and stats");
{
	const cache = new ReasoningCache();
	const fp = fingerprintAssistantTurn({ text: "hello world", toolCalls: [] });
	cache.set(fp, "reasoning chain A");
	assertEq("round trip returns stored reasoning", cache.get(fp), "reasoning chain A");
	assertEq("unknown fp → undefined", cache.get("tx:deadbeef00000000"), undefined);
	assertEq("empty fp get → undefined (not counted)", cache.get(""), undefined);

	cache.set(fp, "reasoning chain A2");
	assertEq("same-fp set updates in place", cache.get(fp), "reasoning chain A2");
	assertEq("no duplicate entry after update", cache.size(), 1);

	cache.set("", "orphan");
	cache.set("tx:key", "");
	assertEq("empty fp / empty reasoning are no-ops", cache.size(), 1);

	// Hits: the round-trip get + the post-update get. The empty-fp get is
	// rejected before stats counting; the unknown-fp get is the one miss.
	const stats = cache.stats();
	assertEq("stats counts hits", stats.totalHits, 2);
	assertEq("stats counts misses", stats.totalMisses, 1);
}

console.log("");
console.log("Case 5b: countStats=false — auxiliary lookups stay out of the stats");
{
	const cache = new ReasoningCache();
	cache.set("tx:real", "R");
	cache.get("tx:real", false);        // aux hit — not counted
	cache.get("tx:absent", false);      // aux miss — not counted
	const stats = cache.stats();
	assertEq("aux lookups counted no gets", stats.totalGets, 0);
	assertEq("aux lookups counted no misses", stats.totalMisses, 0);
	assertEq("aux hit still returns the entry", cache.get("tx:real", false), "R");

	// The LRU bump DOES still happen for aux lookups — active-conversation
	// entries should stay fresh no matter who touches them.
	const bumped = new ReasoningCache(2);
	bumped.set("tx:a", "A");
	bumped.set("tx:b", "B");
	bumped.get("tx:a", false); // aux bump
	bumped.set("tx:c", "C");   // evicts tx:b, not the bumped tx:a
	assertEq("aux lookup still LRU-bumps", bumped.get("tx:a"), "A");
	assertEq("unbumped entry evicted instead", bumped.get("tx:b"), undefined);
}

console.log("");
console.log("Case 6: LRU order — get() bumps, eviction takes the oldest");
{
	const cache = new ReasoningCache(3);
	cache.set("tx:a", "A");
	cache.set("tx:b", "B");
	cache.set("tx:c", "C");
	// Bump the oldest so it survives the next eviction.
	cache.get("tx:a");
	cache.set("tx:d", "D");
	assertEq("bumped entry survives", cache.get("tx:a"), "A");
	assertEq("unbumped oldest was evicted", cache.get("tx:b"), undefined);
	assertEq("count cap holds", cache.size(), 3);
}

console.log("");
console.log("Case 7: byte-cap eviction can happen IN-SESSION (no restart needed)");
{
	const cache = new ReasoningCache(512);
	const oneMb = "x".repeat(1024 * 1024);
	const total = Math.floor(ReasoningCache.MAX_TOTAL_BYTES / oneMb.length) + 1; // one over the cap
	for (let i = 0; i < total; i++) {
		cache.set(`tx:entry${String(i).padStart(4, "0")}`, oneMb);
	}
	assertEq("oldest entry evicted by byte cap", cache.get("tx:entry0000"), undefined);
	assertEq("newest entry retained", cache.get(`tx:entry${String(total - 1).padStart(4, "0")}`), oneMb);
	assertEq("total stays under cap", cache.stats().totalBytes <= ReasoningCache.MAX_TOTAL_BYTES, true);
	assertEq("evictions counted", cache.stats().totalEvictions >= 1, true);
}

console.log("");
console.log("Case 8: restore() filters junk and re-enforces limits");
{
	const cache = new ReasoningCache(2);
	cache.restore([
		null,
		{ fingerprint: 42, reasoning: "bad" },
		{ fingerprint: "tx:a", reasoning: "A" },
		{ fingerprint: "tx:b", reasoning: "B" },
		{ fingerprint: "tx:c", reasoning: "C" },
	]);
	assertEq("truncated to maxSize keeping newest", cache.size(), 2);
	assertEq("oldest dropped on restore", cache.get("tx:a"), undefined);
	assertEq("newest kept on restore", cache.get("tx:c"), "C");
}

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
