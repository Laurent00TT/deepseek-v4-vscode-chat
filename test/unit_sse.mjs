// First unit coverage of the SSE protocol logic (src/sse.ts) — the
// highest-churn path in the extension (issues #19/#20 and several 0.3.x
// fixes all landed here). Extracted from provider.ts in the v0.4 series;
// these tests pin the CURRENT protocol behavior so the extraction cannot
// drift, including the traps called out by the adversarial plan review:
//
//   T1  usage is captured from a chunk with an EMPTY choices array
//       (DeepSeek's final usage chunk) and independently of delta dispatch
//   T3' ONLY JSON.parse failures classify as malformed — a well-formed
//       chunk never does, whatever its content
//   T4  once a tool-call index completes, ALL later deltas for it are
//       ignored
//   T7  lines split on "\n" only (no \r stripping), the data prefix is
//       exactly "data: " (with the space), and [DONE] matches exactly —
//       a "spec-correct" SSE parser here would be a silent protocol change
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import {
	splitSseLines,
	parseSseData,
	extractDelta,
	isCleanFinish,
	ToolCallAssembler,
	tryParseJSONObject,
} from "../out/sse.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	const g = typeof got === "object" && got !== null ? JSON.stringify(got) : got;
	const e = typeof expected === "object" && expected !== null ? JSON.stringify(expected) : expected;
	if (Object.is(g, e)) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(e)} got=${JSON.stringify(g)}`);
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

// === 1. splitSseLines — "\n"-only splitting with carry-over ===
check("complete line splits off, rest empty", splitSseLines("data: a\n"), { lines: ["data: a"], rest: "" });
check("partial line carries over as rest", splitSseLines("data: a\ndata: b"), { lines: ["data: a"], rest: "data: b" });
check("no newline → everything is rest", splitSseLines("data: a"), { lines: [], rest: "data: a" });
check("empty input → empty rest", splitSseLines(""), { lines: [], rest: "" });
// T7: \r is NOT stripped — a CRLF stream leaves \r on the line, and the
// JSON parse of "…}\r" fails → malformed → skipped. Pinned deliberately:
// DeepSeek sends LF-only, and "fixing" CRLF handling here would change
// what counts as a valid line mid-migration.
check("\\r retained (no CRLF normalization)", splitSseLines("data: x\r\n"), { lines: ["data: x\r"], rest: "" });
// Multi-call carry-over: caller prepends rest to the next chunk.
const first = splitSseLines('data: {"a"');
const second = splitSseLines(first.rest + ":1}\ndata: [DONE]\n");
check("carry-over reassembles the split line", second.lines, ['data: {"a":1}', "data: [DONE]"]);

// === 2. parseSseData — classification ===
check("non-data line → not-data", parseSseData(": keep-alive").kind, "not-data");
check("event line → not-data", parseSseData("event: message").kind, "not-data");
check("empty line → not-data", parseSseData("").kind, "not-data");
// T7: prefix must be exactly "data: " — "data:" without the space is a
// different line type to this parser and always has been.
check('"data:" without space → not-data', parseSseData('data:{"choices":[]}').kind, "not-data");
check("[DONE] matches exactly", parseSseData("data: [DONE]").kind, "done");
check("[DONE] with trailing space is NOT done", parseSseData("data: [DONE] ").kind, "malformed");
check("valid chunk → chunk", parseSseData('data: {"choices":[]}').kind, "chunk");
const malformed = parseSseData("data: {truncated");
check("bad JSON → malformed", malformed.kind, "malformed");
check("malformed carries a 200-char snippet", malformed.snippet, "{truncated");
// T1: usage rides on the chunk result, independent of choices.
const usageChunk = parseSseData('data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7}}');
check("usage captured from empty-choices chunk", usageChunk.usage, { prompt_tokens: 42, completion_tokens: 7 });
check("usage absent → undefined", parseSseData('data: {"choices":[]}').usage, undefined);

// === 3. extractDelta — dispatch gating ===
check("no choices → undefined", extractDelta({}), undefined);
check("empty choices → undefined (T1: usage chunk dispatches nothing)", extractDelta({ choices: [] }), undefined);
check(
	"reasoning + content interleaved in one delta",
	extractDelta({ choices: [{ delta: { reasoning_content: "hmm", content: "Hi" } }] }),
	{ reasoning: "hmm", content: "Hi" }
);
check("empty reasoning string is not an event", extractDelta({ choices: [{ delta: { reasoning_content: "" } }] }), {});
check("empty content string is not an event", extractDelta({ choices: [{ delta: { content: "" } }] }), {});
check(
	"truthy non-string content is String()-coerced",
	extractDelta({ choices: [{ delta: { content: 42 } }] }),
	{ content: "42" }
);
check(
	"finish_reason captured with no delta",
	extractDelta({ choices: [{ finish_reason: "stop" }] }),
	{ finishReason: "stop" }
);
check(
	"tool_calls array passes through raw",
	extractDelta({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }),
	{ toolCallDeltas: [{ index: 0 }] }
);

// === 4. isCleanFinish ===
check("stop is clean", isCleanFinish("stop"), true);
check("tool_calls is clean", isCleanFinish("tool_calls"), true);
for (const f of ["length", "content_filter", "insufficient_system_resource", undefined]) {
	check(`${String(f)} is not clean`, isCleanFinish(f), false);
}

// === 5. ToolCallAssembler — incremental assembly ===
const asm = new ToolCallAssembler();
check(
	"partial args do not complete",
	asm.add([{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"loc' } }]),
	[]
);
const done1 = asm.add([{ index: 0, function: { arguments: 'ation":"Tokyo"}' } }]);
check("completes once args parse (early emit)", done1, [
	{ id: "call_1", name: "get_weather", args: { location: "Tokyo" } },
]);
// T4: post-completion deltas for the same index are ignored.
check("post-completion deltas ignored (T4)", asm.add([{ index: 0, function: { arguments: "garbage" } }]), []);
check("flush after completion returns nothing", asm.flush(true), []);

// Name required for mid-stream completion; interleaved indexes stay separate.
const asm2 = new ToolCallAssembler();
check(
	"no name → no mid-stream completion even with valid args",
	asm2.add([{ index: 0, id: "call_a", function: { arguments: "{}" } }]),
	[]
);
check(
	"second index assembles independently",
	asm2.add([{ index: 1, id: "call_b", function: { name: "beta", arguments: "{}" } }]),
	[{ id: "call_b", name: "beta", args: {} }]
);
// flush substitutes unknown_tool for the nameless-but-parseable buffer.
check("flush names the nameless unknown_tool", asm2.flush(false), [{ id: "call_a", name: "unknown_tool", args: {} }]);

// flush(throwOnInvalid) semantics.
const asm3 = new ToolCallAssembler();
asm3.add([{ index: 0, id: "call_x", function: { name: "gamma", arguments: "{invalid" } }]);
check("flush(false) drops invalid silently", asm3.flush(false), []);
asm3.add([{ index: 1, id: "call_y", function: { name: "delta_fn", arguments: "{bad" } }]);
const flushThrow = throwsWith(() => asm3.flush(true));
check("flush(true) throws on invalid JSON", flushThrow.threw, true);
check("throw message unchanged from 0.3.x", flushThrow.message, "Invalid JSON for tool call");

// Missing id gets a generated call_<random> at completion time.
const asm4 = new ToolCallAssembler();
const generated = asm4.add([{ index: 0, function: { name: "eps", arguments: "{}" } }]);
check("generated id has the call_ prefix", /^call_[a-z0-9]+$/.test(generated[0]?.id ?? ""), true);
// Missing index defaults to 0 and fragments accumulate onto it. The
// generated id is random, so verify by shape.
{
	const asm5 = new ToolCallAssembler();
	asm5.add([{ function: { name: "zeta", arguments: '{"a"' } }]);
	const completed = asm5.add([{ function: { arguments: ":1}" } }]);
	check("missing index defaults to 0 and accumulates", completed.length === 1 && completed[0].name === "zeta", true);
	check("accumulated args parsed", completed[0]?.args, { a: 1 });
}

// === 6. tryParseJSONObject (moved from utils.ts) ===
check("object parses", tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
check("array rejected", tryParseJSONObject("[1]").ok, false);
check("empty rejected", tryParseJSONObject("").ok, false);
check("partial rejected", tryParseJSONObject('{"a":').ok, false);
check("non-brace text rejected", tryParseJSONObject("null").ok, false);

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
