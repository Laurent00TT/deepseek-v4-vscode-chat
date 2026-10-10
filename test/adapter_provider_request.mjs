// Request assembly and post-usage behaviour of provideLanguageModelChatResponse:
// headers/body, pre-flight guards (token overflow, 32 MiB image, 48 MiB body),
// the 128-tool cap, Required tool mode on thinking variants (forced
// tool_choice relaxed to "auto"), API error → notification mapping, and the usage pipeline
// (estimator EMA, usage DataPart gating, cache-breakdown warning, context
// nudge hysteresis).
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary, withConsole } from "./helpers/check.mjs";
import {
	vscode,
	OUT,
	shim,
	makeProvider,
	runTurn,
	model,
	userText,
	textMsg,
	assistantText,
	assistantToolCallMsg,
	toolResultMsg,
	userImageMsg,
	jsonResponse,
	onFetch,
	contentChunk,
	reasoningChunk,
	toolCallChunk,
	finishChunk,
	usageChunk,
	DONE,
	tick,
	fakeSecrets,
} from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { toWireName } = require(OUT("tool_names.js"));
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const Role = vscode.LanguageModelChatMessageRole;
const ok = (usage) => [contentChunk("ok"), finishChunk("stop"), usageChunk(usage), DONE];

// provideLanguageModelChatResponse wraps its entire body in one try/catch
// that logs every thrown error via console.error("[DeepSeek V4] Chat request
// failed", ...) before rethrowing — not just the token-overflow / 48 MiB
// cases the task brief calls out (those additionally get their own explicit
// console.error at the guard site). Every scenario below that expects
// t.error to be set therefore prints to console.error; capture it around
// each such call so the suite's own ✓/✗ output stays pristine.
const quiet = async (fn) => (await withConsole("error", fn)).result;

async function main() {
	// --- headers and body ---
	{
		shim.reset();
		shim.answers.getConfiguration = { deepseekv4: { reasoningEffort: "high" } };
		const { provider } = makeProvider({ userAgent: "ua-test/1.2" });
		const t = await runTurn(provider, { messages: [userText("hi")], chunks: ok({ prompt_tokens: 10, completion_tokens: 1 }) });
		check("no error", t.error, undefined);
		check("POST to /chat/completions", t.captured.url.endsWith("/v1/chat/completions"), true);
		check("Authorization bearer from SecretStorage", t.captured.headers.Authorization, "Bearer sk-test");
		check("User-Agent propagated", t.captured.headers["User-Agent"], "ua-test/1.2");
		check("Content-Type json", t.captured.headers["Content-Type"], "application/json");
		check("reasoning_effort read from settings", String(t.captured.body).includes('"reasoning_effort":"high"'), true);
		check("model id on the wire is the API name", String(t.captured.body).startsWith('{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"hi"}]'), true);
		provider.dispose();
	}
	// --- low effort: setting → wire → per-request log line ---
	{
		shim.reset();
		shim.answers.getConfiguration = { deepseekv4: { reasoningEffort: "low" } };
		const { provider, output } = makeProvider();
		const t = await runTurn(provider, { messages: [userText("hi")], chunks: ok({ prompt_tokens: 10, completion_tokens: 1 }) });
		check("low effort: no error", t.error, undefined);
		check("low effort is sent as low, not coerced to max", String(t.captured.body).includes('"reasoning_effort":"low"'), true);
		checkMatch("…and logged per request", output.text(), /\[req\] reasoning_effort=low \(variant=deepseek-v4-pro::thinking\)/);
		provider.dispose();
	}
	// --- missing API key ---
	{
		shim.reset();
		const { provider } = makeProvider({ secrets: fakeSecrets({}) });
		const t = await quiet(() => runTurn(provider, {}));
		checkMatch("no key → throws", t.error?.message, /API key not found/);
		provider.dispose();
	}
	// --- token overflow pre-check ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const huge = "x".repeat(2_000_000); // 2M chars / 3.0 chars-per-token ≈ 667K > 655,360
		const t = await quiet(() => runTurn(provider, { messages: [userText(huge)] }));
		checkMatch("overflow throws before fetch", t.error?.message, /exceeds token limit/);
		check("no request was sent", t.captured.url, undefined);
		checkMatch("context-overflow guidance shown", shim.calls.showErrorMessage.at(-1)?.message, /context window exceeded/);
		check("…with Start New Chat / Show Log", shim.calls.showErrorMessage.at(-1)?.items.join(","), "Start New Chat,Show Log");
		provider.dispose();
	}
	// --- 32 MiB per-image pre-check (image-capable variant) ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const big = new Uint8Array(32 * 1024 * 1024 + 1);
		const t = await quiet(() =>
			runTurn(provider, { model: model("deepseek-v4-flash"), messages: [userImageMsg("look", big)] })
		);
		checkMatch("oversized image throws", t.error?.message, /32 MiB per-image limit/);
		check("no request was sent", t.captured.url, undefined);
		checkMatch("toast is actionable", shim.calls.showErrorMessage.at(-1)?.message, /Attach a smaller image, or start a new chat/);
		provider.dispose();
	}
	// --- an oversized image in a format DeepSeek rejects is dropped, not size-checked ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const big = new Uint8Array(32 * 1024 * 1024 + 1);
		const { result: t, lines } = await withConsole("warn", () =>
			runTurn(provider, {
				model: model("deepseek-v4-flash"),
				messages: [userImageMsg("look", big, "image/bmp")],
				chunks: ok({ prompt_tokens: 10, completion_tokens: 1 }),
			})
		);
		check("no per-image size error", t.error, undefined);
		check("request was sent", typeof t.captured.url, "string");
		check("image dropped from the wire", JSON.parse(t.captured.body ?? "{}").messages?.at(-1)?.content, "look");
		checkMatch("drop is logged", lines.join("|"), /unsupported MIME type/);
		provider.dispose();
	}
	// --- 48 MiB body pre-check (three 16 MiB images → ~64 MiB of base64) ---
	{
		shim.reset();
		const { provider } = makeProvider();
		// SLOWEST STEP IN THE SUITE: allocating and base64-encoding 48 MiB of
		// image bytes takes a couple of seconds. It is the only way to cross the
		// real 48 MiB body guard, so it stays — just don't be surprised by the pause.
		const img = new Uint8Array(16 * 1024 * 1024);
		const t = await quiet(() =>
			runTurn(provider, {
				model: model("deepseek-v4-flash"),
				messages: [userImageMsg("a", img), userImageMsg("b", img), userImageMsg("c", img)],
			})
		);
		checkMatch("oversized body throws", t.error?.message, /48 MiB limit/);
		checkMatch("toast says fewer/smaller images", shim.calls.showErrorMessage.at(-1)?.message, /Attach fewer or smaller images/);
		provider.dispose();
	}
	// --- 128-tool cap (issue #27): trim instead of failing, warn once ---
	{
		shim.reset();
		const { provider, output } = makeProvider();
		// The LAST tool has an MCP-style name that is wire-aliased, and the
		// history already called it: a plain first-128 cut would drop it, and
		// keeping it only works if history and defs agree on the wire name.
		const aliasHost = "mcp.server." + "long_".repeat(12) + "tool";
		check("premise: the tail tool is aliased on the wire", toWireName(aliasHost) !== aliasHost, true);
		const tools = Array.from({ length: 130 }, (_, i) => ({ name: i === 129 ? aliasHost : `t_${i}`, description: "", inputSchema: { type: "object", properties: {} } }));
		const messages = [
			userText("go"),
			assistantToolCallMsg("", [{ callId: "c1", name: aliasHost, input: {} }]),
			toolResultMsg([{ callId: "c1", content: [new vscode.LanguageModelTextPart("done")] }]),
		];
		const turn = (offered) =>
			runTurn(provider, { model: model("deepseek-v4-flash"), messages, options: { tools: offered }, chunks: ok({ prompt_tokens: 10, completion_tokens: 1 }) });
		const atCap = await turn(tools.slice(0, 128));
		check("exactly 128 tools: sent untouched", JSON.parse(atCap.captured.body).tools.length, 128);
		check("…with no warning", shim.calls.showWarningMessage.length, 0);
		const t = await turn(tools);
		check("130 tools: the request is sent, not failed", t.error, undefined);
		const sent = JSON.parse(t.captured.body).tools.map((d) => d.function.name);
		check("128 tools on the wire", sent.length, 128);
		checkDeep("host order kept, the called (aliased) tool kept past the cut", [sent[0], sent[126], sent[127]], ["t_0", "t_126", toWireName(aliasHost)]);
		checkMatch("warning names the counts", shim.calls.showWarningMessage.at(-1)?.message, /offers 130 tools, but DeepSeek V4 sends at most 128 per request, so 2 were left out/);
		check("…with Show Log", shim.calls.showWarningMessage.at(-1)?.items.join(","), "Show Log");
		checkMatch("dropped names are logged", output.text(), /request\.tools_capped .*"dropped":\["t_127","t_128"\]/);
		await turn(tools);
		check("warning fires once per session", shim.calls.showWarningMessage.length, 1);
		provider.dispose();
	}
	// --- Required tool mode on thinking variants: forced tool_choice relaxed to "auto" ---
	// DeepSeek's thinking mode answers "required" and a named function with
	// 400 "Thinking mode does not support this tool_choice"; non-thinking
	// accepts both. Only the request that used to fail may change on the wire.
	{
		shim.reset();
		const { provider, output } = makeProvider();
		const { Auto, Required } = vscode.LanguageModelChatToolMode;
		const tool = (name) => ({ name, description: "", inputSchema: { type: "object", properties: {} } });
		const turn = (modelId, tools, toolMode, chunks = ok({ prompt_tokens: 10, completion_tokens: 1 })) =>
			runTurn(provider, { model: model(modelId), messages: [userText("go")], options: { tools, toolMode }, chunks });
		const sentChoice = (t) => JSON.parse(t.captured.body).tool_choice;
		const relaxLogs = () => (output.text().match(/request\.tool_choice_relaxed/g) ?? []).length;

		const auto = await turn("deepseek-v4-pro::thinking", [tool("a")], Auto);
		check("thinking + Auto: 'auto'", sentChoice(auto), "auto");
		check("…nothing logged", relaxLogs(), 0);
		const one = await turn("deepseek-v4-pro::thinking", [tool("a")], Required);
		check("thinking + Required + 1 tool: sent, not failed", one.error, undefined);
		check("…named force relaxed to 'auto'", sentChoice(one), "auto");
		check("…byte-identical to the same request in Auto mode", one.captured.body, auto.captured.body);
		checkMatch("…logged with what was asked for", output.text(), /request\.tool_choice_relaxed .*"variant":"deepseek-v4-pro::thinking","requested":\{"type":"function","function":\{"name":"a"\}\},"sent":"auto"/);
		const several = await turn("deepseek-v4-flash::thinking", [tool("a"), tool("b")], Required);
		check("thinking + Required + 2 tools: 'required' relaxed to 'auto'", sentChoice(several), "auto");
		check("…logged once per session", relaxLogs(), 1);
		// Still a thinking turn: its reasoning is cached for the next request
		// like any other — the reason to relax tool_choice, not disable thinking.
		const called = await turn("deepseek-v4-pro::thinking", [tool("a")], Required, [reasoningChunk("Call a."), toolCallChunk(0, { id: "call_r", name: "a", args: "{}" }), finishChunk("tool_calls"), DONE]);
		check("…the model's tool call reaches the host", called.progress.toolCalls()[0]?.name, "a");
		check("…and its reasoning is cached for the next turn", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "call_r", name: "a" }] }), false), "Call a.");
		// Non-thinking accepts a forced choice: untouched.
		checkDeep("non-thinking + Required + 1 tool: named force kept", sentChoice(await turn("deepseek-v4-pro", [tool("a")], Required)), { type: "function", function: { name: "a" } });
		check("non-thinking + Required + 2 tools: 'required' kept", sentChoice(await turn("deepseek-v4-flash", [tool("a"), tool("b")], Required)), "required");
		check("…and never logged as relaxed", relaxLogs(), 1);
		provider.dispose();
	}
	// --- API error mapping (non-retryable statuses) ---
	const cases = [
		{
			status: 400,
			body: { error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } },
			kind: "error",
			re: /missing reasoning chain/,
			items: "Start New Chat,Show Log",
			answer: "Start New Chat",
			cmd: "workbench.action.chat.newChat",
		},
		{
			status: 400,
			body: { error: { message: "This model's maximum context length is 65536 tokens. Please reduce the length of the messages." } },
			kind: "error",
			re: /context window exceeded/,
			items: "Start New Chat,Show Log",
		},
		{
			status: 401,
			body: { error: { message: "bad key" } },
			kind: "error",
			re: /rejected \(401\)/,
			items: "Update API Key",
			answer: "Update API Key",
			cmd: "deepseekv4.manage",
		},
		{
			status: 402,
			body: { error: { message: "no money" } },
			kind: "error",
			re: /insufficient balance \(402\)/,
			items: "Open DeepSeek Billing",
			answer: "Open DeepSeek Billing",
			external: "https://platform.deepseek.com/usage",
		},
		{
			status: 422,
			body: { error: { message: "schema" } },
			kind: "error",
			re: /rejected the request schema \(422\)/,
			items: "Reload Window",
			answer: "Reload Window",
			cmd: "workbench.action.reloadWindow",
		},
	];
	for (const c of cases) {
		shim.reset();
		if (c.answer) shim.answers.showErrorMessage = c.answer;
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, { response: jsonResponse(c.status, c.body) }));
		await tick();
		checkMatch(`${c.status}: throws formatted API error`, t.error?.message, new RegExp(`DeepSeek API error: ${c.status}`));
		const last = shim.calls.showErrorMessage.at(-1);
		checkMatch(`${c.status}: toast text`, last?.message, c.re);
		check(`${c.status}: buttons`, last?.items.join(","), c.items);
		if (c.cmd) check(`${c.status}: button runs ${c.cmd}`, shim.calls.executeCommand.some((x) => x.id === c.cmd), true);
		if (c.external) check(`${c.status}: opens billing`, shim.calls.openExternal.includes(c.external), true);
		provider.dispose();
	}
	// --- 429 is RETRIED, then mapped: three attempts, ~3s of backoff, then the
	// final response is handed back so the user gets the formatted error + toast ---
	{
		// SLOW (~3s): fetchWithRetry does attempts=3 with 1s + 2s exponential
		// backoff before giving up. Nothing here can be shortened without
		// reaching into src/, so the suite pays the 3 seconds.
		shim.reset();
		const { provider, output } = makeProvider();
		// A Response body can only be read once and fetchWithRetry drains each
		// retried attempt, so hand runTurn a FACTORY: one fresh 429 per attempt.
		const t = await quiet(() => runTurn(provider, { response: () => jsonResponse(429, { error: { message: "rate" } }) }));
		check("429 was retried, not surfaced on the first attempt", t.captured.attempts, 3);
		checkMatch("…each attempt logged with the status", output.text(), /"status":429/);
		checkMatch("…the last attempt records willRetry:false", output.text(), /"attempt":3,"status":429,"willRetry":false/);
		// After the last attempt fetchWithRetry RETURNS the 429 response (body
		// intact) instead of throwing its own transport error, so provider.ts
		// reaches `if (!response.ok)` → formatApiError → notifyApiError exactly
		// as for the non-retryable statuses above. Before this was fixed the
		// user saw a bare "HTTP 429" and no toast at all on the chat path.
		checkMatch("exhausted retries surface the formatted API error (body included)", t.error?.message, /DeepSeek API error: 429.*rate/);
		checkMatch("…and the rate-limit warning toast is shown on the chat path", shim.calls.showWarningMessage.at(-1)?.message, /rate limited \(429\)/);
		check("…with NO buttons", shim.calls.showWarningMessage.at(-1)?.items.length, 0);
		check("…and no error toast", shim.calls.showErrorMessage.length, 0);
		provider.dispose();
	}
	// --- the same 429 toast from refreshBalance (plain fetch, no retry wrapper) ---
	{
		shim.reset();
		const { provider } = makeProvider();
		onFetch(
			(u) => u.includes("/user/balance"),
			() => jsonResponse(429, { error: { message: "rate" } }),
		);
		await provider.refreshBalance(false);
		checkMatch("rate-limit warning names the status", shim.calls.showWarningMessage.at(-1)?.message, /rate limited \(429\)/);
		check("…and offers NO buttons", shim.calls.showWarningMessage.at(-1)?.items.length, 0);
		check("…it is a warning, not an error toast", shim.calls.showErrorMessage.length, 0);
		provider.dispose();
	}
	// --- usage pipeline: estimator EMA, usage DataPart gating ---
	{
		shim.reset();
		const { provider } = makeProvider();
		check("estimator starts at 3.0", provider._charsPerToken, 3.0);
		const text = "x".repeat(300); // 300 chars
		await runTurn(provider, { messages: [userText(text)], chunks: ok({ prompt_tokens: 150, completion_tokens: 1 }) }); // observed ratio 2.0 → EMA 3*0.7+2*0.3 = 2.7
		check("EMA moves toward the observed ratio", provider._charsPerToken.toFixed(2), "2.70");
		const dp = (await runTurn(provider, { messages: [userText("real turn")], chunks: ok({ prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 0 }) })).progress.dataParts();
		check("real turn reports a usage DataPart", dp.length === 1 && dp[0].mimeType === "usage", true);
		check("…with the host's field names", JSON.parse(new TextDecoder().decode(dp[0].data)).prompt_tokens, 20);
		const title = await runTurn(provider, { messages: [textMsg(99, "You are an expert in crafting ultra-compact titles for chats"), userText("x")], chunks: ok({ prompt_tokens: 20, completion_tokens: 2 }) });
		check("chat-title auxiliary request: no usage DataPart", title.progress.dataParts().length, 0);
		check("session request counter advanced", provider._sessionRequestCount, 3);
		provider.dispose();
	}
	// --- cache-breakdown warning: peak ≥ 70% then ≤ 20% with ≥ 1 reasoning miss ---
	{
		shim.reset();
		shim.answers.showWarningMessage = "Show Cache Stats";
		const { provider } = makeProvider();
		await runTurn(provider, { messages: [userText("q1")], chunks: ok({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, completion_tokens: 1 }) });
		check("no warning while healthy", shim.calls.showWarningMessage.length, 0);
		// History carries an assistant turn the cache never saw → miss → "" stub; usage shows 0% hit.
		await runTurn(provider, { messages: [userText("q1"), assistantText("never streamed here"), userText("q2")], chunks: ok({ prompt_tokens: 1000, prompt_cache_hit_tokens: 0, completion_tokens: 1 }) });
		await tick();
		checkMatch("breakdown warning fired", shim.calls.showWarningMessage.at(-1)?.message, /prompt cache hit rate dropped to 0% \(peak 80%\)/);
		check("…buttons", shim.calls.showWarningMessage.at(-1)?.items.join(","), "Start New Chat,Show Cache Stats");
		check("…Show Cache Stats runs the command", shim.calls.executeCommand.some((x) => x.id === "deepseekv4.showCacheStats"), true);
		provider.dispose();
	}
	// --- context nudge at 95% with 80% re-arm ---
	{
		shim.reset();
		shim.answers.showWarningMessage = "Compact Conversation";
		const { provider, output } = makeProvider();
		await runTurn(provider, { messages: [userText("q")], chunks: ok({ prompt_tokens: 1_000_000, completion_tokens: 0 }) }); // 1,000,000 / 1,048,576 = 95.4%
		await tick();
		checkMatch("nudge fired at ≥95%", shim.calls.showWarningMessage.at(-1)?.message, /context window at 95%/);
		check("…Compact runs the bridge command", shim.calls.executeCommand.some((x) => x.id === "deepseekv4.compactCopilotChat"), true);
		const n = shim.calls.showWarningMessage.length;
		await runTurn(provider, { messages: [userText("q")], chunks: ok({ prompt_tokens: 1_000_000, completion_tokens: 0 }) });
		check("does not re-fire while still high", shim.calls.showWarningMessage.length, n);
		await runTurn(provider, { messages: [userText("q")], chunks: ok({ prompt_tokens: 100, completion_tokens: 0 }) });
		checkMatch("re-armed below 80%", output.text(), /context\.nudge\.rearmed/);
		await runTurn(provider, { messages: [userText("q")], chunks: ok({ prompt_tokens: 1_000_000, completion_tokens: 0 }) });
		check("fires again after re-arm", shim.calls.showWarningMessage.length, n + 1);
		provider.dispose();
	}
	summary("adapter_provider_request");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
