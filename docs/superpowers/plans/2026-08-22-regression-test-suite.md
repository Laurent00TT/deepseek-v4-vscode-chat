# Regression Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `npm test` the power to catch wire-byte changes, frozen-identifier / persisted-format changes, and adapter-behaviour changes (streaming, cancellation, error mapping, picker, activation) across upgrades.

**Architecture:** Pure modules keep their mock-free Node tests. The three `vscode`-coupled adapters (`out/utils.js`, `out/provider.js`, `out/extension.js`) are tested as compiled against a minimal hand-written `vscode` replacement (`test/vscode_shim/index.cjs`) injected by a `--require` preload that patches `Module._resolveFilename`. Shared helpers build fake `secrets` / `Memento` / `OutputChannel` / `StatusBarItem`, fake SSE streams, and a `fetch` stub. Coverage is reported with `c8` (devDependency only).

**Tech Stack:** Node 24 (plain `.mjs` test scripts, no framework), TypeScript compiled to CommonJS (`out/`), `c8` for coverage. Spec: `docs/superpowers/specs/2026-08-22-regression-test-suite-design.md`.

## Global Constraints

- Production code in `src/` is **not** modified by this plan (every task touches `test/`, `package.json` scripts/devDependencies, `.github/workflows/ci.yml`, and docs only).
- Zero runtime dependencies stay zero: `c8` goes under `devDependencies` only.
- Pure-module tests (`test/unit_*.mjs`) must not import the shim or anything that requires `vscode`.
- The shim may add **APIs** the adapters use; it must not add **behaviour** VS Code does not have. It records calls and returns preset answers.
- Test files: tabs, double quotes, semicolons (match the existing suites). `.cjs` files are prettier-checked — run `npx prettier --write` on them. `test/` is eslint-ignored; `*.mjs` is prettier-ignored.
- Frozen identifiers pinned verbatim: vendor `deepseek-v4`; model ids `deepseek-v4-pro::thinking`, `deepseek-v4-pro`, `deepseek-v4-flash::thinking`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp::thinking`, `deepseek-v4-flash-vision-exp`; settings `deepseekv4.reasoningEffort`, `deepseekv4.logRawReasoning`; SecretStorage key `deepseekv4.apiKey`; globalState keys `deepseekv4.reasoningCache`, `deepseekv4.welcomeShown`; command ids `deepseekv4.manage`, `deepseekv4.showLog`, `deepseekv4.refreshBalance`, `deepseekv4.clearSession`, `deepseekv4.showCacheStats`, `deepseekv4.clearReasoningCache`, `deepseekv4.compactCopilotChat` (+ unexposed `deepseekv4.showContextWindow`).
- Every provider test must call `provider.dispose()` (the constructor arms timers) or end with `summary()` (which calls `process.exit`).
- Verification before each commit: `npm run compile && npm test` (later tasks: `npm run test:coverage`) and `npx prettier --check .`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `test/vscode_shim/index.cjs` | Minimal `vscode` module: part classes, enums, `MarkdownString`, `EventEmitter`, recordable `window` / `commands` / `workspace` / `env` / `lm` / `extensions`; `__shim` control object (`calls`, `answers`, `reset`, `installThinkingPart`). |
| `test/vscode_shim/register.cjs` | `--require` preload mapping the bare specifier `vscode` to `index.cjs`. |
| `test/run_tests.mjs` | `node test/run_tests.mjs unit` runs every `test/unit_*.mjs` in plain Node; `node test/run_tests.mjs adapter` runs every `test/adapter_*.mjs` with the shim preload. Alphabetical, fail-fast. Adding a suite needs no `package.json` edit. |
| `test/helpers/check.mjs` | `check`, `checkDeep`, `checkMatch`, `summary` — shared assertion/summary with the existing output format. |
| `test/helpers/fakes.mjs` | `vscode` / `shim` access from ESM, fake host objects, `sseStream` / `hangingStream`, fetch stubbing (`stubFetch`, `onFetch`, `resetFetch`, `balanceJson`, `sseResponse`), `makeProvider`, `runTurn`, message builders. |
| `test/adapter_smoke.mjs` | Proves the preload chain (Task 1). |
| `test/unit_model_catalog.mjs`, `test/unit_manifest.mjs`, `test/unit_tool_payload.mjs` | Pure-module additions. |
| `test/adapter_convert_messages.mjs`, `test/adapter_request_golden.mjs`, `test/adapter_provider_reasoning.mjs`, `test/adapter_provider_stream.mjs`, `test/adapter_provider_request.mjs`, `test/adapter_provider_info.mjs`, `test/adapter_extension_activate.mjs` | Adapter suites. |
| `package.json` | `test:unit` / `test:adapter` become the glob runner; `test:coverage`; `c8` devDependency. |
| `.github/workflows/ci.yml` | Coverage report step. |
| `CONTRIBUTING.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | Test-strategy docs. |

---

### Task 1: vscode shim, preload, runner, helpers, smoke test

**Files:**
- Create: `test/vscode_shim/index.cjs`
- Create: `test/vscode_shim/register.cjs`
- Create: `test/run_tests.mjs`
- Create: `test/helpers/check.mjs`
- Create: `test/helpers/fakes.mjs`
- Create: `test/adapter_smoke.mjs`
- Modify: `package.json` (scripts `test:unit`, `test:adapter`, `test`)

**Interfaces:**
- Produces `vscode.__shim`: `{ calls: { showErrorMessage: Array<{message, items}>, showWarningMessage, showInformationMessage, showInputBox: Array<opts>, setStatusBarMessage: Array<{text, ms}>, executeCommand: Array<{id, args}>, registerCommand: string[], registerProvider: Array<{vendor, provider}>, openExternal: string[], withProgress: Array<opts> }, answers: { showErrorMessage, showWarningMessage, showInformationMessage, showInputBox, getConfiguration: Record<section, Record<key, value>>, getCommands: string[], extension }, registeredCommands: Map<string, Function>, outputChannels: FakeOutputChannel[], statusBarItems: FakeStatusBarItem[], reset(): void, installThinkingPart(): void, removeThinkingPart(): void }`.
- Produces helpers (`test/helpers/check.mjs`): `check(label, got, expected)`, `checkDeep(label, got, expected)` (JSON-compare), `checkMatch(label, got, regex)`, `summary(suiteName)` (prints `=== Results: N passed, M failed ===`, exits 1 on failures, 0 otherwise).
- Produces helpers (`test/helpers/fakes.mjs`): `vscode`, `shim`, `fakeSecrets(initial?)`, `fakeMemento(initial?)`, `fakeOutputChannel()`, `fakeStatusBarItem()`, `cancellation()`, `progressCollector()`, `sse(obj)`, `DONE`, `sseStream(chunks)`, `hangingStream(chunks)`, `stubFetch()`, `onFetch(matcher, handler)`, `resetFetch()`, `balanceJson(total, currency?)`, `sseResponse(chunks, init?)`, `jsonResponse(status, body)`, `makeProvider(overrides?)`, `runTurn(provider, opts)`, `textMsg(role, text)`, `userImageMsg(text, bytes, mime)`, `assistantToolCallMsg(text, calls)`, `toolResultMsg(results)`, `model(id)`.

- [ ] **Step 1: Write `test/vscode_shim/index.cjs`**

```js
"use strict";
// Minimal `vscode` replacement for adapter tests. Records calls, returns preset
// answers, adds no behaviour of its own. Only the API surface used by
// src/utils.ts, src/provider.ts and src/extension.ts exists here.

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
	static json(value, mime = "application/json") {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
	}
	static image(data, mime) {
		return new LanguageModelDataPart(data, mime);
	}
	static text(value, mime = "text/plain") {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
	}
}
class MarkdownString {
	constructor(value = "") {
		this.value = value;
		this.isTrusted = false;
		this.supportThemeIcons = false;
	}
	appendMarkdown(s) {
		this.value += s;
		return this;
	}
}
class ThemeIcon {
	constructor(id) {
		this.id = id;
	}
}
class ThemeColor {
	constructor(id) {
		this.id = id;
	}
}
class Disposable {
	constructor(fn) {
		this._fn = fn;
	}
	dispose() {
		if (this._fn) {
			this._fn();
			this._fn = undefined;
		}
	}
}
class EventEmitter {
	constructor() {
		this._listeners = new Set();
		this.event = (listener) => {
			this._listeners.add(listener);
			return new Disposable(() => this._listeners.delete(listener));
		};
	}
	fire(e) {
		for (const l of [...this._listeners]) {
			l(e);
		}
	}
	dispose() {
		this._listeners.clear();
	}
}
class CancellationTokenSource {
	constructor() {
		this._em = new EventEmitter();
		this.token = { isCancellationRequested: false, onCancellationRequested: this._em.event };
	}
	cancel() {
		this.token.isCancellationRequested = true;
		this._em.fire();
	}
	dispose() {
		this._em.dispose();
	}
}
const Uri = {
	parse: (s) => ({ scheme: s.split(":")[0], value: s, toString: () => s }),
};

const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const ViewColumn = { Active: -1, Beside: -2, One: 1 };

function freshCalls() {
	return {
		showErrorMessage: [],
		showWarningMessage: [],
		showInformationMessage: [],
		showInputBox: [],
		setStatusBarMessage: [],
		executeCommand: [],
		registerCommand: [],
		registerProvider: [],
		openExternal: [],
		withProgress: [],
	};
}
function freshAnswers() {
	return {
		showErrorMessage: undefined,
		showWarningMessage: undefined,
		showInformationMessage: undefined,
		showInputBox: undefined,
		getConfiguration: {},
		getCommands: [],
		extension: undefined,
	};
}
const __shim = {
	calls: freshCalls(),
	answers: freshAnswers(),
	registeredCommands: new Map(),
	outputChannels: [],
	statusBarItems: [],
	reset() {
		this.calls = freshCalls();
		this.answers = freshAnswers();
		this.registeredCommands.clear();
		this.outputChannels.length = 0;
		this.statusBarItems.length = 0;
	},
	installThinkingPart() {
		module.exports.LanguageModelThinkingPart = class LanguageModelThinkingPart {
			constructor(value, id, metadata) {
				this.value = value;
				this.id = id;
				this.metadata = metadata;
			}
		};
	},
	removeThinkingPart() {
		delete module.exports.LanguageModelThinkingPart;
	},
};

// A preset answer may be a value or a function of (message, items).
function answer(name, message, items) {
	const a = __shim.answers[name];
	return typeof a === "function" ? a(message, items) : a;
}

function makeOutputChannel(name) {
	const ch = {
		name,
		lines: [],
		appendLine(s) {
			this.lines.push(String(s));
		},
		append(s) {
			this.lines.push(String(s));
		},
		show() {},
		hide() {},
		clear() {
			this.lines.length = 0;
		},
		dispose() {},
		text() {
			return this.lines.join("\n");
		},
	};
	__shim.outputChannels.push(ch);
	return ch;
}
function makeStatusBarItem() {
	const item = {
		text: "",
		tooltip: undefined,
		color: undefined,
		backgroundColor: undefined,
		command: undefined,
		shown: 0,
		show() {
			this.shown++;
		},
		hide() {},
		dispose() {},
	};
	__shim.statusBarItems.push(item);
	return item;
}

const window = {
	showErrorMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showErrorMessage.push({ message, items });
		return answer("showErrorMessage", message, items);
	},
	showWarningMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showWarningMessage.push({ message, items });
		return answer("showWarningMessage", message, items);
	},
	showInformationMessage: async (message, ...rest) => {
		const items = rest.filter((r) => typeof r === "string");
		__shim.calls.showInformationMessage.push({ message, items });
		return answer("showInformationMessage", message, items);
	},
	showInputBox: async (opts) => {
		__shim.calls.showInputBox.push(opts);
		return answer("showInputBox", opts, []);
	},
	setStatusBarMessage: (text, ms) => {
		__shim.calls.setStatusBarMessage.push({ text, ms });
		return new Disposable();
	},
	withProgress: async (opts, task) => {
		__shim.calls.withProgress.push(opts);
		return task({ report() {} }, new CancellationTokenSource().token);
	},
	createOutputChannel: (name) => makeOutputChannel(name),
	createStatusBarItem: () => makeStatusBarItem(),
	createWebviewPanel: () => {
		throw new Error("createWebviewPanel is not available in the test shim");
	},
};
const commands = {
	executeCommand: async (id, ...args) => {
		__shim.calls.executeCommand.push({ id, args });
		const handler = __shim.registeredCommands.get(id);
		return handler ? handler(...args) : undefined;
	},
	registerCommand: (id, handler) => {
		__shim.registeredCommands.set(id, handler);
		__shim.calls.registerCommand.push(id);
		return new Disposable(() => __shim.registeredCommands.delete(id));
	},
	getCommands: async () => [...__shim.answers.getCommands],
};
const workspace = {
	getConfiguration: (section) => ({
		get: (key, def) => {
			const s = __shim.answers.getConfiguration[section] ?? {};
			return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : def;
		},
	}),
};
const env = {
	openExternal: async (uri) => {
		__shim.calls.openExternal.push(String(uri));
		return true;
	},
};
const lm = {
	registerLanguageModelChatProvider: (vendor, provider) => {
		__shim.calls.registerProvider.push({ vendor, provider });
		return new Disposable();
	},
};
const extensions = {
	getExtension: () => __shim.answers.extension,
};

module.exports = {
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelDataPart,
	MarkdownString,
	ThemeIcon,
	ThemeColor,
	Disposable,
	EventEmitter,
	CancellationTokenSource,
	Uri,
	LanguageModelChatMessageRole,
	LanguageModelChatToolMode,
	StatusBarAlignment,
	ProgressLocation,
	ViewColumn,
	window,
	commands,
	workspace,
	env,
	lm,
	extensions,
	version: "1.106.0-shim",
	__shim,
};
```

- [ ] **Step 2: Write `test/vscode_shim/register.cjs`**

```js
"use strict";
// `node --require ./test/vscode_shim/register.cjs test/adapter_x.mjs`
// Resolves the bare specifier "vscode" (required by the compiled adapters in
// out/) to the test shim. CJS-only on purpose: out/*.js is CommonJS.
const Module = require("node:module");
const path = require("node:path");

const shimPath = path.join(__dirname, "index.cjs");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithShim(request, ...rest) {
	if (request === "vscode") {
		return shimPath;
	}
	return originalResolve.call(this, request, ...rest);
};
```

- [ ] **Step 3: Write `test/run_tests.mjs`**

```js
// Runs one family of suites in alphabetical order, fail-fast:
//   node test/run_tests.mjs unit     → test/unit_*.mjs    (plain Node, no vscode)
//   node test/run_tests.mjs adapter  → test/adapter_*.mjs (vscode shim preload)
// Adding a suite is just adding a file — no package.json edit.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const family = process.argv[2];
if (family !== "unit" && family !== "adapter") {
	console.error("usage: node test/run_tests.mjs <unit|adapter>");
	process.exit(2);
}
const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
	.filter((f) => f.startsWith(`${family}_`) && f.endsWith(".mjs"))
	.sort();
if (files.length === 0) {
	console.error(`run_tests: no test/${family}_*.mjs files found`);
	process.exit(1);
}
const preload = family === "adapter" ? ["--require", path.join(testDir, "vscode_shim", "register.cjs")] : [];
for (const f of files) {
	console.log(`\n### ${f}`);
	const r = spawnSync(process.execPath, [...preload, path.join(testDir, f)], { stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`run_tests: ${f} exited with ${r.status}`);
		process.exit(r.status ?? 1);
	}
}
console.log(`\nrun_tests: ${files.length} ${family} suites passed`);
```

- [ ] **Step 4: Write `test/helpers/check.mjs`**

```js
// Shared assertion helpers. Output format matches the existing unit suites
// ("  ✓ label" / "  ✗ label", then "=== Results: N passed, M failed ===").
import process from "node:process";

let passed = 0;
let failed = 0;
const failures = [];

function record(ok, label, got, expected) {
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${safe(expected)}\n      got     =${safe(got)}`);
		console.log(`  ✗ ${label}`);
	}
}
function safe(v) {
	try {
		return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

/** Strict Object.is comparison. */
export function check(label, got, expected) {
	record(Object.is(got, expected), label, got, expected);
}
/** Structural comparison via JSON.stringify. */
export function checkDeep(label, got, expected) {
	record(JSON.stringify(got) === JSON.stringify(expected), label, got, expected);
}
/** Regex match against String(got). */
export function checkMatch(label, got, regex) {
	record(regex.test(String(got)), label, got, String(regex));
}
/** Print the summary line and exit (1 if anything failed). */
export function summary(suiteName = "") {
	console.log("");
	console.log(`=== Results: ${passed} passed, ${failed} failed ===${suiteName ? `  (${suiteName})` : ""}`);
	if (failed > 0) {
		console.log("\nFailures:");
		for (const f of failures) {
			console.log(f);
		}
		process.exit(1);
	}
	process.exit(0);
}
```

- [ ] **Step 5: Write `test/helpers/fakes.mjs`**

```js
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
							...(name || args !== undefined ? { function: { ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) } } : {}),
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
/** Add a route; `matcher(url, init)` → boolean; `handler(url, init)` → Response. Newest route wins. */
export function onFetch(matcher, handler) {
	routes.unshift({ matcher, handler });
}
export function resetFetch() {
	routes.length = 0;
	stubFetch();
	// Default balance route so the provider constructor's silent refresh succeeds.
	onFetch((u) => u.includes("/user/balance"), () => jsonResponse(200, balanceJson("100.00")));
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
	const provider = new DeepSeekV4ChatModelProvider(secrets, overrides.userAgent ?? "test-ua/0.0", output, memento, statusBar);
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
	return { id: v.id, name: v.displayName, family: "deepseek-v4", version: "1.0.0", maxInputTokens: v.maxInputTokens, maxOutputTokens: v.maxOutputTokens };
}

/**
 * Run one provideLanguageModelChatResponse turn against a stubbed
 * /chat/completions. `opts.response` is a Response (default: SSE from
 * `opts.chunks`). Returns captured request + progress + error.
 */
export async function runTurn(provider, opts) {
	const captured = {};
	onFetch(
		(u, init) => u.endsWith("/chat/completions") && init?.method === "POST",
		(u, init) => {
			captured.url = u;
			captured.headers = init.headers;
			captured.body = init.body;
			return opts.response ?? sseResponse(opts.chunks ?? [DONE]);
		},
	);
	const progress = progressCollector();
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
	}
	return { captured, progress, error };
}
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 6: Write `test/adapter_smoke.mjs`**

```js
// Proves the preload chain: out/utils.js requires "vscode" and must receive
// the shim; convertTools with no tools returns {} (pure path through the adapter).
import { check, summary } from "./helpers/check.mjs";
import { vscode, shim, OUT } from "./helpers/fakes.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require(OUT("utils.js"));

check("shim is the module the adapter sees", vscode.__shim === shim, true);
check("LanguageModelTextPart comes from the shim", new vscode.LanguageModelTextPart("x").value, "x");
check("convertTools without tools → {}", JSON.stringify(utils.convertTools({})), "{}");
check("LanguageModelThinkingPart absent by default", vscode.LanguageModelThinkingPart, undefined);
shim.installThinkingPart();
check("installThinkingPart exposes the ctor", typeof vscode.LanguageModelThinkingPart, "function");
shim.removeThinkingPart();
check("removeThinkingPart hides it again", vscode.LanguageModelThinkingPart, undefined);
summary("adapter_smoke");
```

- [ ] **Step 7: Switch the scripts in `package.json` to the runner**

Replace the existing `test` and `test:unit` scripts (the 13-item `&&` chain) with, and add `test:adapter`:

```json
"test": "npm run test:unit && npm run test:adapter",
"test:unit": "node test/run_tests.mjs unit",
"test:adapter": "node test/run_tests.mjs adapter",
```

(`pretest` stays `npm run compile`.) The runner picks up the same 13 existing `unit_*.mjs` files alphabetically.

- [ ] **Step 8: Run the smoke test directly and through the runner**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_smoke.mjs`
Expected: 6 ✓, `=== Results: 6 passed, 0 failed ===`.
Run: `npm run test:unit`
Expected: the 13 existing suites each print their results; `run_tests: 13 unit suites passed`.
Run: `npm run test:adapter`
Expected: `### adapter_smoke.mjs` … `run_tests: 1 adapter suites passed`.

- [ ] **Step 9: Verify the harness detects failure**

Temporarily change the smoke test's first expected value to `false`, run again, confirm exit code 1 and the `✗` line, then restore it.

- [ ] **Step 10: Format and commit**

```bash
npx prettier --write test/vscode_shim/index.cjs test/vscode_shim/register.cjs
npx prettier --check . && npm test
git add test/vscode_shim test/helpers test/run_tests.mjs test/adapter_smoke.mjs package.json
git commit -m "test: vscode shim preload, suite runner and shared helpers for adapter suites"
```

---

### Task 2: c8 coverage script + CI step

**Files:**
- Modify: `package.json` (devDependencies `c8`, script `test:coverage`)
- Modify: `.github/workflows/ci.yml` (coverage step after `npm test`)
- Create: `.c8rc.json`

- [ ] **Step 1: Install c8 as a devDependency (exact version)**

Run: `npm install --save-dev --save-exact c8`
Expected: `package.json` devDependencies gains `"c8": "<version>"`, `package-lock.json` updated.

- [ ] **Step 2: Write `.c8rc.json`**

```json
{
	"include": ["out/**/*.js"],
	"exclude": ["out/**/*.map"],
	"reporter": ["text", "text-summary"],
	"all": true,
	"clean": true
}
```

- [ ] **Step 3: Add the script**

```json
"test:coverage": "c8 npm test",
```

- [ ] **Step 4: Run it**

Run: `npm run test:coverage`
Expected: both `test:unit` and `test:adapter` pass, then a per-file table for `out/*.js` and a `Statements`/`Branches`/`Functions`/`Lines` summary. (c8 propagates `NODE_V8_COVERAGE` into the spawned test processes, so the adapter runner's child processes are counted.)

- [ ] **Step 5: CI**

In `.github/workflows/ci.yml`, after the `run: npm test` step add:

```yaml
      - name: Coverage report
        run: npm run test:coverage
```

- [ ] **Step 6: Commit**

```bash
npx prettier --check . && npm run test:coverage
git add package.json package-lock.json .c8rc.json .github/workflows/ci.yml
git commit -m "test: c8 coverage report (devDependency) and CI step"
```

---

### Task 3: `test/unit_model_catalog.mjs` (pure)

**Files:**
- Create: `test/unit_model_catalog.mjs` (picked up automatically by `node test/run_tests.mjs unit`)

- [ ] **Step 1: Write the test**

```js
// Pins the frozen model catalog (CONTRIBUTING red line #2): picker ids, API
// model names, thinking/vision flags and token budgets. Renaming an id
// orphans every user's picker selection; changing a budget changes the
// pre-flight overflow guard and the host's context planning.
//
//     npm test
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { MODEL_VARIANTS, findVariant } from "../out/model_catalog.js";

const EXPECTED = [
	["deepseek-v4-pro::thinking", "DeepSeek V4 Pro (thinking)", "deepseek-v4-pro", true, false, 655360, 393216],
	["deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek-v4-pro", false, false, 983040, 65536],
	["deepseek-v4-flash::thinking", "DeepSeek V4 Flash (thinking)", "deepseek-v4-flash", true, false, 655360, 393216],
	["deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek-v4-flash", false, false, 983040, 65536],
	["deepseek-v4-flash-vision-exp::thinking", "DeepSeek V4 Flash Vision (thinking)", "deepseek-v4-flash-vision-exp", true, true, 655360, 393216],
	["deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision", "deepseek-v4-flash-vision-exp", false, true, 983040, 65536],
];

check("exactly six variants", MODEL_VARIANTS.length, 6);
checkDeep(
	"variant order and frozen fields",
	MODEL_VARIANTS.map((v) => [v.id, v.displayName, v.apiModel, v.thinking, v.vision === true, v.maxInputTokens, v.maxOutputTokens]),
	EXPECTED,
);
check("ids are unique", new Set(MODEL_VARIANTS.map((v) => v.id)).size, 6);
check("first entry is the strongest (host default)", MODEL_VARIANTS[0].id, "deepseek-v4-pro::thinking");
for (const v of MODEL_VARIANTS) {
	check(`${v.id}: tooltip is non-empty copy`, typeof v.tooltip === "string" && v.tooltip.length > 0, true);
	check(`${v.id}: input + output = 1M`, v.maxInputTokens + v.maxOutputTokens, 1048576);
	check(`${v.id}: thinking ⇒ 384K output`, v.thinking ? v.maxOutputTokens : 393216, 393216);
}
check("findVariant hit", findVariant("deepseek-v4-flash")?.displayName, "DeepSeek V4 Flash");
check("findVariant miss", findVariant("deepseek-v4-turbo"), undefined);
check("thinking ids carry the ::thinking suffix", MODEL_VARIANTS.every((v) => v.thinking === v.id.endsWith("::thinking")), true);
summary("unit_model_catalog");
```

- [ ] **Step 2: Run**

Run: `npm run compile && node test/unit_model_catalog.mjs`
Expected: all ✓ (6 + 6×3 + 4 = 28 checks), exit 0.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/unit_model_catalog.mjs && git commit -m "test: pin the frozen model catalog (ids, API names, flags, budgets)"
```

---

### Task 4: `test/unit_manifest.mjs` (pure)

**Files:**
- Create: `test/unit_manifest.mjs` (picked up automatically by `node test/run_tests.mjs unit`)

- [ ] **Step 1: Write the test**

```js
// Pins the package.json contract and the persisted identifiers baked into
// the compiled output: vendor, command ids/titles, settings, engines,
// walkthrough id, SecretStorage/globalState keys. These are user-visible or
// user-persisted; renaming any of them breaks picker selections, keybindings
// or stored state on upgrade (CONTRIBUTING red line #2).
//
//     npm test
import { readFileSync } from "node:fs";
import { check, checkDeep, summary } from "./helpers/check.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionJs = readFileSync(new URL("../out/extension.js", import.meta.url), "utf8");
const providerJs = readFileSync(new URL("../out/provider.js", import.meta.url), "utf8");

// --- identity ---
check("name", pkg.name, "deepseek-v4-vscode-chat");
check("publisher", pkg.publisher, "Laurent00TT");
check("engines.vscode floor", pkg.engines.vscode, "^1.106.0");
check("main entry", pkg.main, "./out/extension.js");
check("zero runtime dependencies", Object.keys(pkg.dependencies ?? {}).length, 0);

// --- provider contribution ---
const providers = pkg.contributes.languageModelChatProviders;
check("one LM provider contributed", providers.length, 1);
check("vendor is frozen", providers[0].vendor, "deepseek-v4");
check("management command", providers[0].managementCommand, "deepseekv4.manage");
check("provider registers the same vendor in code", extensionJs.includes('"deepseek-v4"'), true);

// --- commands ---
checkDeep(
	"contributed commands (id → title)",
	pkg.contributes.commands.map((c) => [c.command, c.title]),
	[
		["deepseekv4.manage", "Manage DeepSeek V4 Provider"],
		["deepseekv4.showLog", "Show DeepSeek V4 Log"],
		["deepseekv4.refreshBalance", "Refresh DeepSeek V4 Balance"],
		["deepseekv4.clearSession", "Clear DeepSeek V4 Session Counter"],
		["deepseekv4.showCacheStats", "Show DeepSeek V4 Reasoning Cache Stats"],
		["deepseekv4.clearReasoningCache", "Clear DeepSeek V4 Reasoning Cache"],
		["deepseekv4.compactCopilotChat", "Compact Copilot Chat"],
	],
);
check("no command carries a category (palette shows the bare title)", pkg.contributes.commands.every((c) => c.category === undefined), true);
for (const id of [...pkg.contributes.commands.map((c) => c.command), "deepseekv4.showContextWindow"]) {
	check(`extension.js registers ${id}`, extensionJs.includes(`"${id}"`), true);
}

// --- settings ---
const props = pkg.contributes.configuration.properties;
checkDeep("settings keys", Object.keys(props).sort(), ["deepseekv4.logRawReasoning", "deepseekv4.reasoningEffort"]);
checkDeep("reasoningEffort enum", props["deepseekv4.reasoningEffort"].enum, ["high", "max"]);
check("reasoningEffort default", props["deepseekv4.reasoningEffort"].default, "max");
check("logRawReasoning type", props["deepseekv4.logRawReasoning"].type, "boolean");
check("logRawReasoning default", props["deepseekv4.logRawReasoning"].default, false);

// --- persisted keys baked into the compiled output ---
check("SecretStorage key", extensionJs.includes('"deepseekv4.apiKey"') && providerJs.includes('"deepseekv4.apiKey"'), true);
check("globalState key: reasoning cache", providerJs.includes('"deepseekv4.reasoningCache"'), true);
check("globalState key: welcome shown", extensionJs.includes('"deepseekv4.welcomeShown"'), true);

// --- walkthrough ---
const wt = pkg.contributes.walkthroughs[0];
check("walkthrough id", wt.id, "deepseekv4GettingStarted");
check("extension.js opens publisher.name#id", extensionJs.includes(`"${pkg.publisher}.${pkg.name}#${wt.id}"`), true);
checkDeep("walkthrough steps", wt.steps.map((s) => s.id), ["setApiKey", "pickModel", "tuneReasoningEffort"]);

// --- packaging hygiene ---
const vscodeignore = readFileSync(new URL("../.vscodeignore", import.meta.url), "utf8");
for (const line of ["src/**", "test/**", ".claude/**", ".git-blame-ignore-revs", "**/*.map"]) {
	check(`.vscodeignore excludes ${line}`, vscodeignore.split(/\r?\n/).includes(line), true);
}
summary("unit_manifest");
```

- [ ] **Step 2: Confirm the `.vscodeignore` lines exist verbatim** (`src/**`, `test/**` may be spelled differently — open the file; if a pattern differs, use the file's exact spelling in the test, do not change `.vscodeignore`).

- [ ] **Step 3: Run**

Run: `npm run compile && node test/unit_manifest.mjs`
Expected: all ✓, exit 0.

- [ ] **Step 4: Commit**

```bash
npm test && git add test/unit_manifest.mjs && git commit -m "test: pin the package.json contract and persisted identifiers"
```

---

### Task 5: `test/unit_tool_payload.mjs` (pure)

**Files:**
- Create: `test/unit_tool_payload.mjs` (picked up automatically by `node test/run_tests.mjs unit`)

- [ ] **Step 1: Write the test**

```js
// Pins buildToolPayload's schema sanitization and tool_choice passthrough —
// the part of the tool wire shape not covered by unit_tool_limit (which
// covers the skip/cap path) or unit_tool_wire_name (aliasing).
//
//     npm test
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { buildToolPayload } from "../out/tool_payload.js";

const one = (tool, required = false) => buildToolPayload([tool], required).tools[0].function;
const silent = (fn) => {
	const orig = console.error;
	console.error = () => {};
	try {
		return fn();
	} finally {
		console.error = orig;
	}
};

// --- envelope ---
check("no tools → {}", JSON.stringify(buildToolPayload([], false)), "{}");
checkDeep("function envelope", buildToolPayload([{ name: "ping" }], false).tools[0], {
	type: "function",
	function: { name: "ping", description: "", parameters: { type: "object", properties: {} } },
});
check("description passthrough", one({ name: "a", description: "desc" }).description, "desc");
check("non-string description → empty", one({ name: "a", description: 42 }).description, "");

// --- tool_choice ---
check("auto when not required", buildToolPayload([{ name: "a" }], false).tool_choice, "auto");
checkDeep("single tool + required → named force", buildToolPayload([{ name: "a" }], true).tool_choice, { type: "function", function: { name: "a" } });
check("multiple tools + required → 'required'", buildToolPayload([{ name: "a" }, { name: "b" }], true).tool_choice, "required");
checkDeep("named force uses the WIRE name of an aliased tool", buildToolPayload([{ name: "weather.get" }], true).tool_choice.function.name.startsWith("weather_get_"), true);

// --- schema sanitization ---
checkDeep("null schema → empty object schema", one({ name: "a", inputSchema: null }).parameters, { type: "object", properties: {} });
checkDeep("array schema → empty object schema", one({ name: "a", inputSchema: [] }).parameters, { type: "object", properties: {} });
checkDeep(
	"unknown keywords pruned, known kept",
	one({ name: "a", inputSchema: { type: "object", properties: {}, $schema: "x", title: "t", description: "d" } }).parameters,
	{ type: "object", properties: {}, description: "d" },
);
checkDeep("missing type defaults to object", one({ name: "a", inputSchema: { properties: { x: { type: "string" } } } }).parameters, {
	properties: { x: { type: "string" } },
	type: "object",
});
checkDeep(
	"anyOf prefers the string branch",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { anyOf: [{ type: "number" }, { type: "string", description: "s" }] } } } }).parameters.properties.v,
	{ type: "string", description: "s" },
);
checkDeep(
	"oneOf without a string branch takes the first",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { oneOf: [{ type: "integer" }, { type: "boolean" }] } } } }).parameters.properties.v,
	{ type: "integer" },
);
check("integer-like property name: number → integer", one({ name: "a", inputSchema: { type: "object", properties: { limit: { type: "number" } } } }).parameters.properties.limit.type, "integer");
check("…also *_id", one({ name: "a", inputSchema: { type: "object", properties: { user_id: { type: "number" } } } }).parameters.properties.user_id.type, "integer");
check("non-integer-like number stays number", one({ name: "a", inputSchema: { type: "object", properties: { ratio: { type: "number" } } } }).parameters.properties.ratio.type, "number");
checkDeep("required filtered to strings", one({ name: "a", inputSchema: { type: "object", properties: {}, required: ["x", 1, null] } }).parameters.required, ["x"]);
checkDeep("non-array required → []", one({ name: "a", inputSchema: { type: "object", properties: {}, required: "x" } }).parameters.required, []);
check("non-boolean additionalProperties removed", "additionalProperties" in one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } } }).parameters, false);
check("boolean additionalProperties kept", one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: false } }).parameters.additionalProperties, false);
checkDeep("array items: tuple → first item", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array", items: [{ type: "number" }, { type: "string" }] } } } }).parameters.properties.l.items, { type: "number" });
checkDeep("array items: object sanitized", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array", items: { type: "object", properties: { n: { type: "number" } }, nope: 1 } } } } }).parameters.properties.l.items, { type: "object", properties: { n: { type: "number" } } });
checkDeep("array items: missing → string", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array" } } } }).parameters.properties.l.items, { type: "string" });
checkDeep("nested objects sanitized recursively", one({ name: "a", inputSchema: { type: "object", properties: { o: { type: "object", properties: { count: { type: "number" }, junk: { type: "string", weird: 1 } } } } } }).parameters.properties.o, {
	type: "object",
	properties: { count: { type: "integer" }, junk: { type: "string" } },
});

// --- skips (already covered in unit_tool_limit; one representative here) ---
const skipped = silent(() => buildToolPayload([{ name: "ok" }, { name: "" }, null, { name: 7 }], false));
check("unusable entries skipped, usable kept", skipped.tools.length, 1);
summary("unit_tool_payload");
```

- [ ] **Step 2: Run**

Run: `npm run compile && node test/unit_tool_payload.mjs`
Expected: all ✓. If any sanitization expectation differs from the real output, **read `src/tool_payload.ts` and fix the expectation** (this test documents current behaviour; it must not change production code).

- [ ] **Step 3: Commit**

```bash
npm test && git add test/unit_tool_payload.mjs && git commit -m "test: pin tool payload schema sanitization and tool_choice passthrough"
```

---

### Task 6: `test/adapter_convert_messages.mjs`

**Files:**
- Create: `test/adapter_convert_messages.mjs`

- [ ] **Step 1: Write the test**

```js
// convertMessages / convertTools / validateRequest — the VS Code → OpenAI
// adapter in src/utils.ts, tested as compiled under the vscode shim.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary } from "./helpers/check.mjs";
import { vscode, OUT, userText, assistantText, textMsg, userImageMsg, assistantToolCallMsg, toolResultMsg } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { convertMessages, convertTools, validateRequest, isToolResultPart } = require(OUT("utils.js"));
const Role = vscode.LanguageModelChatMessageRole;

function captureConsole(method, fn) {
	const lines = [];
	const orig = console[method];
	console[method] = (...a) => lines.push(a.map(String).join(" "));
	try {
		return { result: fn(), lines };
	} finally {
		console[method] = orig;
	}
}

// --- roles and plain text ---
checkDeep("user text → {role:user, content:string}", convertMessages([userText("hi")]), [{ role: "user", content: "hi" }]);
checkDeep("assistant text", convertMessages([assistantText("yo")]), [{ role: "assistant", content: "yo" }]);
checkDeep("unknown role number → system", convertMessages([textMsg(99, "sys")]), [{ role: "system", content: "sys" }]);
checkDeep("adjacent text parts concatenate", convertMessages([{ role: Role.User, content: [new vscode.LanguageModelTextPart("a"), new vscode.LanguageModelTextPart("b")] }]), [{ role: "user", content: "ab" }]);
checkDeep("empty text user message emits nothing", convertMessages([userText("")]), []);
checkDeep("empty assistant emits nothing", convertMessages([assistantText("")]), []);
checkDeep("empty message list → []", convertMessages([]), []);

// --- assistant tool calls ---
const tc = convertMessages([assistantToolCallMsg("thinking aloud", [{ callId: "call_1", name: "get_weather", input: { city: "Tokyo" } }])]);
checkDeep("assistant tool call shape", tc, [
	{ role: "assistant", content: "thinking aloud", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
]);
check("tool-call turn without text → content undefined (key absent in JSON)", JSON.stringify(convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "t", input: {} }])])[0]).includes('"content"'), false);
check("missing callId is generated", typeof convertMessages([assistantToolCallMsg("", [{ callId: "", name: "t", input: {} }])])[0].tool_calls[0].id, "string");
check("generated callId is non-empty", convertMessages([assistantToolCallMsg("", [{ callId: "", name: "t", input: {} }])])[0].tool_calls[0].id.length > 0, true);
check("input undefined → '{}'", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "t", input: undefined }])])[0].tool_calls[0].function.arguments, "{}");
checkMatch("host name is aliased to the wire name", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "weather.get", input: {} }])])[0].tool_calls[0].function.name, /^weather_get_[0-9a-f]{8}$/);
check("spec-legal names pass through", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "read_file", input: {} }])])[0].tool_calls[0].function.name, "read_file");

// --- tool results ---
checkDeep(
	"tool result → role tool with text",
	convertMessages([toolResultMsg([{ callId: "call_1", content: [new vscode.LanguageModelTextPart("Sunny")] }])]),
	[{ role: "tool", tool_call_id: "call_1", content: "Sunny" }],
);
checkDeep("plain-string content parts are accepted", convertMessages([toolResultMsg([{ callId: "c", content: ["a", "b"] }])]), [{ role: "tool", tool_call_id: "c", content: "ab" }]);
checkDeep("empty tool result → content ''", convertMessages([toolResultMsg([{ callId: "c", content: [] }])]), [{ role: "tool", tool_call_id: "c", content: "" }]);
{
	// Issue #11: VS Code 1.118+ appends a cache_control sentinel data part to tool results.
	const sentinel = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
	const r = captureConsole("warn", () => convertMessages([toolResultMsg([{ callId: "c", content: [new vscode.LanguageModelTextPart("ok"), sentinel] }])]));
	checkDeep("cache_control sentinel dropped silently", r.result, [{ role: "tool", tool_call_id: "c", content: "ok" }]);
	check("…without a warning", r.lines.length, 0);
	const unknown = captureConsole("warn", () => convertMessages([toolResultMsg([{ callId: "c", content: [new vscode.LanguageModelDataPart(new Uint8Array(1), "application/x-mystery")] }])]));
	checkDeep("unknown data part dropped", unknown.result, [{ role: "tool", tool_call_id: "c", content: "" }]);
	checkMatch("…with one warning naming the mime", unknown.lines.join("|"), /dropped unknown tool-result part.*application\/x-mystery/);
}
checkDeep(
	"one user message with two results → two tool messages in order",
	convertMessages([toolResultMsg([{ callId: "a", content: ["1"] }, { callId: "b", content: ["2"] }])]),
	[{ role: "tool", tool_call_id: "a", content: "1" }, { role: "tool", tool_call_id: "b", content: "2" }],
);

// --- images ---
const png = new Uint8Array([137, 80, 78, 71]);
{
	const off = captureConsole("warn", () => convertMessages([userImageMsg("look", png)]));
	checkDeep("vision off: image dropped, text stays a string", off.result, [{ role: "user", content: "look" }]);
	checkMatch("vision off: warns 'no image input'", off.lines.join("|"), /dropped 1 image attachment.*no image input/);
	const on = convertMessages([userImageMsg("look", png)], { imageInput: true });
	checkDeep("vision on: block array with data URL", on, [
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } }] },
	]);
	const bad = captureConsole("warn", () => convertMessages([userImageMsg("look", png, "image/bmp")], { imageInput: true }));
	checkDeep("unsupported MIME: dropped, string content", bad.result, [{ role: "user", content: "look" }]);
	checkMatch("unsupported MIME: warns", bad.lines.join("|"), /unsupported MIME/);
	checkDeep("vision on, text only: still a plain string", convertMessages([userText("plain")], { imageInput: true }), [{ role: "user", content: "plain" }]);
	checkDeep("image-only user message → single image block", convertMessages([{ role: Role.User, content: [new vscode.LanguageModelDataPart(png, "image/png")] }], { imageInput: true })[0].content.length, 1);
	checkDeep("images on assistant turns are ignored", convertMessages([{ role: Role.Assistant, content: [new vscode.LanguageModelTextPart("t"), new vscode.LanguageModelDataPart(png, "image/png")] }], { imageInput: true }), [{ role: "assistant", content: "t" }]);
	checkDeep("structural data part (no class) is treated as an image", convertMessages([{ role: Role.User, content: [{ mimeType: "image/png", data: png }] }], { imageInput: true })[0].content[0].type, "image_url");
}

// --- a realistic agent history in one call ---
const history = convertMessages([
	textMsg(99, "You are an expert AI programming assistant."),
	userText("weather?"),
	assistantToolCallMsg("", [{ callId: "call_1", name: "get_weather", input: { city: "Tokyo" } }]),
	toolResultMsg([{ callId: "call_1", content: ["Sunny"] }]),
	assistantText("It is sunny."),
	userText("thanks"),
]);
checkDeep("history roles in order", history.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user"]);

// --- convertTools ---
check("convertTools: no tools → {}", JSON.stringify(convertTools({})), "{}");
check("convertTools: Auto → 'auto'", convertTools({ tools: [{ name: "a" }], toolMode: vscode.LanguageModelChatToolMode.Auto }).tool_choice, "auto");
checkDeep("convertTools: Required + 1 tool → named", convertTools({ tools: [{ name: "a" }], toolMode: vscode.LanguageModelChatToolMode.Required }).tool_choice, { type: "function", function: { name: "a" } });

// --- validateRequest ---
check("validateRequest: empty list throws", (() => { try { validateRequest([]); return false; } catch (e) { return /no messages/.test(e.message); } })(), true);
check("validateRequest: paired call/result passes", (() => { validateRequest([userText("q"), assistantToolCallMsg("", [{ callId: "x", name: "t", input: {} }]), toolResultMsg([{ callId: "x", content: ["r"] }])]); return true; })(), true);
check("validateRequest: missing result throws", (() => { try { validateRequest([userText("q"), assistantToolCallMsg("", [{ callId: "x", name: "t", input: {} }]), userText("next")]); return false; } catch (e) { return /Tool call part must be followed/.test(e.message); } })(), true);
check("validateRequest: assistant without tool calls needs nothing", (() => { validateRequest([userText("q"), assistantText("a"), userText("b")]); return true; })(), true);

// --- isToolResultPart ---
check("isToolResultPart: real part", isToolResultPart(new vscode.LanguageModelToolResultPart("c", [])), true);
check("isToolResultPart: structural", isToolResultPart({ callId: "c", content: [] }), true);
check("isToolResultPart: text part is not", isToolResultPart(new vscode.LanguageModelTextPart("x")), false);
summary("adapter_convert_messages");
```

- [ ] **Step 2: Run**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_convert_messages.mjs`
Expected: all ✓. Where an expectation differs from the real output, read `src/utils.ts` and correct the **expectation** (document current behaviour).

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_convert_messages.mjs && git commit -m "test: convertMessages/convertTools/validateRequest adapter suite under the vscode shim"
```

---

### Task 7: `test/adapter_request_golden.mjs` — end-to-end wire golden

**Files:**
- Create: `test/adapter_request_golden.mjs`

**Interfaces:**
- Consumes `convertMessages` (`out/utils.js`), `ReasoningCache`, `fingerprintAssistantTurn` (`out/reasoning_cache.js`), `buildRequestBody` (`out/request_body.js`), message builders from `test/helpers/fakes.mjs`.

- [ ] **Step 1: Write the test with PLACEHOLDER goldens**

```js
// End-to-end golden: VS Code history → convertMessages → reasoning attach →
// buildRequestBody → JSON.stringify, compared byte-for-byte. This is the
// upgrade gate for the wire: it sits above unit_request_body (which starts
// from already-converted messages) and pins the adapter + body together.
// If it fails, the change is a deliberate, CHANGELOG-worthy wire change or a
// bug — there is no third option.
import { createRequire } from "node:module";
import { check, summary } from "./helpers/check.mjs";
import { vscode, OUT, userText, assistantText, textMsg, userImageMsg, assistantToolCallMsg, toolResultMsg } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { convertMessages } = require(OUT("utils.js"));
const { ReasoningCache, fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const { buildRequestBody } = require(OUT("request_body.js"));
const { buildToolPayload } = require(OUT("tool_payload.js"));

// Mirrors provider.attachReasoningToHistory (same algorithm, no logging).
function attach(messages, cache) {
	for (const m of messages) {
		if (m.role !== "assistant" || m.reasoning_content) continue;
		const fp = fingerprintAssistantTurn({
			text: typeof m.content === "string" ? m.content : "",
			toolCalls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name })),
		});
		if (!fp) continue;
		m.reasoning_content = cache.get(fp) ?? "";
	}
}

const sentinel = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
const HISTORY = [
	textMsg(99, "You are an expert AI programming assistant."),
	userText("What's the weather in Tokyo?"),
	assistantToolCallMsg("", [{ callId: "call_00_abc", name: "get_weather", input: { city: "Tokyo" } }]),
	toolResultMsg([{ callId: "call_00_abc", content: [new vscode.LanguageModelTextPart("Sunny, 22°C"), sentinel] }]),
	assistantText("It is sunny and 22°C in Tokyo."),
	userText("And tomorrow?"),
];
const TOOLS = [{ name: "get_weather", description: "Get the weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

// Seed the cache exactly as a previous turn would have: tc: for the tool-call turn, tx: for the text turn.
const cache = new ReasoningCache(512);
cache.set(fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "call_00_abc", name: "get_weather" }] }), "I should call get_weather for Tokyo.");
cache.set(fingerprintAssistantTurn({ text: "It is sunny and 22°C in Tokyo.", toolCalls: [] }), "The tool says sunny.");

// === Golden 1: thinking + tools (Pro thinking) ===
{
	const messages = convertMessages(HISTORY, { imageInput: false });
	attach(messages, cache);
	const payload = buildToolPayload(TOOLS, false);
	const body = buildRequestBody({ apiModel: "deepseek-v4-pro", messages, thinking: true, reasoningEffort: "max", maxOutputTokens: 393216, modelOptions: undefined, tools: payload.tools, tool_choice: payload.tool_choice });
	const actual = JSON.stringify(body);
	const EXPECTED = "__CAPTURE_ME__";
	if (EXPECTED === "__CAPTURE_ME__") console.log("GOLDEN-1 ACTUAL:\n" + actual);
	check("golden 1: thinking + tools, byte-identical", actual, EXPECTED);
	check("golden 1 sanity: both reasoning_content values attached", (actual.match(/"reasoning_content":"/g) ?? []).length, 2);
	check("golden 1 sanity: sentinel not in tool content", actual.includes("ephemeral"), false);
}
// === Golden 2: non-thinking, no tools (Flash), reasoning must NOT appear ===
{
	const messages = convertMessages(HISTORY, { imageInput: false });
	// provider strips reasoning_content for non-thinking variants; nothing attached here.
	const body = buildRequestBody({ apiModel: "deepseek-v4-flash", messages, thinking: false, reasoningEffort: "max", maxOutputTokens: 65536, modelOptions: { temperature: 0.2 }, tools: undefined, tool_choice: undefined });
	const actual = JSON.stringify(body);
	const EXPECTED = "__CAPTURE_ME__";
	if (EXPECTED === "__CAPTURE_ME__") console.log("GOLDEN-2 ACTUAL:\n" + actual);
	check("golden 2: non-thinking, byte-identical", actual, EXPECTED);
	check("golden 2 sanity: no reasoning_content", actual.includes("reasoning_content"), false);
	check("golden 2 sanity: temperature honoured", actual.includes('"temperature":0.2'), true);
}
// === Golden 3: vision, image in the last user turn (Flash Vision thinking) ===
{
	const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const messages = convertMessages([...HISTORY.slice(0, 5), userImageMsg("What colour is this?", png)], { imageInput: true });
	attach(messages, cache);
	const body = buildRequestBody({ apiModel: "deepseek-v4-flash-vision-exp", messages, thinking: true, reasoningEffort: "high", maxOutputTokens: 393216, modelOptions: undefined, tools: undefined, tool_choice: undefined });
	const actual = JSON.stringify(body);
	const EXPECTED = "__CAPTURE_ME__";
	if (EXPECTED === "__CAPTURE_ME__") console.log("GOLDEN-3 ACTUAL:\n" + actual);
	check("golden 3: vision, byte-identical", actual, EXPECTED);
	check("golden 3 sanity: exactly one image block", (actual.match(/"type":"image_url"/g) ?? []).length, 1);
	check("golden 3 sanity: earlier text-only user turns stay strings", actual.includes('"content":"What\'s the weather in Tokyo?"'), true);
}
summary("adapter_request_golden");
```

- [ ] **Step 2: Capture the goldens**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_request_golden.mjs`
Expected: three `GOLDEN-n ACTUAL:` dumps, three ✗ (placeholders), the sanity checks ✓.

Review each dump against the documented shape before pasting: key order `model, messages, stream, stream_options, max_tokens, thinking, reasoning_effort|temperature, tools, tool_choice`; tool-call turn `{"role":"assistant","tool_calls":[...],"reasoning_content":"..."}` (no `content` key); tool turn `{"role":"tool","tool_call_id":"call_00_abc","content":"Sunny, 22°C"}`; in golden 2 the assistant turns have no `reasoning_content`; in golden 3 only the last user turn is a block array.

- [ ] **Step 3: Paste the three literals** in place of `"__CAPTURE_ME__"` (as single-quoted string concatenations like `test/unit_request_body.mjs`), remove the `if (EXPECTED === …) console.log` lines, re-run.
Expected: all ✓.

- [ ] **Step 4: Red-green sanity**

Temporarily change `"Tokyo"` to `"Osaka"` in the seeded history, run, confirm golden 1 fails; revert.

- [ ] **Step 5: Commit**

```bash
npm test && git add test/adapter_request_golden.mjs && git commit -m "test: end-to-end golden request (VS Code history -> wire bytes) for thinking/tools, non-thinking, vision"
```

---

### Task 8: `test/adapter_provider_reasoning.mjs`

**Files:**
- Create: `test/adapter_provider_reasoning.mjs`

- [ ] **Step 1: Write the test**

```js
// Reasoning round-trip through the real provider: attachReasoningToHistory
// (hit / miss → "" / non-thinking strip / stats gating), persistReasoningForTurn
// anchors (tc: / tx:, wire names), and cross-instance restore from globalState.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary } from "./helpers/check.mjs";
import { OUT, shim, makeProvider, runTurn, model, userText, assistantText, assistantToolCallMsg, toolResultMsg, reasoningChunk, contentChunk, toolCallChunk, finishChunk, usageChunk, DONE, sleep } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const { convertMessages } = require(OUT("utils.js"));

async function main() {
	// --- attachReasoningToHistory: hit, miss, stats ---
	{
		const { provider } = makeProvider();
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
		checkMatch("miss is logged with the fingerprint", provider._outputChannelText?.() ?? shim.outputChannels.at(-1).text(), /cache\.MISS.*"mode":"tx"/);
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
		// Persistence: debounced 200ms write to globalState.
		await sleep(300);
		const saved = memento.get("deepseekv4.reasoningCache");
		check("cache persisted to globalState under the frozen key", Array.isArray(saved) && saved.some((e) => e.fingerprint === fp), true);
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
		check("text reasoning cached under tx:", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "Hello there.", toolCalls: [] }), false), "R1");
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
```

- [ ] **Step 2: Run and adjust**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_provider_reasoning.mjs`
Expected: all ✓. Notes for the implementer: `provider._reasoningCache`, `provider.attachReasoningToHistory` are TypeScript-private but plain JS properties — accessing them from tests is intended here. The `_outputChannelText?.()` fallback is just defensive; the output channel created by `fakeOutputChannel()` is `shim.outputChannels.at(-1)` for the most recent provider — if that indexing is confusing, keep a reference: `const { provider, output } = makeProvider(); … output.text()`. Prefer the explicit `output.text()` form.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_provider_reasoning.mjs && git commit -m "test: reasoning round-trip through the provider (attach, persist anchors, cross-instance restore)"
```

---

### Task 9: `test/adapter_provider_stream.mjs`

**Files:**
- Create: `test/adapter_provider_stream.mjs`

- [ ] **Step 1: Write the test**

```js
// Streaming behaviour through provideLanguageModelChatResponse with a stubbed
// SSE response: progress emission (text, ThinkingPart vs 💭 fallback, tool
// calls), usage capture from the empty-choices chunk, finish_reason handling,
// [DONE] flush, cancellation (reader.cancel + finally persist), and the
// mid-stream throw that still persists reasoning.
import { createRequire } from "node:module";
import { check, checkMatch, summary } from "./helpers/check.mjs";
import { vscode, OUT, shim, makeProvider, runTurn, model, userText, cancellation, progressCollector, onFetch, sseResponse, hangingStream, reasoningChunk, contentChunk, toolCallChunk, finishChunk, usageChunk, DONE, tick, sleep } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const USAGE = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } };

async function main() {
	// --- text + reasoning, no ThinkingPart on the host ---
	{
		shim.reset();
		const { provider, output } = makeProvider();
		const t = await runTurn(provider, { chunks: [reasoningChunk("R"), reasoningChunk("R2"), contentChunk("Hel"), contentChunk("lo"), finishChunk("stop"), usageChunk(USAGE), DONE] });
		check("no error", t.error, undefined);
		check("💭 hint once, then text in order", t.progress.texts().join("|"), "💭 Thinking...\n\n|Hel|lo");
		check("reasoning cached (both chunks concatenated)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "Hello", toolCalls: [] }), false), "RR2");
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
			chunks: [toolCallChunk(0, { id: "call_1", name: "get_weather", args: '{"ci' }), toolCallChunk(0, { args: 'ty":"Tokyo"}' }), toolCallChunk(1, { id: "call_2", name: "get_weather", args: "{}" }), finishChunk("tool_calls"), DONE],
		});
		check("no error", t.error, undefined);
		const calls = t.progress.toolCalls();
		check("two tool calls reported", calls.length, 2);
		check("args assembled across deltas", JSON.stringify(calls[0].input), '{"city":"Tokyo"}');
		check("ids preserved", calls.map((c) => c.callId).join(","), "call_1,call_2");
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
		const t = await runTurn(provider, { options: { tools: [{ name: "t" }] }, chunks: [reasoningChunk("R-mid"), contentChunk("Some text"), toolCallChunk(0, { id: "c", name: "t", args: "{invalid" }), finishChunk("stop"), DONE] });
		checkMatch("clean finish + invalid JSON throws", t.error?.message, /Invalid JSON for tool call/);
		check("reasoning persisted by the finally path (tx: anchor on emitted text)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "Some text", toolCalls: [] }), false), "R-mid");
		provider.dispose();
	}
	// --- cancellation: reader.cancel bridged, loop exits, finally persists ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const { stream, state } = hangingStream([reasoningChunk("R-cancel"), contentChunk("Partial answer")]);
		const c = cancellation();
		const turn = runTurn(provider, { response: sseResponse(stream), cancellation: c });
		await sleep(50); // let the two chunks flow
		c.cancel();
		const t = await turn;
		check("cancelled turn resolves without throwing", t.error, undefined);
		check("reader.cancel reached the underlying stream", state.cancelled, true);
		check("partial text was emitted before cancel", t.progress.texts().includes("Partial answer"), true);
		check("reasoning persisted for the partial turn (issue #19 path)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: "Partial answer", toolCalls: [] }), false), "R-cancel");
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
```

- [ ] **Step 2: Run and adjust**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_provider_stream.mjs`
Expected: all ✓. If the `toolCallChunk(0, { args: … })` continuation shape doesn't match what `ToolCallAssembler` expects (it reads `tc.index`, `tc.id`, `tc.function.name`, `tc.function.arguments`), fix the **fixture helper**, not the expectation. If the 💭 hint text differs, read `THINKING_FALLBACK_HINT` in `src/provider.ts`.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_provider_stream.mjs && git commit -m "test: provider streaming suite (progress, ThinkingPart fallback, tool calls, finish reasons, cancellation, finally-persist)"
```

---

### Task 10: `test/adapter_provider_request.mjs`

**Files:**
- Create: `test/adapter_provider_request.mjs`

- [ ] **Step 1: Write the test**

```js
// Request assembly and post-usage behaviour of provideLanguageModelChatResponse:
// headers/body, pre-flight guards (token overflow, 32 MiB image, 48 MiB body),
// API error → notification mapping, and the usage pipeline (estimator EMA,
// usage DataPart gating, cache-breakdown warning, context nudge hysteresis).
import { check, checkMatch, summary } from "./helpers/check.mjs";
import { vscode, shim, makeProvider, runTurn, model, userText, textMsg, assistantText, userImageMsg, jsonResponse, contentChunk, finishChunk, usageChunk, DONE, tick } from "./helpers/fakes.mjs";

const Role = vscode.LanguageModelChatMessageRole;
const ok = (usage) => [contentChunk("ok"), finishChunk("stop"), usageChunk(usage), DONE];

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
		const { provider } = makeProvider({ secrets: (await import("./helpers/fakes.mjs")).fakeSecrets({}) });
		const t = await runTurn(provider, {});
		checkMatch("no key → throws", t.error?.message, /API key not found/);
		provider.dispose();
	}
	// --- token overflow pre-check ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const huge = "x".repeat(2_000_000); // 2M chars / 3.0 chars-per-token ≈ 667K > 655,360
		const t = await runTurn(provider, { messages: [userText(huge)] });
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
		const t = await runTurn(provider, { model: model("deepseek-v4-flash-vision-exp"), messages: [userImageMsg("look", big)] });
		checkMatch("oversized image throws", t.error?.message, /32 MiB per-image limit/);
		check("no request was sent", t.captured.url, undefined);
		checkMatch("toast is actionable", shim.calls.showErrorMessage.at(-1)?.message, /Attach a smaller image, or start a new chat/);
		provider.dispose();
	}
	// --- 48 MiB body pre-check (three 16 MiB images → ~64 MiB of base64) ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const img = new Uint8Array(16 * 1024 * 1024);
		const t = await runTurn(provider, { model: model("deepseek-v4-flash-vision-exp"), messages: [userImageMsg("a", img), userImageMsg("b", img), userImageMsg("c", img)] });
		checkMatch("oversized body throws", t.error?.message, /48 MiB limit/);
		checkMatch("toast says fewer/smaller images", shim.calls.showErrorMessage.at(-1)?.message, /Attach fewer or smaller images/);
		provider.dispose();
	}
	// --- API error mapping (non-retryable statuses) ---
	const cases = [
		{ status: 400, body: { error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } }, kind: "error", re: /missing reasoning chain/, items: "Start New Chat,Show Log", answer: "Start New Chat", cmd: "workbench.action.chat.newChat" },
		{ status: 400, body: { error: { message: "This model's maximum context length is 65536 tokens. Please reduce the length of the messages." } }, kind: "error", re: /context window exceeded/, items: "Start New Chat,Show Log" },
		{ status: 401, body: { error: { message: "bad key" } }, kind: "error", re: /rejected \(401\)/, items: "Update API Key", answer: "Update API Key", cmd: "deepseekv4.manage" },
		{ status: 402, body: { error: { message: "no money" } }, kind: "error", re: /insufficient balance \(402\)/, items: "Open DeepSeek Billing", answer: "Open DeepSeek Billing", external: "https://platform.deepseek.com/usage" },
		{ status: 422, body: { error: { message: "schema" } }, kind: "error", re: /rejected the request schema \(422\)/, items: "Reload Window", answer: "Reload Window", cmd: "workbench.action.reloadWindow" },
	];
	for (const c of cases) {
		shim.reset();
		if (c.answer) shim.answers.showErrorMessage = c.answer;
		const { provider } = makeProvider();
		const t = await runTurn(provider, { response: jsonResponse(c.status, c.body) });
		await tick();
		checkMatch(`${c.status}: throws formatted API error`, t.error?.message, new RegExp(`DeepSeek API error: ${c.status}`));
		const last = shim.calls.showErrorMessage.at(-1);
		checkMatch(`${c.status}: toast text`, last?.message, c.re);
		check(`${c.status}: buttons`, last?.items.join(","), c.items);
		if (c.cmd) check(`${c.status}: button runs ${c.cmd}`, shim.calls.executeCommand.some((x) => x.id === c.cmd), true);
		if (c.external) check(`${c.status}: opens billing`, shim.calls.openExternal.includes(c.external), true);
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
```

- [ ] **Step 2: Run and adjust**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_provider_request.mjs`
Expected: all ✓. The 48 MiB case allocates ~150 MB; if it is slow (>5 s) reduce to two 24 MiB images (still < 32 MiB each, > 48 MiB after base64). For the breakdown case the second turn must be a **real** turn (plain first text → `background` → reportable) — it is.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_provider_request.mjs && git commit -m "test: provider request suite (headers/body, pre-flight guards, API error mapping, usage pipeline)"
```

---

### Task 11: `test/adapter_provider_info.mjs`

**Files:**
- Create: `test/adapter_provider_info.mjs`

- [ ] **Step 1: Write the test**

```js
// Picker entries, token counting, and the secret-change reaction.
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { vscode, shim, makeProvider, fakeSecrets, cancellation, userText, sleep } from "./helpers/fakes.mjs";

const IDS = ["deepseek-v4-pro::thinking", "deepseek-v4-pro", "deepseek-v4-flash::thinking", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp::thinking", "deepseek-v4-flash-vision-exp"];

async function main() {
	// --- with a key ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation().token);
		checkDeep("six entries in catalog order", infos.map((i) => i.id), IDS);
		check("family frozen", infos.every((i) => i.family === "deepseek-v4"), true);
		check("version frozen", infos.every((i) => i.version === "1.0.0"), true);
		check("toolCalling on all", infos.every((i) => i.capabilities.toolCalling === true), true);
		checkDeep("imageInput only on vision", infos.filter((i) => i.capabilities.imageInput).map((i) => i.id), ["deepseek-v4-flash-vision-exp::thinking", "deepseek-v4-flash-vision-exp"]);
		check("no warning icon with a key", infos.every((i) => i.statusIcon === undefined && i.detail === undefined), true);
		check("tooltip is the variant copy", infos[0].tooltip, "DeepSeek V4 Pro — strongest, extended thinking");
		check("budgets propagate", infos[0].maxInputTokens === 655360 && infos[0].maxOutputTokens === 393216, true);
		check("isUserSelectable", infos.every((i) => i.isUserSelectable === true), true);
		provider.dispose();
	}
	// --- without a key ---
	{
		shim.reset();
		const { provider } = makeProvider({ secrets: fakeSecrets({}) });
		const infos = await provider.prepareLanguageModelChatInformation({ silent: true }, cancellation().token);
		check("still six entries (discoverable)", infos.length, 6);
		check("warning icon", infos.every((i) => i.statusIcon instanceof vscode.ThemeIcon && i.statusIcon.id === "warning"), true);
		check("detail points at the Manage command", infos.every((i) => /Manage DeepSeek V4 Provider/.test(i.detail)), true);
		check("no input box during silent discovery", shim.calls.showInputBox.length, 0);
		provider.dispose();
	}
	// --- provideTokenCount ---
	{
		shim.reset();
		const { provider } = makeProvider();
		check("string: ceil(len / 3.0)", await provider.provideTokenCount({}, "abcdefg", cancellation().token), 3);
		const msg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("abcdefghi"), new vscode.LanguageModelDataPart(new Uint8Array(10), "image/png")] };
		check("message: text estimate + 384 per image", await provider.provideTokenCount({}, msg, cancellation().token), 3 + 384);
		provider.dispose();
	}
	// --- secret change → picker refresh + session reset + silent balance refresh ---
	{
		shim.reset();
		const { provider, secrets } = makeProvider();
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => fired++);
		provider._sessionRequestCount = 5;
		secrets._emit("deepseekv4.apiKey");
		await sleep(10);
		check("onDidChange fired", fired, 1);
		check("session counter reset", provider._sessionRequestCount, 0);
		check("context usage cleared", provider.contextUsage.getSnapshot(), undefined);
		secrets._emit("some.other.key");
		check("unrelated secrets are ignored", fired, 1);
		provider.dispose();
	}
	summary("adapter_provider_info");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 2: Run**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_provider_info.mjs`
Expected: all ✓.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_provider_info.mjs && git commit -m "test: picker info, token counting and secret-change reaction"
```

---

### Task 12: `test/adapter_extension_activate.mjs`

**Files:**
- Create: `test/adapter_extension_activate.mjs`

- [ ] **Step 1: Write the test**

```js
// activate(): command registration, provider registration, the Manage flow,
// first-run welcome, and the Copilot compact bridge.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary } from "./helpers/check.mjs";
import { shim, OUT, fakeSecrets, fakeMemento, resetFetch, onFetch, jsonResponse, tick, sleep } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { activate, deactivate } = require(OUT("extension.js"));

function makeContext({ secrets, globalState } = {}) {
	return {
		subscriptions: [],
		secrets: secrets ?? fakeSecrets({}),
		globalState: globalState ?? fakeMemento(),
		extension: { packageJSON: { version: "9.9.9-test" } },
	};
}
function disposeAll(ctx) {
	for (const d of ctx.subscriptions) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}
}
const EXPECTED_COMMANDS = [
	"deepseekv4.showLog",
	"deepseekv4.refreshBalance",
	"deepseekv4.clearSession",
	"deepseekv4.clearReasoningCache",
	"deepseekv4.showContextWindow",
	"deepseekv4.compactCopilotChat",
	"deepseekv4.showCacheStats",
	"deepseekv4.manage",
];

async function main() {
	// --- registration ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		checkDeep("registers the command set (incl. unexposed showContextWindow)", [...shim.calls.registerCommand].sort(), [...EXPECTED_COMMANDS].sort());
		check("registers the LM provider under the frozen vendor", shim.calls.registerProvider[0]?.vendor, "deepseek-v4");
		check("status bar item created and bound to Show Log", shim.statusBarItems[0]?.command, "deepseekv4.showLog");
		checkMatch("boot line logs versions", shim.outputChannels[0]?.text(), /\[boot\] ext=9\.9\.9-test vscode=1\.106\.0-shim/);
		check("subscriptions collected for deactivate", ctx.subscriptions.length > 5, true);
		check("deactivate is a no-op function", typeof deactivate, "function");
		disposeAll(ctx);
	}
	// --- welcome: no key → walkthrough opened once, flag written ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		await sleep(10);
		const open = shim.calls.executeCommand.find((c) => c.id === "workbench.action.openWalkthrough");
		check("walkthrough opened", !!open, true);
		check("…with publisher.name#id", open?.args[0], "Laurent00TT.deepseek-v4-vscode-chat#deepseekv4GettingStarted");
		check("welcomeShown persisted", ctx.globalState.get("deepseekv4.welcomeShown"), true);
		disposeAll(ctx);
	}
	// --- welcome: existing key → no walkthrough, flag still written ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ secrets: fakeSecrets({ "deepseekv4.apiKey": "sk-existing" }) });
		activate(ctx);
		await sleep(10);
		check("no walkthrough for returning users", shim.calls.executeCommand.some((c) => c.id === "workbench.action.openWalkthrough"), false);
		check("welcomeShown persisted anyway", ctx.globalState.get("deepseekv4.welcomeShown"), true);
		disposeAll(ctx);
	}
	// --- welcome: already shown → nothing ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ globalState: fakeMemento({ "deepseekv4.welcomeShown": true }) });
		activate(ctx);
		await sleep(10);
		check("already-shown: no walkthrough", shim.calls.executeCommand.some((c) => c.id === "workbench.action.openWalkthrough"), false);
		disposeAll(ctx);
	}
	// --- Manage command ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ secrets: fakeSecrets({ "deepseekv4.apiKey": "sk-old" }) });
		activate(ctx);
		const manage = shim.registeredCommands.get("deepseekv4.manage");
		// cancel
		shim.answers.showInputBox = undefined;
		await manage();
		check("cancelled input box leaves the key", await ctx.secrets.get("deepseekv4.apiKey"), "sk-old");
		check("input box pre-fills the existing key", shim.calls.showInputBox.at(-1)?.value, "sk-old");
		// clear
		shim.answers.showInputBox = "   ";
		await manage();
		check("blank input clears the key", await ctx.secrets.get("deepseekv4.apiKey"), undefined);
		checkMatch("…and says so", shim.calls.showInformationMessage.at(-1)?.message, /API key cleared/);
		// validation failure → Cancel
		onFetch((u) => u.endsWith("/v1/models"), () => jsonResponse(401, {}));
		shim.answers.showInputBox = "sk-new";
		shim.answers.showWarningMessage = "Cancel";
		await manage();
		checkMatch("validation failure surfaced", shim.calls.showWarningMessage.at(-1)?.message, /validation failed: Invalid API key \(401/);
		check("…Cancel does not store", await ctx.secrets.get("deepseekv4.apiKey"), undefined);
		// validation failure → Save anyway
		shim.answers.showWarningMessage = "Save anyway";
		await manage();
		check("Save anyway stores the key", await ctx.secrets.get("deepseekv4.apiKey"), "sk-new");
		checkMatch("…with the 'without validation' note", shim.calls.showInformationMessage.at(-1)?.message, /saved \(without successful validation\)/);
		// validation success
		onFetch((u) => u.endsWith("/v1/models"), () => jsonResponse(200, { data: [] }));
		shim.answers.showInputBox = "sk-good";
		await manage();
		check("validated key stored", await ctx.secrets.get("deepseekv4.apiKey"), "sk-good");
		checkMatch("…validated message", shim.calls.showInformationMessage.at(-1)?.message, /validated and saved/);
		check("validation ran inside withProgress", shim.calls.withProgress.length >= 1, true);
		disposeAll(ctx);
	}
	// --- compact bridge ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		const compact = shim.registeredCommands.get("deepseekv4.compactCopilotChat");
		shim.answers.getCommands = [];
		await compact();
		checkMatch("without Copilot Chat: explains the requirement", shim.calls.showInformationMessage.at(-1)?.message, /Copilot Chat is required/);
		shim.answers.getCommands = ["github.copilot.chat.compact"];
		await compact();
		check("with Copilot Chat: forwards to github.copilot.chat.compact", shim.calls.executeCommand.some((c) => c.id === "github.copilot.chat.compact"), true);
		disposeAll(ctx);
	}
	// --- cache stats command renders a table and a summary toast ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		await shim.registeredCommands.get("deepseekv4.showCacheStats")();
		checkMatch("stats table logged", shim.outputChannels[0]?.text(), /Reasoning Cache Stats[\s\S]*\| Entries \| 0 \/ 512 \|/);
		checkMatch("summary toast", shim.calls.showInformationMessage.at(-1)?.message, /Reasoning cache: 0 entries/);
		disposeAll(ctx);
	}
	summary("adapter_extension_activate");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 2: Run**

Run: `npm run compile && node --require ./test/vscode_shim/register.cjs test/adapter_extension_activate.mjs`
Expected: all ✓. Note: each `activate` constructs a provider whose constructor issues a silent balance fetch — `resetFetch()` supplies the default balance route so nothing hits the network.

- [ ] **Step 3: Commit**

```bash
npm test && git add test/adapter_extension_activate.mjs && git commit -m "test: extension activation suite (commands, provider registration, Manage flow, welcome, compact bridge)"
```

---

### Task 13: Documentation + final verification

**Files:**
- Modify: `CONTRIBUTING.md` ("House pattern" + "Verification matrix")
- Modify: `ARCHITECTURE.md` (new "Test strategy" subsection before "## Integration tests")
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Delete: `test/adapter_smoke.mjs` is **kept** (it documents the mechanism) — no deletion.

- [ ] **Step 1: CONTRIBUTING — replace the "House pattern" paragraph**

Replace the sentence `… and is unit-tested from the compiled output (\`test/unit_*.mjs\` import \`../out/*.js\` in plain Node — no vscode mock).` with:

```markdown
and is unit-tested from the compiled output (`test/unit_*.mjs` import
`../out/*.js` in plain Node — no vscode anywhere in the import chain).
The vscode-coupled adapters (`utils.ts`, `provider.ts`, `extension.ts`) are
tested as compiled too, under a **minimal `vscode` replacement**
(`test/vscode_shim/`, injected by `node --require`; `test/adapter_*.mjs`).
The shim may grow new APIs the adapters use, never behaviour VS Code does
not have — it records calls and returns preset answers, nothing else.
```

And extend the verification matrix block:

```bash
npm run compile        # tsc
npm run lint           # eslint
npm test               # unit suites (pure modules) + adapter suites (vscode shim)
npm run test:coverage  # same, with a c8 coverage report
npx prettier --check . # formatting is CI-enforced; prettier is pinned
npx @vscode/vsce package -o /tmp/x.vsix   # packaging sanity
```

Add one line under the integration-test paragraph: "`test/adapter_request_golden.mjs` is the end-to-end wire gate — if it fails after an upgrade, compare the dumped body against the documented shape before touching the literal."

- [ ] **Step 2: ARCHITECTURE — add before `## Integration tests`**

```markdown
## Test strategy

Three layers, all run by `npm test` from the compiled `out/`:

- **Pure-module unit suites** (`test/unit_*.mjs`) import `../out/*.js` in
  plain Node; nothing in their import chain touches `vscode`. They pin the
  protocol-layer invariants: the serialized request body (golden), SSE
  rules, fingerprint and wire-alias algorithms, tool payload sanitization,
  the model catalog, and the package.json contract (`unit_manifest.mjs`).
- **Adapter suites** (`test/adapter_*.mjs`, run by `node test/run_tests.mjs adapter`
  with `node --require test/vscode_shim/register.cjs`) exercise the real
  `out/utils.js`, `out/provider.js` and `out/extension.js` against a
  minimal hand-written `vscode` (`test/vscode_shim/index.cjs`): part
  classes, enums, `MarkdownString`, `EventEmitter`, and recordable
  `window` / `commands` / `workspace` / `env` / `lm` stubs with preset
  answers. Fakes for `SecretStorage`, `Memento`, `OutputChannel`,
  `StatusBarItem`, SSE streams and `fetch` live in `test/helpers/fakes.mjs`.
  `adapter_request_golden.mjs` is the end-to-end wire gate (VS Code history
  → request bytes); the provider suites cover streaming, cancellation and
  the `finally`-path persist, error → notification mapping, the usage
  pipeline, the picker, and activation.
- **Integration scripts** (below) hit the live API and are the final word on
  protocol questions.

`npm run test:coverage` wraps the same run in c8 (devDependency only).
```

- [ ] **Step 3: CHANGELOG — add under `[Unreleased]` → `### Added`**

```markdown
- **Regression test suite for upgrades.** Three new pure suites (`unit_model_catalog` pins the six picker ids / API names / budgets; `unit_manifest` pins the package.json contract — vendor, command ids and titles, settings, walkthrough id — and the SecretStorage / globalState keys baked into the compiled output; `unit_tool_payload` pins schema sanitization and `tool_choice`) and seven **adapter suites** that test the real compiled `utils.js` / `provider.js` / `extension.js` under a minimal `vscode` replacement (`test/vscode_shim/`, injected with `node --require`; no production code changed): `convertMessages` / `convertTools` / `validateRequest` including the #11 `cache_control` sentinel, an **end-to-end golden request** (VS Code history → wire bytes, thinking + tools / non-thinking / vision), the reasoning round-trip (attach, `tc:` / `tx:` anchors on wire names, cross-instance restore from globalState), streaming (ThinkingPart vs 💭 fallback, tool-call assembly, finish reasons, cancellation with the `finally`-path persist, malformed chunks), request assembly and guards (headers, token overflow, 32 MiB / 48 MiB, 400 / 401 / 402 / 422 notification mapping, estimator EMA, `usage` DataPart gating, cache-breakdown warning, 95 % / 80 % context nudge), picker entries and token counting, and `activate` (command set, provider registration, Manage flow, welcome, compact bridge). `npm run test:coverage` reports c8 coverage (devDependency only); CI runs it.
```

- [ ] **Step 4: Full matrix**

Run each, bare (no pipes), and read exit codes:

```bash
npm run compile
npm run lint
npm test
npm run test:coverage
npx prettier --check .
npx @vscode/vsce package -o /tmp/x.vsix
npx @vscode/vsce ls
```

Expected: all exit 0; the VSIX file list contains **no** `test/`, `.c8rc.json`, or `coverage/` entries (if `coverage/` is emitted to disk, add `coverage/` to `.gitignore` and `.vscodeignore`).

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md ARCHITECTURE.md CHANGELOG.md .gitignore .vscodeignore
git commit -m "docs: test strategy (pure suites + vscode-shim adapter suites + coverage) in CONTRIBUTING/ARCHITECTURE/CHANGELOG"
```

---

## Self-review

- Spec coverage: A (shim, register, helpers, scripts, c8, CI) → Tasks 1–2; P0 files → Tasks 3, 4, 6, 7; P1 files → Tasks 5, 8–12; C docs → Task 13; D out-of-scope untouched. ✓
- Placeholders: the only intentional ones are the three `__CAPTURE_ME__` goldens in Task 7, with an explicit capture step. ✓
- Type consistency: helper names used across tasks (`check`, `checkDeep`, `checkMatch`, `summary`, `makeProvider`, `runTurn`, `model`, `userText`, `assistantText`, `textMsg`, `userImageMsg`, `assistantToolCallMsg`, `toolResultMsg`, `reasoningChunk`, `contentChunk`, `toolCallChunk`, `finishChunk`, `usageChunk`, `DONE`, `sseResponse`, `jsonResponse`, `hangingStream`, `cancellation`, `onFetch`, `resetFetch`, `fakeSecrets`, `fakeMemento`, `tick`, `sleep`, `shim`, `vscode`, `OUT`) all defined in Task 1 Step 5. ✓
