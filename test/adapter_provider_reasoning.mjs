// Reasoning round-trip through the real provider: attachReasoningToHistory
// (hit / miss → "" / non-thinking strip / stats gating), persistReasoningForTurn
// anchors (tc: / tx:, wire names), and cross-instance restore from globalState.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary, until } from "./helpers/check.mjs";
import { OUT, shim, makeProvider, runTurn, model, userText, assistantText, assistantToolCallMsg, toolResultMsg, reasoningChunk, contentChunk, toolCallChunk, finishChunk, usageChunk, DONE } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const { convertMessages } = require(OUT("utils.js"));

async function main() {
	// --- attachReasoningToHistory: hit, miss, stats ---
	{
		const { provider, output } = makeProvider();
		const fpHit = fingerprintAssistantTurn({ text: "Cached answer.", toolCalls: [] });
		provider._reasoningCache.set(fpHit, "my reasoning");
		const msgs = convertMessages([userText("q"), assistantText("Cached answer."), userText("q2"), assistantText("Uncached answer."), userText("q3")]);
		const stats = provider.attachReasoningToHistory(msgs, true);
		checkDeep("hit + miss counted", stats, { hits: 1, misses: 1 });
		check("hit gets the cached reasoning", msgs[1].reasoning_content, "my reasoning");
		check("miss gets the empty-string stub", msgs[3].reasoning_content, "");
		check("user turns untouched", msgs[0].reasoning_content, undefined);
		const cs = provider.getCacheStats();
		check("real turn counts toward cache stats (gets)", cs.totalGets, 2);
		check("…hits", cs.totalHits, 1);
		const msgs2 = convertMessages([userText("q"), assistantText("Uncached answer.")]);
		const aux = provider.attachReasoningToHistory(msgs2, false);
		checkDeep("auxiliary request still attaches", aux, { hits: 0, misses: 1 });
		check("…but stats unchanged (countStats=false)", provider.getCacheStats().totalGets, 2);
		check("pre-existing reasoning_content is kept, not re-looked-up", (() => { const m = [{ role: "assistant", content: "x", reasoning_content: "keep" }]; provider.attachReasoningToHistory(m); return m[0].reasoning_content; })(), "keep");
		checkMatch("miss is logged with the fingerprint", output.text(), /cache\.MISS.*"mode":"tx"/);
		provider.dispose();
	}

	// --- tool-call anchor: set side (stream) → get side (next request), wire names ---
	{
		shim.reset();
		const { provider, memento } = makeProvider();
		const tools = [{ name: "weather.get", description: "d", inputSchema: { type: "object", properties: {} } }];
		const t1 = await runTurn(provider, {
			model: model("deepseek-v4-pro::thinking"),
			messages: [userText("weather?")],
			options: { tools },
			chunks: [reasoningChunk("Think."), toolCallChunk(0, { id: "call_1", name: "weather_get_" }), DONE],
		});
		// The aliased wire name must be completed by the assembler; use the real alias:
		const wire = convertMessages([assistantToolCallMsg("", [{ callId: "call_1", name: "weather.get", input: {} }])])[0].tool_calls[0].function.name;
		check("turn 1 setup: no error", t1.error, undefined);
		// Re-run with the exact wire name so the tool call completes and is reported.
		const t1b = await runTurn(provider, {
			model: model("deepseek-v4-pro::thinking"),
			messages: [userText("weather?")],
			options: { tools },
			chunks: [reasoningChunk("Think harder."), toolCallChunk(0, { id: "call_2", name: wire, args: "{}" }), finishChunk("tool_calls"), DONE],
		});
		check("tool call reported to the host", t1b.progress.toolCalls().length, 1);
		check("…under the HOST name (reverse-mapped)", t1b.progress.toolCalls()[0].name, "weather.get");
		const fp = fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "call_2", name: wire }] });
		check("reasoning cached under the tc: fingerprint keyed on the WIRE name", provider._reasoningCache.get(fp, false), "Think harder.");
		check("fingerprint mode is tc:", fp.startsWith("tc:"), true);
		// Next request: host history carries the HOST name; attach must hit.
		const next = convertMessages([userText("weather?"), assistantToolCallMsg("", [{ callId: "call_2", name: "weather.get", input: {} }]), toolResultMsg([{ callId: "call_2", content: ["Sunny"] }]), userText("ok")]);
		const stats = provider.attachReasoningToHistory(next, true);
		check("next turn: tool-call turn hits", stats.hits, 1);
		check("…with the streamed reasoning", next[1].reasoning_content, "Think harder.");
		// Persistence: debounced write to globalState. Poll for the entry rather
		// than sleeping past the debounce — no tuned delay, no race.
		const persisted = await until(() => (memento.get("deepseekv4.reasoningCache") ?? []).some((e) => e.fingerprint === fp));
		check("cache persisted to globalState under the frozen key", persisted, true);
		check("…as an array of entries", Array.isArray(memento.get("deepseekv4.reasoningCache")), true);
		provider.dispose();

		// Cross-instance restore (simulates VS Code restart / extension upgrade).
		const second = makeProvider({ memento });
		const again = convertMessages([userText("weather?"), assistantToolCallMsg("", [{ callId: "call_2", name: "weather.get", input: {} }]), toolResultMsg([{ callId: "call_2", content: ["Sunny"] }]), userText("ok")]);
		check("new instance restored the entry and hits", second.provider.attachReasoningToHistory(again, true).hits, 1);
		second.provider.dispose();
	}

	// --- text anchor, and the 💭-only turn is not cached ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { messages: [userText("hi")], chunks: [reasoningChunk("R1"), contentChunk("Hello there."), finishChunk("stop"), DONE] });
		check("text turn: no error", t.error, undefined);
		// Anchor text is whatever was actually reported to the host as visible
		// text, not the raw content delta: on hosts without
		// LanguageModelThinkingPart (the shim's default — see adapter_smoke),
		// the "💭 Thinking..." fallback hint is itself a real TextPart emitted
		// before "Hello there.", so it is part of ctx.emittedText and thus part
		// of the tx: fingerprint. Hardcoding "Hello there." as the anchor text
		// undercounts that prefix and always misses.
		const emittedText = t.progress.texts().join("");
		checkMatch("fallback hint prefixes the emitted text (no host ThinkingPart)", emittedText, /^💭.*Hello there\.$/s);
		check("text reasoning cached under tx: (keyed on the actual emitted text, hint included)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: emittedText, toolCalls: [] }), false), "R1");
		const before = provider._reasoningCache.size();
		const only = await runTurn(provider, { messages: [userText("hi2")], chunks: [reasoningChunk("R2"), finishChunk("stop"), DONE] });
		check("💭-only turn (no host ThinkingPart, no content): no error", only.error, undefined);
		check("…emitted the one-shot 💭 hint", only.progress.texts().some((s) => s.startsWith("💭")), true);
		check("…is NOT cached (no anchor)", provider._reasoningCache.size(), before);
		provider.dispose();
	}

	// --- non-thinking variant strips reasoning_content from history ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const fp = fingerprintAssistantTurn({ text: "Cached answer.", toolCalls: [] });
		provider._reasoningCache.set(fp, "stale");
		const t = await runTurn(provider, { model: model("deepseek-v4-flash"), messages: [userText("q"), assistantText("Cached answer."), userText("q2")], chunks: [contentChunk("ok"), finishChunk("stop"), DONE] });
		check("non-thinking turn: no error", t.error, undefined);
		check("non-thinking body carries no reasoning_content", String(t.captured.body).includes("reasoning_content"), false);
		check("thinking disabled on the wire", String(t.captured.body).includes('"thinking":{"type":"disabled"}'), true);
		provider.dispose();
	}
	summary("adapter_provider_reasoning");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
