// Tests for the 128-tools-per-request cap: the pure trim
// `capAdvertisedTools`, the REAL skip-then-cap path through
// `buildToolPayload`, and a best-effort text pin on the provider call site.
//
// The cap counts the ADVERTISED (wire) tool set — what is actually broadcast
// to the API — not the raw host list. Since the issue #20 wire-aliasing fix,
// tool assembly may skip unusable or colliding tools, so the host list can
// exceed 128 while the broadcast set is legal.
//
// Over the cap the set is TRIMMED instead of failing the request (issue #27:
// VS Code 1.140's agent host forwarded every tool to BYOK models and retried
// the thrown error as a 502, so the chat never worked). Tools the history
// already called are kept first, then the host's order, and the kept tools
// stay in their original order — the same policy as VS Code 1.141's own BYOK
// cap (`capBridgeTools`).
//
// Three layers of protection, strongest first:
//   1. TYPES — `capAdvertisedTools` takes the advertised
//      `OpenAIFunctionToolDef[]`, which is structurally incompatible with
//      VS Code's host tool list AND with a bare number, so feeding
//      `options.tools` (or any hand-computed count) is a COMPILE error.
//      Nothing here can test that; tsc enforces it on every build.
//   2. BEHAVIOR — sections 2–4 pin the trim policy and run the real
//      headline scenario through `buildToolPayload` (vscode-free): a
//      130-tool host list with 5 unusable names advertises 125 defs and is
//      sent untouched; 129 usable names are trimmed to 128.
//   3. TEXT PIN (best-effort) — section 5 scans comment-stripped compiled
//      `out/provider.js` for "cap call present" and "no inline host-list
//      count check". Types can't force a call to EXIST, so this is
//      defense-in-depth against deleting the call or re-adding a host-list
//      pre-check. It is deliberately minimal and NOT a guarantee: a
//      determined-enough respelling can evade a text scan.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { readFileSync } from "node:fs";
import { MAX_TOOLS_PER_REQUEST, capAdvertisedTools } from "../out/tool_limit.js";
import { buildToolPayload } from "../out/tool_payload.js";
import { fitToolChoiceToThinking } from "../out/tool_choice.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	const ok = Object.is(got, expected);
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
	}
}

/** n minimal advertised tool defs, the shape the cap is typed against. */
function mkAdvertised(n) {
	return Array.from({ length: n }, (_, i) => ({
		type: "function",
		function: { name: `tool_${i}`, description: "", parameters: { type: "object", properties: {} } },
	}));
}

/** n host tool descriptors with usable names. */
function mkHostTools(n, prefix = "host_tool") {
	return Array.from({ length: n }, (_, i) => ({
		name: `${prefix}_${i}`,
		description: "",
		inputSchema: { type: "object", properties: {} },
	}));
}

const names = (defs) => (defs ?? []).map((d) => d.function.name).join(",");
const NO_CALLS = new Set();

/**
 * Run fn with console.error captured: buildToolPayload logs one line per
 * skipped tool, which would otherwise drown the test output. Returns the
 * result plus the number of skip logs, so the diagnostic behavior is pinned
 * instead of merely silenced.
 */
function withCapturedSkipLogs(fn) {
	const original = console.error;
	let skipLogs = 0;
	console.error = () => {
		skipLogs++;
	};
	try {
		return { result: fn(), skipLogs };
	} finally {
		console.error = original;
	}
}

// === 1. The cap itself is pinned ===
// 128 is a compatibility budget (see tool_limit.ts) — changing it must be a
// deliberate decision checked against the live API, not drift.
check("MAX_TOOLS_PER_REQUEST is 128", MAX_TOOLS_PER_REQUEST, 128);

// === 2. At or under the cap the advertised set passes through untouched ===
const none = capAdvertisedTools(undefined, NO_CALLS);
check("undefined (no tools advertised) stays undefined", none.tools, undefined);
check("…and drops nothing", none.dropped.length, 0);
const empty = [];
check("empty array passes through as-is", capAdvertisedTools(empty, NO_CALLS).tools, empty);
const atCap = mkAdvertised(128);
const atCapRun = capAdvertisedTools(atCap, NO_CALLS);
check("exactly 128 passes through as the same array (cap is inclusive)", atCapRun.tools, atCap);
check("…and drops nothing", atCapRun.dropped.length, 0);

// === 3. Over the cap: trim, never throw ===
const over = mkAdvertised(129);
const overRun = capAdvertisedTools(over, NO_CALLS);
check("129 advertised → 128 sent", overRun.tools.length, 128);
check("…the host's first 128, in order", names(overRun.tools), names(over.slice(0, 128)));
check("…the last one is reported dropped", overRun.dropped.join(","), "tool_128");
check("input array is not mutated", over.length, 129);
const farOverRun = capAdvertisedTools(mkAdvertised(300), NO_CALLS);
check("far over the cap → 128 sent", farOverRun.tools.length, 128);
check("…172 dropped", farOverRun.dropped.length, 172);
// Called tools are kept even when they sit past the cut: a plain first-128
// slice would drop tool_129, which the conversation is actively using.
const calledRun = capAdvertisedTools(mkAdvertised(130), new Set(["tool_129", "tool_5"]));
check("called tools still 128 sent", calledRun.tools.length, 128);
check("a called tool past the cut is kept", calledRun.tools.at(-1)?.function.name, "tool_129");
check("kept tools stay in advertised order", calledRun.tools[0]?.function.name, "tool_0");
check("the budget it takes comes off the uncalled tail", calledRun.dropped.join(","), "tool_127,tool_128");
check(
	"called names that aren't advertised change nothing",
	capAdvertisedTools(over, new Set(["no_such_tool"])).dropped.join(","),
	"tool_128",
);

// === 4. The real headline scenario, executed end to end ===
// Host list OVER the cap whose skips bring the advertised set back under it.
// 5 of 130 names are unusable (empty / non-string — the issue #20 skip
// class), so exactly 125 defs are advertised and sent untouched.
const hostOverCap = [...mkHostTools(125), ...Array.from({ length: 5 }, () => ({ name: "", description: "" }))];
check("scenario premise: host list exceeds the cap", hostOverCap.length > MAX_TOOLS_PER_REQUEST, true);
const overCapRun = withCapturedSkipLogs(() => buildToolPayload(hostOverCap, false));
const payload = overCapRun.result;
check("5 unusable names are skipped → 125 advertised", payload.tools?.length, 125);
check("each skipped tool logged one diagnostic line", overCapRun.skipLogs, 5);
const legalRun = capAdvertisedTools(payload.tools, NO_CALLS);
check("over-cap host list with legal advertised set is sent untouched", legalRun.tools, payload.tools);
check("…nothing dropped", legalRun.dropped.length, 0);
// When the ADVERTISED set itself is over the cap, it is trimmed — skips
// don't grant amnesty to a genuinely oversized request.
const genuinelyOver = withCapturedSkipLogs(() =>
	buildToolPayload([...mkHostTools(129), { name: "", description: "" }], true),
).result;
check("129 usable of 130 → 129 advertised", genuinelyOver.tools?.length, 129);
const trimmed = capAdvertisedTools(genuinelyOver.tools, NO_CALLS);
check("over-cap ADVERTISED set is trimmed to 128", trimmed.tools.length, 128);
check("…dropping the host's last tool", trimmed.dropped.join(","), "host_tool_128");
// tool_choice is resolved before the cap; a multi-tool "required" stays
// valid for the trimmed set (a named force only exists for exactly 1 tool).
// On a thinking variant the provider then relaxes it to "auto" — thinking
// mode rejects any forced choice (see unit_tool_choice) — valid for any set.
check("Required mode over the cap resolves to the multi-tool literal", genuinelyOver.tool_choice, "required");
check("…which a thinking variant relaxes to 'auto'", fitToolChoiceToThinking(genuinelyOver.tool_choice, true).tool_choice, "auto");
// The all-unusable degenerate: buildToolPayload returns {} (no tools key),
// and `undefined` passes the cap — a tool-less request is legal however
// large the host list was. Deliberate; see CHANGELOG.
const allUnusableRun = withCapturedSkipLogs(() => buildToolPayload(Array.from({ length: 130 }, () => ({ name: "" })), false));
check("all-unusable host list advertises nothing", allUnusableRun.result.tools, undefined);
check("all 130 unusable tools logged diagnostics", allUnusableRun.skipLogs, 130);
check(
	"tool-less payload passes the cap regardless of host size",
	capAdvertisedTools(allUnusableRun.result.tools, NO_CALLS).tools,
	undefined,
);

// === 5. Best-effort text pin on the compiled provider call site ===
// Types can't force the cap call to EXIST in provider.ts, and provider.ts
// can't be imported here (it needs the runtime `vscode` module). So scan the
// compiled text for the two properties types can't give us: the cap is
// called, and no inline host-list count check has crept back. Comments are
// stripped first so prose mentioning either pattern can neither satisfy nor
// trip the pin (tsc preserves comments; a commented-out call must not count).
// Best-effort by design — the load-bearing protections are layers 1 and 2.
function stripComments(src) {
	let out = "";
	let mode = "code"; // code | line | block | sq | dq | tpl
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		const n = src[i + 1];
		if (mode === "code") {
			if (c === "/" && n === "/") {
				mode = "line";
				i++;
			} else if (c === "/" && n === "*") {
				mode = "block";
				i++;
			} else {
				if (c === "'") mode = "sq";
				else if (c === '"') mode = "dq";
				else if (c === "`") mode = "tpl";
				out += c;
			}
		} else if (mode === "line") {
			if (c === "\n") {
				mode = "code";
				out += c;
			}
		} else if (mode === "block") {
			if (c === "*" && n === "/") {
				mode = "code";
				i++;
			}
		} else {
			out += c;
			if (c === "\\") {
				out += n ?? "";
				i++;
			} else if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
				mode = "code";
			}
		}
	}
	return out;
}

const providerJs = stripComments(readFileSync(new URL("../out/provider.js", import.meta.url), "utf8"));
check("provider calls the cap (live code, comments stripped)", providerJs.includes("capAdvertisedTools"), true);
// Catches the natural respellings of the old bug in one shape family:
// `options.tools….length … >` — covers `options.tools.length > 128`,
// `options.tools?.length ?? 0) > MAX_TOOLS_PER_REQUEST`,
// `(options.tools ?? []).length >= 129`, etc.
check(
	"no inline host-list count check in live code",
	/options\.tools[^;\n]{0,40}\.length[^;\n]{0,20}>/.test(providerJs),
	false,
);

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
