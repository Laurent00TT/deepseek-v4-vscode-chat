// Request assembly and post-usage behaviour of provideLanguageModelChatResponse:
// headers/body, pre-flight guards (token overflow, 32 MiB image, 48 MiB body),
// API error → notification mapping, and the usage pipeline (estimator EMA,
// usage DataPart gating, cache-breakdown warning, context nudge hysteresis).
import { check, checkMatch, summary, withConsole } from "./helpers/check.mjs";
import {
	vscode,
	shim,
	makeProvider,
	runTurn,
	model,
	userText,
	textMsg,
	assistantText,
	userImageMsg,
	jsonResponse,
	onFetch,
	contentChunk,
	finishChunk,
	usageChunk,
	DONE,
	tick,
	fakeSecrets,
} from "./helpers/fakes.mjs";

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
	// --- 32 MiB per-image pre-check (vision variant) ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const big = new Uint8Array(32 * 1024 * 1024 + 1);
		const t = await quiet(() =>
			runTurn(provider, { model: model("deepseek-v4-flash-vision-exp"), messages: [userImageMsg("look", big)] })
		);
		checkMatch("oversized image throws", t.error?.message, /32 MiB per-image limit/);
		check("no request was sent", t.captured.url, undefined);
		checkMatch("toast is actionable", shim.calls.showErrorMessage.at(-1)?.message, /Attach a smaller image, or start a new chat/);
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
				model: model("deepseek-v4-flash-vision-exp"),
				messages: [userImageMsg("a", img), userImageMsg("b", img), userImageMsg("c", img)],
			})
		);
		checkMatch("oversized body throws", t.error?.message, /48 MiB limit/);
		checkMatch("toast says fewer/smaller images", shim.calls.showErrorMessage.at(-1)?.message, /Attach fewer or smaller images/);
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
	// --- 429 is RETRIED, not mapped: three attempts, ~3s of backoff, then throw ---
	{
		// SLOW (~3s): fetchWithRetry does attempts=3 with 1s + 2s exponential
		// backoff before giving up. Nothing here can be shortened without
		// reaching into src/, so the suite pays the 3 seconds.
		shim.reset();
		const { provider, output } = makeProvider();
		// A Response body can only be read once and fetchWithRetry drains each
		// attempt, so hand runTurn a FACTORY: one fresh 429 per attempt.
		const t = await quiet(() => runTurn(provider, { response: () => jsonResponse(429, { error: { message: "rate" } }) }));
		check("429 was retried, not surfaced on the first attempt", t.captured.attempts, 3);
		checkMatch("…each attempt logged with the status", output.text(), /"status":429/);
		checkMatch("…the last attempt records willRetry:false", output.text(), /"attempt":3,"status":429,"willRetry":false/);
		// DIVERGENCE, pinned deliberately: notifyApiError's 429 branch is
		// UNREACHABLE from the chat path. fetchWithRetry treats 429 as retryable
		// and, once attempts are exhausted, throws its own `HTTP <status>
		// <statusText>` error (api_client.ts) instead of returning the response,
		// so provider.ts never reaches `if (!response.ok)` → formatApiError →
		// notifyApiError. Hence a bare "HTTP 429" and NO toast on this path.
		checkMatch("exhausted retries throw the transport error, not a formatted API error", t.error?.message, /^HTTP 429/);
		check("…so no 'DeepSeek API error: 429' is produced here", /DeepSeek API error: 429/.test(String(t.error?.message)), false);
		check("…and the chat path shows the user no toast at all", shim.calls.showWarningMessage.length + shim.calls.showErrorMessage.length, 0);
		provider.dispose();
	}
	// --- the 429 → "rate limited" toast, on the path that can actually reach it ---
	{
		// refreshBalance uses a plain fetch (no retry wrapper), so a 429 there
		// does reach notifyApiError. This is the only live caller of that branch.
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
