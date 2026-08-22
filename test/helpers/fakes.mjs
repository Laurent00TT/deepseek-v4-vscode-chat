// Fakes for the adapter suites. Must be imported under the shim preload
// (`node test/run_tests.mjs adapter` does that); `vscode` here is the shim.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const vscode = require("vscode");
export const shim = vscode.__shim;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "out");
export const OUT = (name) => path.join(outDir, name);

// ---------- fake host objects ----------
export function fakeSecrets(initial = {}) {
	const store = new Map(Object.entries(initial));
	const em = new vscode.EventEmitter();
	return {
		get: async (k) => store.get(k),
		store: async (k, v) => {
			store.set(k, v);
			em.fire({ key: k });
		},
		delete: async (k) => {
			store.delete(k);
			em.fire({ key: k });
		},
		onDidChange: em.event,
		_store: store,
		_emit: (key) => em.fire({ key }),
	};
}
export function fakeMemento(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		get: (k, def) => (data.has(k) ? data.get(k) : def),
		update: async (k, v) => {
			data.set(k, v);
		},
		keys: () => [...data.keys()],
		_data: data,
	};
}
export function fakeOutputChannel() {
	return vscode.window.createOutputChannel("DeepSeek V4 (test)");
}
export function fakeStatusBarItem() {
	return vscode.window.createStatusBarItem();
}
export function cancellation() {
	const cts = new vscode.CancellationTokenSource();
	return { token: cts.token, cancel: () => cts.cancel() };
}
export function progressCollector() {
	const parts = [];
	return {
		parts,
		report: (p) => parts.push(p),
		texts: () => parts.filter((p) => p instanceof vscode.LanguageModelTextPart).map((p) => p.value),
		toolCalls: () => parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart),
		dataParts: () => parts.filter((p) => p instanceof vscode.LanguageModelDataPart),
		thinking: () =>
			parts.filter((p) => vscode.LanguageModelThinkingPart && p instanceof vscode.LanguageModelThinkingPart),
	};
}

// ---------- SSE fixtures ----------
export const sse = (obj) => `data: ${JSON.stringify(obj)}\n`;
export const DONE = "data: [DONE]\n";
/** Chunk that carries a text delta. */
export const contentChunk = (text) => sse({ choices: [{ index: 0, delta: { content: text } }] });
/** Chunk that carries a reasoning delta. */
export const reasoningChunk = (text) => sse({ choices: [{ index: 0, delta: { reasoning_content: text } }] });
/** Chunk that carries a tool-call delta (id/name only on the first piece). */
export const toolCallChunk = (index, { id, name, args } = {}) =>
	sse({
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index,
							...(id ? { id } : {}),
							...(name || args !== undefined
								? { function: { ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) } }
								: {}),
						},
					],
				},
			},
		],
	});
export const finishChunk = (reason) => sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
/** DeepSeek's final usage chunk: EMPTY choices + usage. */
export const usageChunk = (usage) => sse({ choices: [], usage });

export function sseStream(chunks) {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(enc.encode(chunks[i++]));
			} else {
				controller.close();
			}
		},
	});
}
/** Emits `chunks`, then never ends — only a reader.cancel() releases it. */
export function hangingStream(chunks) {
	const enc = new TextEncoder();
	let i = 0;
	const state = { cancelled: false };
	const stream = new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(enc.encode(chunks[i++]));
				return undefined;
			}
			return new Promise(() => {}); // hang until cancel()
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
}

// ---------- fetch stubbing ----------
const routes = [];
let installed = false;
export function stubFetch() {
	if (installed) {
		return;
	}
	installed = true;
	globalThis.fetch = async (url, init) => {
		const u = String(url);
		for (const r of routes) {
			if (r.matcher(u, init)) {
				return r.handler(u, init);
			}
		}
		throw new Error(`fakes.stubFetch: unexpected fetch ${init?.method ?? "GET"} ${u}`);
	};
}
/**
 * Add a route; `matcher(url, init)` → boolean; `handler(url, init)` → Response.
 * Newest route wins. Returns a disposer that removes just this route, so
 * per-turn routes don't accumulate across scenarios.
 */
export function onFetch(matcher, handler) {
	const route = { matcher, handler };
	routes.unshift(route);
	return () => offFetch(route);
}
/** Remove one route previously added by `onFetch` (module-local: callers get
 * the disposer `onFetch` returns, never the route object itself). */
function offFetch(route) {
	const i = routes.indexOf(route);
	if (i >= 0) {
		routes.splice(i, 1);
	}
}
export function resetFetch() {
	routes.length = 0;
	stubFetch();
	// Default balance route so the provider constructor's silent refresh succeeds.
	onFetch(
		(u) => u.includes("/user/balance"),
		() => jsonResponse(200, balanceJson("100.00")),
	);
}
export function balanceJson(total, currency = "CNY") {
	return {
		is_available: true,
		balance_infos: [{ currency, total_balance: total, granted_balance: "0.00", topped_up_balance: total }],
	};
}
export function jsonResponse(status, body, headers = {}) {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
export function sseResponse(chunks, init = {}) {
	return new Response(Array.isArray(chunks) ? sseStream(chunks) : chunks, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
		...init,
	});
}

// ---------- provider construction ----------
export function makeProvider(overrides = {}) {
	resetFetch();
	const { DeepSeekV4ChatModelProvider } = require(OUT("provider.js"));
	const secrets = overrides.secrets ?? fakeSecrets({ "deepseekv4.apiKey": "sk-test" });
	const memento = overrides.memento ?? fakeMemento();
	const output = overrides.output ?? fakeOutputChannel();
	const statusBar = overrides.statusBar ?? fakeStatusBarItem();
	const provider = new DeepSeekV4ChatModelProvider(
		secrets,
		overrides.userAgent ?? "test-ua/0.0",
		output,
		memento,
		statusBar,
	);
	return { provider, secrets, memento, output, statusBar };
}

// ---------- message builders (VS Code shapes) ----------
const Role = vscode.LanguageModelChatMessageRole;
export const textMsg = (role, text) => ({ role, content: [new vscode.LanguageModelTextPart(text)] });
export const userText = (text) => textMsg(Role.User, text);
export const assistantText = (text) => textMsg(Role.Assistant, text);
export const userImageMsg = (text, bytes, mime = "image/png") => ({
	role: Role.User,
	content: [new vscode.LanguageModelTextPart(text), new vscode.LanguageModelDataPart(bytes, mime)],
});
export const assistantToolCallMsg = (text, calls) => ({
	role: Role.Assistant,
	content: [
		...(text ? [new vscode.LanguageModelTextPart(text)] : []),
		...calls.map((c) => new vscode.LanguageModelToolCallPart(c.callId, c.name, c.input)),
	],
});
export const toolResultMsg = (results) => ({
	role: Role.User,
	content: results.map((r) => new vscode.LanguageModelToolResultPart(r.callId, r.content)),
});
/** Picker-info shape the host passes back to provideLanguageModelChatResponse. */
export function model(id) {
	const { findVariant } = require(OUT("model_catalog.js"));
	const v = findVariant(id);
	if (!v) {
		throw new Error(`unknown variant ${id}`);
	}
	return {
		id: v.id,
		name: v.displayName,
		family: "deepseek-v4",
		version: "1.0.0",
		maxInputTokens: v.maxInputTokens,
		maxOutputTokens: v.maxOutputTokens,
	};
}

/**
 * Run one provideLanguageModelChatResponse turn against a stubbed
 * /chat/completions. `opts.response` is a Response, or a FUNCTION returning
 * one — a Response body can only be read once, so retry scenarios (429/5xx)
 * must pass a factory to get a fresh Response per attempt (default: SSE from
 * `opts.chunks`); `opts.progress` supplies a custom collector (default:
 * `progressCollector()`) for scenarios that need to act on parts as they
 * are reported. The turn's route is removed when it finishes.
 * Returns captured request + progress + error.
 */
export async function runTurn(provider, opts) {
	const captured = {};
	const offRoute = onFetch(
		(u, init) => u.endsWith("/chat/completions") && init?.method === "POST",
		(u, init) => {
			captured.url = u;
			captured.headers = init.headers;
			captured.body = init.body;
			captured.attempts = (captured.attempts ?? 0) + 1;
			const preset = typeof opts.response === "function" ? opts.response() : opts.response;
			return preset ?? sseResponse(opts.chunks ?? [DONE]);
		},
	);
	const progress = opts.progress ?? progressCollector();
	const { token } = opts.cancellation ?? cancellation();
	let error;
	try {
		await provider.provideLanguageModelChatResponse(
			opts.model ?? model("deepseek-v4-pro::thinking"),
			opts.messages ?? [userText("hello")],
			opts.options ?? {},
			progress,
			token,
		);
	} catch (e) {
		error = e;
	} finally {
		offRoute();
	}
	return { captured, progress, error };
}
export const tick = () => new Promise((r) => setTimeout(r, 0));
