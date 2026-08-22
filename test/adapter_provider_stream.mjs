// Streaming behaviour through provideLanguageModelChatResponse with a stubbed
// SSE response: progress emission (text, ThinkingPart vs 💭 fallback, tool
// calls), usage capture from the empty-choices chunk, finish_reason handling,
// [DONE] flush, cancellation (reader.cancel + finally persist), and the
// mid-stream throw that still persists reasoning.
import { createRequire } from "node:module";
import { check, checkMatch, summary, withConsole } from "./helpers/check.mjs";
import { vscode, OUT, shim, makeProvider, runTurn, cancellation, progressCollector, sseResponse, hangingStream, reasoningChunk, contentChunk, toolCallChunk, finishChunk, usageChunk, DONE, tick } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const USAGE = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } };

async function main() {
	// No priming needed: the shim pre-declares LanguageModelThinkingPart as an
	// own export (undefined), so __importStar gives provider.js a live getter
	// and install/removeThinkingPart below take effect whenever they are called.

	// --- text + reasoning, no ThinkingPart on the host ---
	{
		shim.reset();
		const { provider, output } = makeProvider();
		const t = await runTurn(provider, { chunks: [reasoningChunk("R"), reasoningChunk("R2"), contentChunk("Hel"), contentChunk("lo"), finishChunk("stop"), usageChunk(USAGE), DONE] });
		check("no error", t.error, undefined);
		check("💭 hint once, then text in order", t.progress.texts().join("|"), "💭 Thinking...\n\n|Hel|lo");
		// CORRECTED: captureProgress (provider.ts) accumulates every emitted
		// LanguageModelTextPart into ctx.emittedText, including the 💭
		// fallback hint itself — it's just another TextPart from processDelta's
		// point of view. persistReasoningForTurn's degenerate-anchor guard only
		// strips the hint when it is the ENTIRE emitted text (a turn cancelled
		// right after the hint, before any content/tool-call delta); here real
		// content follows it, so the fingerprint anchor is hint+text, not text alone.
		check("reasoning cached (both chunks concatenated)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "💭 Thinking...\n\nHello", toolCalls: [] }), false), "RR2");
		const snap = provider.contextUsage.getSnapshot();
		check("usage captured from the empty-choices chunk", snap?.apiPromptTokens, 1000);
		check("cache-hit tokens captured", snap?.apiCacheHitTokens, 800);
		checkMatch("usage logged", output.text(), /"prompt":1000,"cache_hit":800/);
		checkMatch("thinking.end summary logged even with raw logging off", output.text(), /thinking\.end/);
		check("raw reasoning NOT logged by default", output.text().includes("RR2"), false);
		provider.dispose();
	}
	// --- ThinkingPart available → reflected, no 💭 ---
	{
		shim.reset();
		shim.installThinkingPart();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { chunks: [reasoningChunk("R"), contentChunk("x"), finishChunk("stop"), DONE] });
		check("ThinkingPart emitted", t.progress.thinking().length, 1);
		check("…carrying the reasoning text", t.progress.thinking()[0].value, "R");
		check("no 💭 hint when ThinkingPart exists", t.progress.texts().some((s) => s.startsWith("💭")), false);
		shim.removeThinkingPart();
		provider.dispose();
	}
	// --- logRawReasoning on → raw chunks mirrored to the channel ---
	{
		shim.reset();
		shim.answers.getConfiguration = { deepseekv4: { logRawReasoning: true } };
		const { provider, output } = makeProvider();
		await runTurn(provider, { chunks: [reasoningChunk("SECRET-R"), contentChunk("x"), finishChunk("stop"), DONE] });
		check("raw reasoning logged when the setting is on", output.text().includes("SECRET-R"), true);
		checkMatch("thinking.start marker", output.text(), /thinking\.start/);
		provider.dispose();
	}
	// --- tool calls: assembly, early emit, flush on [DONE] ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const tools = [{ name: "get_weather", description: "d", inputSchema: { type: "object", properties: {} } }];
		const t = await runTurn(provider, {
			options: { tools },
			// "after" sits between the chunk that COMPLETES call_1's JSON and the
			// call_2 chunk, so the order of parts pins early emit: call_1 must
			// reach the host as soon as its arguments parse, not at flush time.
			chunks: [toolCallChunk(0, { id: "call_1", name: "get_weather", args: '{"ci' }), toolCallChunk(0, { args: 'ty":"Tokyo"}' }), contentChunk("after"), toolCallChunk(1, { id: "call_2", name: "get_weather", args: "{}" }), finishChunk("tool_calls"), DONE],
		});
		check("no error", t.error, undefined);
		const calls = t.progress.toolCalls();
		check("two tool calls reported", calls.length, 2);
		check("args assembled across deltas", JSON.stringify(calls[0].input), '{"city":"Tokyo"}');
		check("ids preserved", calls.map((c) => c.callId).join(","), "call_1,call_2");
		const firstCallAt = t.progress.parts.findIndex((p) => p instanceof vscode.LanguageModelToolCallPart);
		const afterTextAt = t.progress.parts.findIndex((p) => p instanceof vscode.LanguageModelTextPart && p.value === "after");
		check("the 'after' text really was reported", afterTextAt >= 0, true);
		check("early emit: call_1 reaches the host BEFORE the text that follows it", firstCallAt >= 0 && firstCallAt < afterTextAt, true);
		provider.dispose();
	}
	// --- non-clean finish: insufficient_system_resource → error toast with Show Log ---
	{
		shim.reset();
		shim.answers.showErrorMessage = "Show Log";
		const { provider, output } = makeProvider();
		const t = await runTurn(provider, { chunks: [contentChunk("partial"), finishChunk("insufficient_system_resource"), DONE] });
		await tick();
		check("turn completes (no throw) on mid-stream truncation", t.error, undefined);
		checkMatch("error toast names the capacity failure", shim.calls.showErrorMessage.at(-1)?.message, /ran out of capacity mid-stream/);
		check("…offers Show Log", shim.calls.showErrorMessage.at(-1)?.items.join(","), "Show Log");
		check("choosing Show Log runs the command", shim.calls.executeCommand.some((c) => c.id === "deepseekv4.showLog"), true);
		checkMatch("truncation logged", output.text(), /api\.midstream_truncate/);
		provider.dispose();
	}
	// --- length / content_filter are logged, not toasted ---
	for (const reason of ["length", "content_filter"]) {
		shim.reset();
		const { provider, output } = makeProvider();
		await runTurn(provider, { chunks: [contentChunk("x"), finishChunk(reason), DONE] });
		check(`${reason}: no error toast`, shim.calls.showErrorMessage.length, 0);
		checkMatch(`${reason}: logged`, output.text(), new RegExp(`api\\.(length_truncate|content_filter).*"finish":"${reason}"`));
		provider.dispose();
	}
	// --- truncated tool-call JSON on a non-clean finish is dropped, not thrown ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { options: { tools: [{ name: "t" }] }, chunks: [toolCallChunk(0, { id: "c", name: "t", args: '{"a":' }), finishChunk("length"), DONE] });
		check("length finish with partial tool JSON: no throw", t.error, undefined);
		check("…and no tool call reported", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	// --- clean finish with invalid tool-call JSON THROWS, and reasoning is still persisted from finally ---
	{
		shim.reset();
		const { provider } = makeProvider();
		// This scenario deliberately drives a mid-stream throw: ToolCallAssembler.flush
		// logs via console.error("[DeepSeek V4] Invalid JSON for tool call", ...) before
		// throwing, and provideLanguageModelChatResponse's outer catch logs via
		// console.error("[DeepSeek V4] Chat request failed", ...) again before rethrowing.
		// Both are real, expected CURRENT behaviour — not test bugs — so console.error
		// is captured around just this block to keep the suite's own output pristine.
		const captured = await withConsole("error", () =>
			runTurn(provider, { options: { tools: [{ name: "t" }] }, chunks: [reasoningChunk("R-mid"), contentChunk("Some text"), toolCallChunk(0, { id: "c", name: "t", args: "{invalid" }), finishChunk("stop"), DONE] }),
		);
		const t = captured.result;
		checkMatch("clean finish + invalid JSON throws", t.error?.message, /Invalid JSON for tool call/);
		check("both expected console.error calls captured (invalid JSON + outer catch)", captured.lines.length, 2);
		// CORRECTED: same 💭-hint-prefix reasoning as the first scenario — the
		// reasoningChunk before "Some text" triggers the fallback hint (no
		// ThinkingPart host), and that hint text is part of ctx.emittedText,
		// hence part of the fingerprint anchor.
		check("reasoning persisted by the finally path (tx: anchor on emitted text)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "💭 Thinking...\n\nSome text", toolCalls: [] }), false), "R-mid");
		provider.dispose();
	}
	// --- cancellation: reader.cancel bridged, loop exits, finally persists ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const { stream, state } = hangingStream([reasoningChunk("R-cancel"), contentChunk("Partial answer")]);
		const c = cancellation();
		// Cancel the instant the partial text reaches the host — event-driven, so
		// there is no sleep to tune and no race if the stream runs slow.
		const base = progressCollector();
		const progress = {
			...base,
			report: (p) => {
				base.report(p);
				if (p instanceof vscode.LanguageModelTextPart && p.value === "Partial answer") {
					c.cancel();
				}
			},
		};
		const t = await runTurn(provider, { response: sseResponse(stream), cancellation: c, progress });
		check("cancelled turn resolves without throwing", t.error, undefined);
		check("reader.cancel reached the underlying stream", state.cancelled, true);
		check("partial text was emitted before cancel", t.progress.texts().includes("Partial answer"), true);
		// CORRECTED: same 💭-hint-prefix reasoning — reasoningChunk("R-cancel")
		// shows the fallback hint before "Partial answer" streams in.
		check("reasoning persisted for the partial turn (issue #19 path)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "💭 Thinking...\n\nPartial answer", toolCalls: [] }), false), "R-cancel");
		provider.dispose();
	}
	// --- [DONE] without finish_reason still flushes + persists ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { options: { tools: [{ name: "t" }] }, chunks: [reasoningChunk("R-done"), toolCallChunk(0, { id: "c", name: "t", args: "{}" }), DONE] });
		check("no error", t.error, undefined);
		check("tool call flushed on [DONE]", t.progress.toolCalls().length, 1);
		check("reasoning persisted on [DONE]", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "c", name: "t" }] }), false), "R-done");
		provider.dispose();
	}
	// --- malformed SSE line is skipped and logged ---
	{
		shim.reset();
		const { provider, output } = makeProvider();
		const t = await runTurn(provider, { chunks: ["data: {not json\n", contentChunk("after"), finishChunk("stop"), DONE] });
		check("malformed chunk does not fail the turn", t.error, undefined);
		check("later chunks still delivered", t.progress.texts().includes("after"), true);
		checkMatch("parse error logged", output.text(), /sse\.parse_error/);
		provider.dispose();
	}
	summary("adapter_provider_stream");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
