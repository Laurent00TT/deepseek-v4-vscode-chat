// Tests for DeepSeek's 128-tools-per-request cap: the pure guard
// `assertAdvertisedToolLimit`, the REAL skip-then-count path through
// `buildToolPayload`, and a best-effort text pin on the provider call site.
//
// The cap counts the ADVERTISED (wire) tool set — what is actually broadcast
// to the API — not the raw host list. Since the issue #20 wire-aliasing fix,
// tool assembly may skip unusable or colliding tools, so the host list can
// exceed 128 while the broadcast set is legal. Counting the host list (the
// pre-fix behavior in provider.ts) killed such requests for a violation that
// never reached the wire.
//
// Three layers of protection, strongest first:
//   1. TYPES — `assertAdvertisedToolLimit` takes the advertised
//      `OpenAIFunctionToolDef[]`, which is structurally incompatible with
//      VS Code's host tool list AND with a bare number, so feeding
//      `options.tools` (or any hand-computed count) is a COMPILE error.
//      Nothing here can test that; tsc enforces it on every build.
//   2. BEHAVIOR — section 3 runs the real headline scenario through
//      `buildToolPayload` (vscode-free): a 130-tool host list with 5
//      unusable names advertises 125 defs and passes the guard; 129 usable
//      names throw.
//   3. TEXT PIN (best-effort) — section 4 scans comment-stripped compiled
//      `out/provider.js` for "guard call present" and "no inline host-list
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
import { MAX_TOOLS_PER_REQUEST, assertAdvertisedToolLimit } from "../out/tool_limit.js";
import { buildToolPayload } from "../out/tool_payload.js";

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

function throwsWith(fn) {
	try {
		fn();
		return { threw: false, message: undefined };
	} catch (e) {
		return { threw: true, message: e instanceof Error ? e.message : String(e) };
	}
}

/** n minimal advertised tool defs, the shape the guard is typed against. */
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
// Changing it silently would desynchronize the guard from DeepSeek's API
// contract — must be a deliberate decision, not drift.
check("MAX_TOOLS_PER_REQUEST is 128", MAX_TOOLS_PER_REQUEST, 128);

// === 2. Guard boundary over advertised tool-def arrays ===
check("undefined (no tools advertised) passes", throwsWith(() => assertAdvertisedToolLimit(undefined)).threw, false);
check("empty array passes", throwsWith(() => assertAdvertisedToolLimit([])).threw, false);
check("1 advertised tool passes", throwsWith(() => assertAdvertisedToolLimit(mkAdvertised(1))).threw, false);
check(
	"exactly 128 advertised tools passes (cap is inclusive)",
	throwsWith(() => assertAdvertisedToolLimit(mkAdvertised(128))).threw,
	false,
);
const over = throwsWith(() => assertAdvertisedToolLimit(mkAdvertised(129)));
check("129 advertised tools throws", over.threw, true);
check("error message names the 128 cap", /128 tools/.test(over.message ?? ""), true);
check("far over the cap throws too", throwsWith(() => assertAdvertisedToolLimit(mkAdvertised(300))).threw, true);

// === 3. The real headline scenario, executed end to end ===
// Host list OVER the cap whose skips bring the advertised set back under it.
// 5 of 130 names are unusable (empty / non-string — the issue #20 skip
// class), so exactly 125 defs are advertised: a legal request the old
// `options.tools.length > 128` check killed.
const hostOverCap = [...mkHostTools(125), ...Array.from({ length: 5 }, () => ({ name: "", description: "" }))];
check("scenario premise: host list exceeds the cap", hostOverCap.length > MAX_TOOLS_PER_REQUEST, true);
const overCapRun = withCapturedSkipLogs(() => buildToolPayload(hostOverCap, false));
const payload = overCapRun.result;
check("5 unusable names are skipped → 125 advertised", payload.tools?.length, 125);
check("each skipped tool logged one diagnostic line", overCapRun.skipLogs, 5);
check(
	"over-cap host list with legal advertised set passes the guard",
	throwsWith(() => assertAdvertisedToolLimit(payload.tools)).threw,
	false,
);
// Counter-case: when the ADVERTISED set itself is over the cap, the guard
// still fires — skips don't grant amnesty to a genuinely oversized request.
const genuinelyOver = withCapturedSkipLogs(() =>
	buildToolPayload([...mkHostTools(129), { name: "", description: "" }], false),
).result;
check("129 usable of 130 → 129 advertised", genuinelyOver.tools?.length, 129);
check(
	"over-cap ADVERTISED set still throws",
	throwsWith(() => assertAdvertisedToolLimit(genuinelyOver.tools)).threw,
	true,
);
// The all-unusable degenerate: buildToolPayload returns {} (no tools key),
// and `undefined` passes the guard — a tool-less request is legal however
// large the host list was. Deliberate; see CHANGELOG.
const allUnusableRun = withCapturedSkipLogs(() => buildToolPayload(Array.from({ length: 130 }, () => ({ name: "" })), false));
check("all-unusable host list advertises nothing", allUnusableRun.result.tools, undefined);
check("all 130 unusable tools logged diagnostics", allUnusableRun.skipLogs, 130);
check(
	"tool-less payload passes the guard regardless of host size",
	throwsWith(() => assertAdvertisedToolLimit(allUnusableRun.result.tools)).threw,
	false,
);

// === 4. Best-effort text pin on the compiled provider call site ===
// Types can't force the guard call to EXIST in provider.ts, and provider.ts
// can't be imported here (it needs the runtime `vscode` module). So scan the
// compiled text for the two properties types can't give us: the guard is
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
check("provider calls the guard (live code, comments stripped)", providerJs.includes("assertAdvertisedToolLimit"), true);
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
