import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";

import type { DeepSeekModelVariant, OpenAIChatMessage } from "./types";

import { convertTools, convertMessages, tryParseJSONObject, validateRequest } from "./utils";
import { ReasoningCache, fingerprintAssistantTurn, type CachedTurn, type ReasoningCacheStats } from "./reasoning_cache";
import { shouldWarnCacheBreakdown } from "./cache_breakdown";
import { ContextUsageService } from "./context_usage_service";

const REASONING_CACHE_STATE_KEY = "deepseekv4.reasoningCache";

const BASE_URL = "https://api.deepseek.com/v1";

/**
 * Model variants exposed to the VS Code model picker.
 *
 * DeepSeek V4 supports 1M context and up to 384K output. Think Max requires
 * at least 384K of context allocated to the reasoning chain to avoid silent
 * truncation, so the thinking-max entry is configured generously.
 *
 * Order matters — VS Code shows the first entry as default. The strongest
 * variant (pro + thinking-max) is intentionally listed first.
 */
// DS V4's context window is 1M (input + output total). V4's max output is
// 384K (which subsumes the reasoning chain — `max_tokens` covers both the
// hidden reasoning_content and the visible content). Thinking variants
// budget the full 384K so max-effort reasoning chains can't be truncated.
// Non-thinking variants only emit visible content, so 64K is plenty.
//
// Input budgets are sized as `1M - output budget`:
//   - thinking variants:  1M - 384K = 640K → rounded down to 640K
//   - non-thinking:        1M - 64K = 960K → rounded down to 960K
// (We keep slightly conservative rounding to avoid edge-case overflows
// when the server's tokenizer disagrees with our estimator.)
//
// `reasoning_effort` is read from the `deepseekv4.reasoningEffort` user
// setting at request time, not stored on the variant.
//
// Listed strongest→cheapest; VS Code uses the first entry as the default.
const MODEL_VARIANTS: DeepSeekModelVariant[] = [
	{
		id: "deepseek-v4-pro::thinking",
		displayName: "DeepSeek V4 Pro (thinking)",
		tooltip: "DeepSeek V4 Pro — strongest, extended thinking",
		apiModel: "deepseek-v4-pro",
		thinking: true,
		maxInputTokens: 655360,   // 640K (= 1M - 384K output)
		maxOutputTokens: 393216,  // 384K (covers reasoning chain + visible content)
	},
	{
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		tooltip: "DeepSeek V4 Pro — strong, no extended thinking, lower latency",
		apiModel: "deepseek-v4-pro",
		thinking: false,
		maxInputTokens: 983040,   // 960K (= 1M - 64K output)
		maxOutputTokens: 65536,   // 64K
	},
	{
		id: "deepseek-v4-flash::thinking",
		displayName: "DeepSeek V4 Flash (thinking)",
		tooltip: "DeepSeek V4 Flash — cheapest with extended thinking",
		apiModel: "deepseek-v4-flash",
		thinking: true,
		maxInputTokens: 655360,   // 640K (= 1M - 384K output)
		maxOutputTokens: 393216,  // 384K
	},
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		tooltip: "DeepSeek V4 Flash — cheapest, no extended thinking",
		apiModel: "deepseek-v4-flash",
		thinking: false,
		maxInputTokens: 983040,   // 960K (= 1M - 64K output)
		maxOutputTokens: 65536,   // 64K
	},
];

function findVariant(id: string): DeepSeekModelVariant | undefined {
	return MODEL_VARIANTS.find((v) => v.id === id);
}

/**
 * Fetch with retry on transient failures (network errors, 5xx, 429).
 * 4xx (except 429) are non-retryable client errors and bubble immediately.
 * Aborts (user cancel) bypass retry.
 *
 * Retries are bounded to attempts=3 with exponential backoff (1s, 2s) so
 * worst case adds ~3s before giving up — well within Copilot's request
 * timeout window.
 *
 * A per-attempt timeout (default 5 min) prevents hangs. DeepSeek's thinking
 * mode with max effort can take 2–5 minutes for complex reasoning chains,
 * and the API itself gives up after 10 minutes of queuing, so 5 min is a
 * reasonable middle ground that avoids both premature cancellation and
 * indefinite hangs.
 */
async function fetchWithRetry(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	logger: (msg: string, data?: unknown) => void,
	attempts = 3,
	timeoutMs = 300_000, // 5 min per attempt
): Promise<Response> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		if (signal.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		try {
			// Combine user cancel signal with per-attempt timeout.
			// AbortSignal.any() is available in Node 20+ / VS Code 1.104+.
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

			const res = await fetch(url, { ...init, signal: combinedSignal });
			// Non-retryable: 2xx success, 4xx client errors (except 429 rate limit)
			if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
				return res;
			}
			// Retryable: 5xx server errors, 429 rate limit
			lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
			logger("retry", { attempt: i + 1, status: res.status, willRetry: i < attempts - 1 });
			// Drain body so the connection can be reused
			try { await res.text(); } catch { /* ignore */ }
		} catch (e) {
			if ((e as { name?: string })?.name === "AbortError") {
				// Distinguish user cancel from timeout
				if (signal.aborted) {
					throw e; // User cancelled — propagate immediately
				}
				// Timeout — log and retry (timeout can be transient)
				lastErr = new Error(`Request timeout after ${timeoutMs}ms`);
				logger("retry", {
					attempt: i + 1,
					error: `timeout ${timeoutMs}ms`,
					willRetry: i < attempts - 1,
				});
			} else {
				lastErr = e;
				logger("retry", {
					attempt: i + 1,
					error: e instanceof Error ? e.message : String(e),
					willRetry: i < attempts - 1,
				});
			}
		}
		if (i < attempts - 1) {
			const delayMs = 1000 * Math.pow(2, i);
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Session cost is computed by diffing /user/balance before vs after each
 * request, NOT by multiplying token counts by a hardcoded price table.
 *
 * Rationale: DeepSeek's prices change (cache-hit input was cut to 1/10
 * on 2026-04-26, the Pro 75%-off discount has been extended multiple
 * times — most recently to 2026-05-31), so any local PRICING table is
 * guaranteed to drift and silently overcharge or undercharge users.
 * Letting the /user/balance endpoint be the source of truth means
 * session-spend always equals the real bill.
 *
 * Trade-offs accepted:
 *   (a) session-spend is debounced ~1.5s behind the latest refresh, so
 *       the figure shown lags one chat completion;
 *   (b) shared accounts see other users' spend mixed in;
 *   (c) mid-session top-ups manifest as a one-shot session-spend reset
 *       (we detect the balance jumping up and re-anchor startBalance).
 *
 * Per-turn token counts (prompt_tokens, prompt_cache_hit_tokens, etc.)
 * are still pulled from API `usage` and surfaced in the status bar and
 * tooltip — that part doesn't depend on pricing.
 */

interface DSUsage {
	prompt_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	completion_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
}

/** Snapshot of `/user/balance`. Refreshed only on user demand. */
interface BalanceInfo {
	currency: string;
	totalBalance: number;
	grantedBalance: number;
	toppedUpBalance: number;
	fetchedAt: number;
}

const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** 24-hour HH:MM:SS, padded — independent of OS locale. */
function formatTime24(timestamp: number): string {
	const d = new Date(timestamp);
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	const ss = d.getSeconds().toString().padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "CNY": return "¥";
		case "USD": return "$";
		case "EUR": return "€";
		case "GBP": return "£";
		case "JPY": return "¥";
		default: return currency + " ";
	}
}

/**
 * JSON.stringify that swallows circular refs and BigInt instead of crashing.
 */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
	} catch {
		return String(value);
	}
}

/**
 * Surface a context-window-overflow error with actionable buttons. Used
 * by both the local pre-check (estimated tokens exceed maxInputTokens)
 * and the API-side 400 detection that recognises "context length
 * exceeded" style errors. Centralising the UX keeps both paths consistent
 * — users see the same dialog whether the overflow was caught locally or
 * by the server.
 */
async function showContextOverflowGuidance(detail: string): Promise<void> {
	const choice = await vscode.window.showErrorMessage(
		`DeepSeek context window exceeded. ${detail} Start a new chat or shorten the conversation.`,
		"Start New Chat",
		"Show Log",
	);
	if (choice === "Start New Chat") {
		void vscode.commands.executeCommand("workbench.action.chat.newChat");
	} else if (choice === "Show Log") {
		void vscode.commands.executeCommand("deepseekv4.showLog");
	}
}

function formatTokenK(tokens: number): string {
	return `${(tokens / 1024).toFixed(1)}K`;
}

/**
 * 5-cell unicode mini progress bar + percentage, e.g. `▰▰▱▱▱ 32.4%`.
 *
 * Glyph set: `▰` (U+25B0 BLACK PARALLELOGRAM) + `▱` (U+25B1 WHITE
 * PARALLELOGRAM). Visually distinct from `|` (the surrounding status-
 * bar separator) and from `░` shade patterns — earlier `█▏░` set had
 * the partial-block `▏` collide visually with the `|` separator and
 * the `░` shading looked like texture instead of an empty cell.
 *
 * Bucket-based, not sub-cell partial. A non-zero percentage always
 * fills at least one cell, so 2.6% gives a visible "started" signal
 * (`▰▱▱▱▱`) instead of disappearing into all-empty. Trade-off: 1%
 * looks identical to 24% — acceptable because the numeric percentage
 * to the right is the ground truth; the bar is just a glance cue.
 */
function formatStatusBarProgress(pct: number): string {
	const width = 5;
	const clamped = Math.max(0, Math.min(1, pct));
	let cells: number;
	if (clamped === 0) {
		cells = 0;
	} else if (clamped >= 1) {
		cells = width;
	} else {
		// Any non-zero pct fills ≥1 cell, scaling up to width-1 just
		// below 100% so the full-fill bucket is reserved for exactly 1.0.
		cells = Math.min(width - 1, Math.floor(clamped * (width - 1)) + 1);
	}
	const bar = "▰".repeat(cells) + "▱".repeat(width - cells);
	return `${bar} ${(clamped * 100).toFixed(1)}%`;
}

/**
 * Surface 4xx API errors with actionable buttons. Fire-and-forget — callers
 * don't await this; the underlying error still throws normally.
 *
 * Notifications are deliberately throttled to "kinds we can do something
 * about". 5xx/429 are retried automatically by fetchWithRetry, so a
 * surfaced 5xx here means retries also failed — unactionable, just log.
 */
async function notifyApiError(status: number, summary: string): Promise<void> {
	if (status === 401) {
		const choice = await vscode.window.showErrorMessage(
			`DeepSeek API key was rejected (401). ${summary}`,
			"Update API Key",
		);
		if (choice === "Update API Key") {
			void vscode.commands.executeCommand("deepseekv4.manage");
		}
		return;
	}
	if (status === 402) {
		const choice = await vscode.window.showErrorMessage(
			`DeepSeek account has insufficient balance (402). ${summary}`,
			"Open DeepSeek Billing",
		);
		if (choice === "Open DeepSeek Billing") {
			void vscode.env.openExternal(vscode.Uri.parse("https://platform.deepseek.com/usage"));
		}
		return;
	}
	if (status === 422) {
		const choice = await vscode.window.showErrorMessage(
			`DeepSeek rejected the request schema (422). This usually means the extension and host are out of sync. ${summary}`,
			"Reload Window",
		);
		if (choice === "Reload Window") {
			void vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
		return;
	}
	if (status === 429) {
		void vscode.window.showWarningMessage(
			`DeepSeek rate limited (429). The extension already retried — try again in a moment.`,
		);
		return;
	}
	// 4xx that aren't user-actionable (400 schema bugs, etc.) just stay in the log.
	if (status === 400) {
		// 400 can be caused by missing reasoning_content in thinking mode.
		// When the error body mentions reasoning or thinking, give the user
		// a clear action instead of a cryptic error.
		const lower = summary.toLowerCase();
		if (lower.includes("reasoning") || lower.includes("thinking")) {
			const choice = await vscode.window.showErrorMessage(
				`DeepSeek rejected the request (400) — likely due to missing reasoning chain in a multi-turn conversation. ${summary}`,
				"Start New Chat",
				"Show Log",
			);
			if (choice === "Start New Chat") {
				void vscode.commands.executeCommand("workbench.action.chat.newChat");
			} else if (choice === "Show Log") {
				void vscode.commands.executeCommand("deepseekv4.showLog");
			}
			return;
		}
		// 400 can also be a context-window overflow that slipped past our
		// local pre-check (estimator is ~30% off in either direction).
		//
		// Verified DeepSeek canonical error body (direct call to
		// api.deepseek.com, type=invalid_request_error):
		//   "This model's maximum context length is 65536 tokens. However,
		//    you requested 73402 tokens (73402 in the messages, 0 in the
		//    completion). Please reduce the length of the messages or
		//    completion."
		// The first two clauses match the canonical body; "reduce the length"
		// is the most distinctive fingerprint (rarely appears in unrelated
		// errors). Remaining patterns are defensive against router/proxy
		// rewrites (OpenRouter etc. normalise to OpenAI's code) and alternate
		// wordings seen in DS-compatible third-party APIs.
		if (
			lower.includes("context length") ||
			lower.includes("maximum context") ||
			lower.includes("reduce the length") ||
			lower.includes("context_length_exceeded") ||
			lower.includes("too many tokens") ||
			(lower.includes("tokens") && (lower.includes("exceed") || lower.includes("too long")))
		) {
			await showContextOverflowGuidance(summary);
			return;
		}
	}
}

/**
 * Render a DeepSeek API error response into a single readable line, preferring
 * the structured `error.message` field when present so the user sees the
 * actual cause instead of a wall of JSON.
 */
function formatApiError(status: number, statusText: string, body: string): string {
	const head = `DeepSeek API error: ${status} ${statusText}`;
	if (!body) {
		return head;
	}
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
		const errMsg = parsed?.error?.message;
		if (typeof errMsg === "string" && errMsg) {
			const code = parsed.error?.code ? ` [${parsed.error.code}]` : "";
			return `${head}${code}: ${errMsg}`;
		}
	} catch {
		/* fall through to raw body */
	}
	return `${head}\n${body}`;
}

/**
 * State scoped to a single `provideLanguageModelChatResponse` invocation.
 *
 * Previously these were instance fields on the provider, which assumed VS
 * Code calls `provideLanguageModelChatResponse` strictly serially. With
 * multi-window / multi-chat-panel scenarios that assumption is fragile; an
 * outer scheduler now creates a fresh StreamContext per call so concurrent
 * turns can't trample each other's tool-call buffers or reasoning capture.
 */
class StreamContext {
	/** Buffer for assembling streamed tool calls by index. */
	readonly toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
	/** Indices for which a tool call has been fully emitted. */
	readonly completedToolCallIndices = new Set<number>();
	/** Full reasoning_content for this turn — round-tripped on the next turn. */
	reasoning = "";
	/** Visible text emitted this turn — fallback fingerprint when no tool_calls. */
	emittedText = "";
	/** Tool calls emitted this turn — primary fingerprint anchor when present. */
	readonly emittedToolCalls: Array<{ id: string; name: string }> = [];
	/** Whether we've already shown the "💭 Thinking..." text fallback this turn. */
	hasShownThinkingHint = false;
}

/**
 * VS Code Chat provider backed by DeepSeek V4 (OpenAI-format API).
 */
export class DeepSeekV4ChatModelProvider implements LanguageModelChatProvider {
	private readonly _reasoningCache = new ReasoningCache(512);

	/** Adaptive chars-per-token ratio, calibrated from real `usage` data via
	 * EMA. The starting value of 3.0 is a middle-ground between pure-ASCII
	 * (~4) and CJK-heavy (~1.5) content; observed values typically converge
	 * to 2.5–3.5 after a couple of turns. Only used by the local
	 * maxInputTokens guard, so over-/under-estimating by ~30% is harmless.
	 *
	 * Cross-request EMA accumulation is intentional — this IS shared state
	 * across calls. The per-request input-char count, on the other hand, is
	 * kept as a local in `provideLanguageModelChatResponse` so concurrent
	 * calls can't overwrite each other's values mid-fetch. */
	private _charsPerToken = 3.0;

	/** Account balance at the moment this session "started", used as the
	 * anchor for `sessionSpend = startBalance - currentBalance`. Set the
	 * first time we observe a balance, and re-anchored when:
	 *   (a) the user calls `clearSession`, or
	 *   (b) we observe the balance jumping UP (top-up detected).
	 * Currency comes from `_balance.currency` directly — no manual tracking. */
	private _sessionStartBalance?: number;
	private _sessionRequestCount = 0;

	/** Token-usage snapshot from the most recent API response. Used to render
	 * context-window utilisation in the status bar and tooltip. Updated after
	 * every successful chat completion — undefined before the first response.
	 * `_lastModelMaxInputTokens` is duplicated here because refreshStatusBar
	 * runs without a model handle and needs both values to compute the %. */
	private _lastPromptTokens?: number;
	private _lastMessageTokens?: number;
	private _lastToolTokens?: number;
	private _lastCacheHitTokens?: number;
	private _lastModelMaxInputTokens?: number;

	/** Prompt-cache hit-rate tracking for the breakdown detector. A sudden
	 * collapse here, combined with reasoning_cache misses on the same turn,
	 * indicates the local cache failed and the server-side prompt-cache
	 * prefix has broken — costing the user ~12× in mis-prefix tokens. */
	private _lastCacheHitRate?: number;
	private _peakCacheHitRate?: number;
	private _lastCacheWarnTime?: number;

	/** Shared context-usage state. Written by `provideLanguageModelChatResponse`
	 * (estimate before request, API values after), read by the status-bar
	 * tooltip's "Open Details" link and by the `DeepSeek Context Details`
	 * QuickPick command. Public so extension.ts can subscribe / read. */
	public readonly contextUsage = new ContextUsageService();

	/** Cached balance snapshot. Refreshed manually (refresh link) or
	 * automatically (debounced after each chat completion, silent mode). */
	private _balance: BalanceInfo | undefined;
	/** Debounce timer for the auto-refresh-after-chat path. Cleared on dispose. */
	private _balanceRefreshTimer: NodeJS.Timeout | undefined;

	/** Coalesce rapid cache writes to globalState — set→set→set within ~200ms persists once. */
	private _persistTimer: NodeJS.Timeout | undefined;

	/** Subscriptions owned by this provider (secret listener, etc.). Disposed
	 * by `dispose()` to avoid late callbacks against torn-down resources. */
	private readonly _subscriptions: vscode.Disposable[] = [];

	/** Fired when the model list or per-model state (e.g. has-API-key) changes
	 * so the host re-pulls `provideLanguageModelChatInformation`. */
	private readonly _onDidChangeChatInfoEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChangeChatInfoEmitter.event;

	/**
	 * Create a provider using the given secret storage for the API key.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly globalState: vscode.Memento,
		private readonly statusBar: vscode.StatusBarItem,
	) {
		this.outputChannel.appendLine("[ctor] provider instance created");

		// Restore persisted reasoning cache so multi-turn agent loops survive
		// VS Code restarts. Without this, a new session always 400s on the
		// second turn until the user starts a fresh conversation.
		const saved = this.globalState.get<CachedTurn[]>(REASONING_CACHE_STATE_KEY);
		if (Array.isArray(saved) && saved.length > 0) {
			this._reasoningCache.restore(saved);
			this.outputChannel.appendLine(`[ctor] restored ${this._reasoningCache.size()} reasoning cache entries`);
		}

		// Persist on every cache.set, debounced so a flurry of writes during
		// one streaming turn collapses to a single disk hit.
		this._reasoningCache.setOnChange(() => {
			if (this._persistTimer) {
				clearTimeout(this._persistTimer);
			}
			this._persistTimer = setTimeout(() => {
				void this.globalState.update(REASONING_CACHE_STATE_KEY, this._reasoningCache.serialize());
				this._persistTimer = undefined;
			}, 200);
		});

		// Multi-window sync: when another VS Code window writes/clears the
		// API key in SecretStorage, this window's picker still thinks the
		// key state is whatever it was at construction time. Listen for
		// secret changes and fire onDidChange so the host re-asks us.
		this._subscriptions.push(
			this.secrets.onDidChange((e) => {
				if (e.key === "deepseekv4.apiKey") {
					this.outputChannel.appendLine("[secrets] apiKey changed elsewhere — refreshing model picker");
					this._onDidChangeChatInfoEmitter.fire();
					// API key change implies the account may have changed.
					// Old _sessionStartBalance is meaningless against the new
					// account's balance — reset everything so the next balance
					// refresh anchors fresh.
					this._balance = undefined;
					this._sessionStartBalance = undefined;
					this._sessionRequestCount = 0;
					this.contextUsage.clear("secret-change");
					this.refreshStatusBar();
					// Kick off a silent refresh to (a) re-establish the session
					// baseline against the new account, and (b) populate the
					// status bar without waiting for the next chat completion.
					// Without this, `scheduleBalanceRefresh` short-circuits on
					// `!this._balance` and the user has to manually click the
					// "refresh" link before sessionSpend starts working again.
					void this.refreshBalance(true);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("deepseekv4.showContextUsage")) {
					this.refreshStatusBar();
				}
			}),
		);

		this.refreshStatusBar();

		// Fire-and-forget initial fetch so the status bar shows balance after
		// VS Code reload without requiring a manual hover-refresh first.
		// Silent: errors swallowed — no-op if API key isn't configured yet.
		void this.refreshBalance(true);
	}

	private refreshStatusBar(): void {
		const balanceStr = this._balance
			? ` ${currencySymbol(this._balance.currency)}${this._balance.totalBalance.toFixed(2)}`
			: "";
		const pct = this.showContextUsage() ? this.contextUsagePct() : undefined;
		const pctStr = pct !== undefined ? ` | ${formatStatusBarProgress(pct)}` : "";

		// Single item: `V₄ ¥7.76 | 10.1%`. VS Code statusBarItem.color is
		// item-wide — there's no way to tint only the percentage without
		// also tinting V₄ and the balance. Cohabiting in one item is the
		// priority (avoids other extensions like "No Environment" splitting
		// us in two), so we forgo local tinting entirely. The tooltip still
		// surfaces 70%/90% warnings textually.
		this.statusBar.text = `V₄${balanceStr}${pctStr}`;
		this.statusBar.color = new vscode.ThemeColor("descriptionForeground");
		this.statusBar.tooltip = this.buildTooltip();
		this.statusBar.backgroundColor = undefined;
		this.statusBar.show();
	}

	private showContextUsage(): boolean {
		return vscode.workspace
			.getConfiguration("deepseekv4")
			.get<boolean>("showContextUsage", true);
	}

	/**
	 * Percentage of the FULL context window used (input + reserved output),
	 * matching the denominator the native VS Code chat-context widget uses
	 * and the value shown in the tooltip + webview. Prior versions divided
	 * by maxInputTokens alone, which produced a status-bar percentage that
	 * disagreed with the tooltip (e.g. 4.1% on status bar vs 2.6% in
	 * tooltip for the same snapshot — confusing).
	 *
	 * Sourced from the ContextUsageService snapshot so all three surfaces
	 * (status bar, tooltip, webview) compute it the same way.
	 */
	private contextUsagePct(): number | undefined {
		const snap = this.contextUsage.getSnapshot();
		if (!snap) {
			return undefined;
		}
		const total = snap.maxInputTokens + snap.maxOutputTokens;
		if (total <= 0) {
			return undefined;
		}
		return snap.usedTokens / total;
	}

	/** Compute session spend from balance diff. Returns undefined until we
	 * have both a startBalance anchor AND a current balance. Caller decides
	 * what to do with a zero spend (we don't hide it here). Currency comes
	 * from the live balance, not stored separately, so any account-currency
	 * switch is automatically reflected. */
	private sessionSpend(): { amount: number; currency: string } | undefined {
		if (!this._balance || this._sessionStartBalance === undefined) {
			return undefined;
		}
		// Math.max guards the race where a top-up has hit the account but
		// our debounced refresh hasn't seen it yet — would otherwise show a
		// briefly negative spend. The next refresh re-anchors startBalance.
		const diff = Math.max(0, this._sessionStartBalance - this._balance.totalBalance);
		return { amount: diff, currency: this._balance.currency };
	}

	/**
	 * Acknowledge a user-initiated refresh with a transient status-bar
	 * message containing the fresh balance.
	 *
	 * VS Code's MarkdownString tooltip is declarative: when the hover popup
	 * is already on-screen, swapping `statusBar.tooltip` does NOT re-render
	 * the visible popup. The popup either stays stale until the user
	 * mouses out and back in, or — depending on whether the click closes
	 * the popup — disappears entirely. We tried disposing+recreating the
	 * StatusBarItem to force the popup closed and re-triggered, but
	 * VS Code 1.106+ does not auto-re-fire hover on the new item after
	 * dispose/recreate; the user got an item flicker followed by the popup
	 * vanishing, which is strictly worse than the swap-only behaviour.
	 *
	 * So we accept that the popup may close after the click and surface
	 * the new balance via `setStatusBarMessage` instead — a transient
	 * floating ack next to the status bar item that the user sees without
	 * needing to re-hover. The next hover will show the refreshed
	 * tooltip.
	 *
	 * TODO(vscode-api): if a future VS Code release adds a way to
	 * imperatively re-render an open hover popup, switch to that.
	 */
	private flashRefreshAck(): void {
		if (!this._balance) {
			return;
		}
		const sym = currencySymbol(this._balance.currency);
		void vscode.window.setStatusBarMessage(
			`$(check) DeepSeek balance: ${sym}${this._balance.totalBalance.toFixed(2)}`,
			4000,
		);
	}

	private buildTooltip(): vscode.MarkdownString {
		const md = new vscode.MarkdownString("", true);
		md.isTrusted = true;
		md.supportThemeIcons = true;

		md.appendMarkdown("### DeepSeek V4\n\n");

		// Balance row: refresh action sits inline next to the **Balance** label.
		md.appendMarkdown(
			this._balance
				? "**Balance** &nbsp; [$(refresh) refresh](command:deepseekv4.refreshBalance)\n\n"
				: "**Balance** &nbsp; [$(refresh) click to fetch](command:deepseekv4.refreshBalance)\n\n",
		);
		if (this._balance) {
			const sym = currencySymbol(this._balance.currency);
			const time = formatTime24(this._balance.fetchedAt);
			md.appendMarkdown(`${sym}${this._balance.totalBalance.toFixed(2)} &nbsp;·&nbsp; ${time}\n\n`);
			if (this._balance.grantedBalance > 0) {
				md.appendMarkdown(
					`_${sym}${this._balance.grantedBalance.toFixed(2)} granted + ${sym}${this._balance.toppedUpBalance.toFixed(2)} topped up_\n\n`,
				);
			}
			// Session spend = startBalance - currentBalance. This is the
			// real billed amount (lagged ~1.5s by debounced balance refresh)
			// rather than a hardcoded-price estimate.
			const spend = this.sessionSpend();
			if (spend !== undefined && spend.amount > 0) {
				const reqWord = this._sessionRequestCount === 1 ? "request" : "requests";
				md.appendMarkdown(
					`_Session: ${sym}${spend.amount.toFixed(4)} &nbsp;·&nbsp; ${this._sessionRequestCount} ${reqWord}_\n\n`,
				);
			}
		}

		md.appendMarkdown("---\n\n");

		// Context-usage block, styled after VS Code 1.120's native
		// ChatContextUsageDetails panel (the "Context Window" popup with
		// the progress bar + striped reserved region + Compact Conversation
		// button). MarkdownString can't render real CSS progress bars, so
		// the bar is a unicode-block approximation inside a code block to
		// force monospace alignment.
		const pct = this.contextUsagePct();
		const snap = this.contextUsage.getSnapshot();
		if (this.showContextUsage() && pct !== undefined && this._lastPromptTokens && this._lastModelMaxInputTokens && snap) {
			const maxInput = this._lastModelMaxInputTokens;
			const maxOutput = snap.maxOutputTokens;
			const totalWindow = maxInput + maxOutput;
			// `pct` is already over (input + output) thanks to contextUsagePct()'s
			// updated denominator — reuse it instead of recomputing, so a future
			// change to the percentage definition only needs to happen in one place.
			const totalPctStr = (pct * 100).toFixed(1);
			// Bar: used (█) + remaining input (░) + reserved output (▒).
			// 40 chars wide — close to the actual rendered width in
			// MarkdownString code blocks without overflowing the popup.
			const barWidth = 40;
			const usedCells = Math.min(barWidth, Math.round((this._lastPromptTokens / totalWindow) * barWidth));
			const reservedCells = Math.min(barWidth - usedCells, Math.round((maxOutput / totalWindow) * barWidth));
			const remainingCells = barWidth - usedCells - reservedCells;
			const bar = "█".repeat(usedCells) + "░".repeat(remainingCells) + "▒".repeat(reservedCells);
			md.appendMarkdown("**Context Window**\n\n");
			md.appendMarkdown(`${formatTokenK(this._lastPromptTokens)} / ${formatTokenK(totalWindow)} tokens &nbsp;&nbsp;&nbsp; **${totalPctStr}%**\n\n`);
			md.appendCodeblock(bar, "");
			md.appendMarkdown(`\`▒\` &nbsp; Reserved for response (${formatTokenK(maxOutput)} reserved)\n\n`);

			// Breakdown (estimate-only — server reports the combined
			// prompt_tokens but not how those split between system /
			// tools / messages, so we use the local char-ratio split).
			if (this._lastMessageTokens !== undefined && this._lastToolTokens !== undefined) {
				md.appendMarkdown("**Breakdown** &nbsp; _(local estimate)_\n\n");
				const msgPct = ((this._lastMessageTokens / totalWindow) * 100).toFixed(1);
				const toolPct = ((this._lastToolTokens / totalWindow) * 100).toFixed(1);
				md.appendMarkdown(`Messages &nbsp;&nbsp; ~${msgPct}%  \n`);
				md.appendMarkdown(`Tools &nbsp;&nbsp; ~${toolPct}%\n\n`);
			}

			md.appendMarkdown("**[$(combine) Compact Conversation](command:deepseekv4.compactCopilotChat)**\n\n");
		}

		// Cache hit-rate row. Surfaces the cheap-vs-expensive token ratio so
		// users can spot when their prompt cache stops working without having
		// to dig through the log.
		if (this._lastCacheHitRate !== undefined) {
			const hitPctStr = (this._lastCacheHitRate * 100).toFixed(1);
			const hitK = ((this._lastCacheHitTokens ?? 0) / 1024).toFixed(1);
			md.appendMarkdown(`**Cache hit (last turn)** &nbsp; ${hitPctStr}% (${hitK}K cached)\n\n`);
		}

		md.appendMarkdown("---\n\n");

		// Reasoning effort row: shows the current setting value plus a click-
		// through to the specific setting. Helps discoverability — users who
		// hover the status bar to check cost will also notice this control.
		const currentEffort = vscode.workspace
			.getConfiguration("deepseekv4")
			.get<string>("reasoningEffort", "max");
		md.appendMarkdown(
			`**Reasoning effort** &nbsp; \`${currentEffort}\` &nbsp; [$(gear) configure](command:workbench.action.openSettings?%22deepseekv4.reasoningEffort%22)\n\n`,
		);
		md.appendMarkdown("[$(graph) Context Details](command:deepseekv4.showContextWindow) &nbsp;·&nbsp; [View full log](command:deepseekv4.showLog)");

		return md;
	}

	/**
	 * Reset the visible session counters to zero. Does NOT touch the reasoning
	 * cache, the API key, or any model conversation state — purely a UI reset
	 * for the cost/request tally shown in the status bar.
	 */
	public clearSession(): void {
		// Re-anchor the session-spend baseline. If we have a current balance,
		// use it; otherwise leave undefined so the next balance fetch will
		// initialise it. This means sessionSpend resets to 0 the moment we
		// next observe a balance.
		this._sessionStartBalance = this._balance?.totalBalance;
		this._sessionRequestCount = 0;
		// Reset the context-usage display so the next refresh shows a clean
		// state until the first response of the new session lands.
		this._lastPromptTokens = undefined;
		this._lastMessageTokens = undefined;
		this._lastToolTokens = undefined;
		this._lastCacheHitTokens = undefined;
		this._lastModelMaxInputTokens = undefined;
		this._lastCacheHitRate = undefined;
		this._peakCacheHitRate = undefined;
		// Intentionally NOT resetting _lastCacheWarnTime — if a breakdown
		// fired 30s ago, a manual clearSession shouldn't unmute the throttle.
		this.contextUsage.clear("session-clear");
		this.refreshStatusBar();
		this.log("session.clear", { startBalance: this._sessionStartBalance });
	}

	/**
	 * Return a snapshot of the reasoning cache health. Used by the
	 * "Show Cache Stats" command for diagnostics when users hit 400s.
	 */
	public getCacheStats(): ReasoningCacheStats {
		return this._reasoningCache.stats();
	}

	/**
	 * Purge the local reasoning cache. Bound to `deepseekv4.clearReasoningCache`.
	 * Use cases: user is about to share a bug log and wants to scrub thought
	 * traces from prior sessions; user just switched projects and the cached
	 * reasoning could leak business context cross-project; user simply hit a
	 * persistent 400 chain and wants a clean slate.
	 */
	public async clearReasoningCache(): Promise<void> {
		const before = this._reasoningCache.size();
		this._reasoningCache.clear();
		// Cancel any pending debounced write — we're doing a force-flush
		// below that supersedes it. Without this, the cache.clear() above
		// would schedule a new 200ms persist via onChange that races our
		// own awaited update().
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		// Force-flush the empty state BEFORE notifying the user. The
		// command's whole purpose is privacy (scrub before sharing a
		// log, etc.); if the user reloads between our notification and
		// the debounced write, the old reasoning could be restored from
		// globalState. Awaiting turns the success message into a real
		// success rather than a wishful one.
		await this.globalState.update(REASONING_CACHE_STATE_KEY, []);
		this.log("reasoning_cache.clear", { entriesRemoved: before, persisted: true });
		vscode.window.showInformationMessage(
			`Cleared ${before} reasoning cache entr${before === 1 ? "y" : "ies"}.`,
		);
	}

	/**
	 * Notify the user that the prompt cache is no longer benefiting them.
	 * Triggered by `shouldWarnCacheBreakdown`. The two CTAs (start a new chat
	 * vs inspect the cache stats) cover the two reasonable responses: cut
	 * losses, or diagnose. Either is better than silently burning money.
	 */
	private async warnCacheBreakdown(
		currHitRate: number,
		peakHitRate: number,
		reasoningMisses: number,
	): Promise<void> {
		const curr = (currHitRate * 100).toFixed(0);
		const peak = (peakHitRate * 100).toFixed(0);
		const missWord = reasoningMisses === 1 ? "miss" : "misses";
		const choice = await vscode.window.showWarningMessage(
			`DeepSeek prompt cache hit rate dropped to ${curr}% (peak ${peak}%). ${reasoningMisses} reasoning cache ${missWord} this turn — the local reasoning cache was likely evicted or lost across a restart. Continuing risks higher cost (cache-miss tokens cost ~12× more).`,
			"Start New Chat",
			"Show Cache Stats",
		);
		if (choice === "Start New Chat") {
			void vscode.commands.executeCommand("workbench.action.chat.newChat");
		} else if (choice === "Show Cache Stats") {
			void vscode.commands.executeCommand("deepseekv4.showCacheStats");
		}
	}

	private log(message: string, data?: unknown): void {
		const ts = new Date().toISOString().slice(11, 23);
		const dataStr = data !== undefined ? " " + safeStringify(data) : "";
		this.outputChannel.appendLine(`[${ts}] ${message}${dataStr}`);
	}

	/**
	 * Fetch the latest account balance from DS and update the cached snapshot.
	 * Bound to the `deepseekv4.refreshBalance` command and the tooltip's
	 * "refresh" link.
	 *
	 * @param silent When true, suppress all user-facing notifications:
	 *   - no "Balance refreshed" status-bar message on success
	 *   - no error popup on failure
	 *   - no API-key-missing warning
	 *   The cached `_balance` is still updated and logged. This mode is used
	 *   by the auto-refresh-after-chat path so background updates don't
	 *   interrupt the user's flow.
	 */
	public async refreshBalance(silent = false): Promise<void> {
		const apiKey = await this.ensureApiKey(true);
		if (!apiKey) {
			if (!silent) {
				vscode.window.showWarningMessage(
					"DeepSeek API key not configured. Run \"Manage DeepSeek V4 Provider\" first.",
				);
			}
			return;
		}
		try {
			const res = await fetch(BALANCE_URL, {
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": this.userAgent },
			});
			if (!res.ok) {
				const text = await res.text();
				const summary = formatApiError(res.status, res.statusText, text);
				this.log(silent ? "balance.auto_refresh.error" : "balance.error", {
					status: res.status,
					body: text.slice(0, 300),
				});
				if (!silent) {
					void notifyApiError(res.status, summary);
				}
				return;
			}
			const data = (await res.json()) as {
				is_available?: boolean;
				balance_infos?: Array<{
					currency: string;
					total_balance: string;
					granted_balance: string;
					topped_up_balance: string;
				}>;
			};
			const info = data.balance_infos?.[0];
			if (!info) {
				if (!silent) {
					vscode.window.showWarningMessage("DeepSeek returned an empty balance response.");
				}
				return;
			}
			const newTotal = parseFloat(info.total_balance);
			this._balance = {
				currency: info.currency,
				totalBalance: newTotal,
				grantedBalance: parseFloat(info.granted_balance),
				toppedUpBalance: parseFloat(info.topped_up_balance),
				fetchedAt: Date.now(),
			};
			// Anchor / re-anchor sessionStartBalance.
			//   - undefined: first balance observation, just lock it.
			//   - newTotal > startBalance: top-up detected → re-anchor so
			//     sessionSpend doesn't go negative.
			//   - newTotal <= startBalance: normal spending, leave the
			//     anchor alone so sessionSpend keeps growing.
			let topUpDetected = false;
			if (this._sessionStartBalance === undefined) {
				this._sessionStartBalance = newTotal;
			} else if (newTotal > this._sessionStartBalance) {
				topUpDetected = true;
				this._sessionStartBalance = newTotal;
				this._sessionRequestCount = 0;
			}
			this.log(silent ? "balance.auto_refresh" : "balance.refresh", {
				currency: this._balance.currency,
				total: newTotal,
				granted: this._balance.grantedBalance,
				topped_up: this._balance.toppedUpBalance,
				session_start: this._sessionStartBalance,
				top_up_detected: topUpDetected || undefined,
			});
			// Both silent and manual paths just swap the tooltip reference;
			// the next hover renders fresh data. The manual path additionally
			// flashes a transient ack message with the new balance so the
			// user sees the result immediately even if the click closed the
			// hover popup. See `flashRefreshAck()` for why we don't try to
			// hard-refresh the popup itself.
			this.refreshStatusBar();
			if (!silent) {
				this.flashRefreshAck();
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.log(silent ? "balance.auto_refresh.error" : "balance.error", { error: msg });
			if (!silent) {
				vscode.window.showErrorMessage(`Failed to refresh DeepSeek balance: ${msg}`);
			}
		}
	}

	/**
	 * Schedule a silent background balance refresh ~1.5s after the most
	 * recent call. Multiple back-to-back chat completions only trigger a
	 * single fetch (debounce). No-op if the user has never fetched balance
	 * yet — we don't auto-pull on their behalf.
	 */
	private scheduleBalanceRefresh(): void {
		if (!this._balance) {
			return;
		}
		if (this._balanceRefreshTimer) {
			clearTimeout(this._balanceRefreshTimer);
		}
		this._balanceRefreshTimer = setTimeout(() => {
			this._balanceRefreshTimer = undefined;
			void this.refreshBalance(true);
		}, 1500);
	}

	/**
	 * Dispose all pending timers. Called via subscriptions on extension
	 * deactivate / reload — without this, a pending setTimeout could fire
	 * after the extension host begins teardown and trigger errors against
	 * disposed resources (output channel, secret storage, etc.).
	 */
	public dispose(): void {
		if (this._balanceRefreshTimer) {
			clearTimeout(this._balanceRefreshTimer);
			this._balanceRefreshTimer = undefined;
		}
		if (this._persistTimer) {
			// A pending debounced write was about to flush the latest
			// cache state. Cancelling the timer without flushing means
			// the state on disk could be up to 200ms stale — including,
			// crucially, an empty state produced by `clearReasoningCache`
			// that hasn't been written yet. Fire-and-forget the write
			// here; VS Code typically keeps the extension host alive
			// briefly during dispose, so the write usually completes.
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
			void this.globalState.update(REASONING_CACHE_STATE_KEY, this._reasoningCache.serialize());
		}
		for (const sub of this._subscriptions) {
			try { sub.dispose(); } catch { /* ignore */ }
		}
		this._subscriptions.length = 0;
		this._onDidChangeChatInfoEmitter.dispose();
		this.contextUsage.dispose();
		// statusBar is owned by extension.ts (added to context.subscriptions);
		// VS Code disposes it on extension deactivate. We don't touch it here.
	}

	/**
	 * Token estimator using the adaptive `_charsPerToken` ratio. Started at
	 * 3.0 (middle ground between ASCII ~4 and CJK ~1.5) and refined via EMA
	 * each time we observe real `usage.prompt_tokens` from the API. Only used
	 * for the local maxInputTokens guard; over/under by ~30% is harmless.
	 */
	private estimateText(text: string): number {
		return Math.ceil(text.length / this._charsPerToken);
	}

	private countMessageChars(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += part.value.length;
				}
			}
		}
		return total;
	}

	private countToolChars(tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined): number {
		if (!tools || tools.length === 0) { return 0; }
		try {
			return JSON.stringify(tools).length;
		} catch {
			return 0;
		}
	}

	/**
	 * Update the adaptive chars/token ratio from observed API usage data.
	 * EMA (alpha=0.3) so a single outlier turn can't yank the estimate too
	 * far. Skipped when the request had no input chars or zero prompt
	 * tokens (would divide by zero or pollute the average with noise).
	 */
	private calibrateCharsPerToken(observedChars: number, promptTokens: number | undefined): void {
		if (!promptTokens || promptTokens <= 0 || observedChars <= 0) {
			return;
		}
		const observedRatio = observedChars / promptTokens;
		// Clamp to a sane range [1.0, 6.0] so a single corrupt usage row
		// can't push the estimator into unusable territory.
		if (observedRatio < 1.0 || observedRatio > 6.0) {
			return;
		}
		this._charsPerToken = this._charsPerToken * 0.7 + observedRatio * 0.3;
	}

	/**
	 * Get the list of available language models contributed by this provider.
	 *
	 * We always return the full variant list (even without an API key) so the
	 * picker has a discoverable entry point — a picker that hides itself
	 * gives users no clue where the "Manage DeepSeek" command lives. Variants
	 * are flagged with a warning state and a tooltip pointing at the
	 * configuration command instead.
	 *
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		// Don't trigger the input-box prompt during silent picker discovery —
		// only consult the existing key, never ask. Users get prompted via
		// the explicit Manage command instead.
		const apiKey = await this.secrets.get("deepseekv4.apiKey");
		const hasKey = !!apiKey;
		void options; // silent flag intentionally unused — see comment above

		const missingKeyTooltip = 'No API key configured. Run "Manage DeepSeek V4 Provider" from the Command Palette.';

		return MODEL_VARIANTS.map((v) => ({
			id: v.id,
			name: v.displayName,
			tooltip: hasKey ? v.tooltip : missingKeyTooltip,
			// @non-public: `detail` is on the public typedef but Copilot Chat
			// renders it directly under the model name in the picker.
			detail: hasKey ? undefined : missingKeyTooltip,
			family: "deepseek-v4",
			version: "1.0.0",
			maxInputTokens: v.maxInputTokens,
			maxOutputTokens: v.maxOutputTokens,
			capabilities: {
				toolCalling: true,
				imageInput: false,
			},
			// @non-public LanguageModelChatInformation fields used by Copilot
			// Chat's model picker. Same shape used by Copilot's built-in
			// OpenAI/Anthropic providers.
			//   - `isUserSelectable`: controls picker visibility
			//   - `statusIcon`: leading icon (we use `warning` when no key)
			// FAILURE MODE: if Copilot Chat renames or removes these fields,
			// the warning icon stops rendering — the picker still works
			// because `id`, `name`, `family`, `version`, `maxInputTokens`,
			// `maxOutputTokens`, `capabilities` are all public. We never
			// REQUIRE these fields, only enhance the picker with them.
			// Re-evaluate when `vscode.LanguageModelChatInformation` adds
			// these to its public typedef.
			isUserSelectable: true,
			statusIcon: hasKey ? undefined : new vscode.ThemeIcon("warning"),
		} as unknown as LanguageModelChatInformation));
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		// Per-call state — replaces the old instance-field-as-scratchpad
		// approach so concurrent provideLanguageModelChatResponse invocations
		// can't corrupt each other's tool-call buffers or reasoning capture.
		const ctx = new StreamContext();

		let requestBody: Record<string, unknown> | undefined;
		// Capture-progress wraps the host progress so that we can both:
		//   (a) catch errors from progress.report (host-side issues), and
		//   (b) accumulate emitted text / tool calls into the per-turn ctx
		//       for the reasoning fingerprint.
		const captureProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					if (part instanceof vscode.LanguageModelTextPart) {
						ctx.emittedText += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						ctx.emittedToolCalls.push({
							id: part.callId,
							name: part.name,
						});
					}
					progress.report(part);
				} catch (e) {
					console.error("[DeepSeek V4] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		try {
			const apiKey = await this.ensureApiKey(true);
			if (!apiKey) {
				throw new Error("DeepSeek API key not found");
			}

			const variant = findVariant(model.id);
			if (!variant) {
				throw new Error(`Unknown DeepSeek model variant: ${model.id}`);
			}

            const openaiMessages = convertMessages(messages);
            this.log("request.history", {
                modelId: model.id,
                count: openaiMessages.length,
                roles: openaiMessages.map((m) => {
                    if (m.role === "assistant" && m.tool_calls?.length) {
                        return `assistant[tc:${m.tool_calls.map((tc) => `${tc.function.name}#${tc.id}`).join(",")}]`;
                    }
                    if (m.role === "tool") {
                        return `tool[id:${m.tool_call_id}]`;
                    }
                    return m.role;
                }),
            });
            // Only attach reasoning_content when the current request is in
            // thinking mode. Sending reasoning_content to a non-thinking
            // endpoint wastes prefix tokens (server still has to tokenise it
            // before discarding) and the empty-string fallback breaks
            // prompt-cache prefix anyway. When user switches from a thinking
            // variant to a non-thinking one mid-conversation, prior assistant
            // turns may also already carry reasoning_content — strip it.
            let reasoningStats = { hits: 0, misses: 0 };
            if (variant.thinking) {
                reasoningStats = this.attachReasoningToHistory(openaiMessages);
            } else {
                for (const m of openaiMessages) {
                    if (m.role === "assistant" && m.reasoning_content !== undefined) {
                        delete m.reasoning_content;
                    }
                }
            }

			validateRequest(messages);

            const toolConfig = convertTools(options);

        if (options.tools && options.tools.length > 128) {
            throw new Error("Cannot have more than 128 tools per request.");
        }

            const messageChars = this.countMessageChars(messages);
            const toolChars = this.countToolChars(toolConfig.tools);
            // Per-request char count lives in a LOCAL — if it were on the
            // instance, two concurrent provideLanguageModelChatResponse calls
            // could overwrite each other between the fetch and the usage
            // callback, polluting the EMA estimator with the wrong request's
            // size.
            const requestInputChars = messageChars + toolChars;
            const inputTokenCount = Math.ceil(messageChars / this._charsPerToken);
            const toolTokenCount = Math.ceil(toolChars / this._charsPerToken);
            const tokenLimit = Math.max(1, model.maxInputTokens);
            // Publish a pre-request estimate so the QuickPick (and any
            // other reader) has something to show even if the request
            // fails before the SSE final usage chunk arrives.
            this.contextUsage.updateEstimate({
                modelId: variant.id,
                modelDisplayName: variant.displayName,
                thinking: variant.thinking,
                maxInputTokens: variant.maxInputTokens,
                maxOutputTokens: variant.maxOutputTokens,
                estimatedPromptTokens: inputTokenCount,
                estimatedToolTokens: toolTokenCount,
            });
            if (inputTokenCount + toolTokenCount > tokenLimit) {
                const estimated = inputTokenCount + toolTokenCount;
                console.error("[DeepSeek V4] Message exceeds token limit", { total: estimated, tokenLimit });
                // Fire-and-forget the friendly dialog so the throw below still
                // returns control to the host immediately. The user sees both
                // (an error in the chat panel plus the actionable popup) — they
                // can dismiss whichever they want.
                void showContextOverflowGuidance(
                    `Estimated ${(estimated / 1024).toFixed(0)}K input tokens exceeds the ${(tokenLimit / 1024).toFixed(0)}K limit for ${model.name}.`,
                );
                throw new Error("Message exceeds token limit.");
            }

            // When the host supplies a max_tokens hint we honour it (capped to
            // the variant's ceiling). When it doesn't, we hand the model the
            // full configured budget — important for thinking-max so the
            // reasoning chain isn't silently truncated.
            const requestedMaxTokens = options.modelOptions?.max_tokens;
            const maxTokens = typeof requestedMaxTokens === "number" && requestedMaxTokens > 0
                ? Math.min(requestedMaxTokens, model.maxOutputTokens)
                : model.maxOutputTokens;

            requestBody = {
                model: variant.apiModel,
                messages: openaiMessages,
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: maxTokens,
                thinking: { type: variant.thinking ? "enabled" : "disabled" },
            };

			if (variant.thinking) {
				const raw = vscode.workspace
					.getConfiguration("deepseekv4")
					.get<string>("reasoningEffort", "max");
				// Defensive: the package.json schema constrains the settings UI to
				// "high" | "max", but a hand-edited settings.json could contain
				// anything. Coerce unknown values to "max" rather than passing
				// arbitrary strings to the API.
				const effort: "high" | "max" = raw === "high" ? "high" : "max";
				(requestBody as Record<string, unknown>).reasoning_effort = effort;
				this.outputChannel.appendLine(`[req] reasoning_effort=${effort} (variant=${variant.id})`);
				// Per DeepSeek docs: temperature/top_p/penalty params are ignored
				// in thinking mode. We omit them to keep the request body honest.
			} else {
				(requestBody as Record<string, unknown>).temperature = options.modelOptions?.temperature ?? 0.7;
			}

			// Allow-list non-thinking-mode tuning options
			if (options.modelOptions && !variant.thinking) {
				const mo = options.modelOptions as Record<string, unknown>;
				if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
					(requestBody as Record<string, unknown>).stop = mo.stop;
				}
				if (typeof mo.frequency_penalty === "number") {
					(requestBody as Record<string, unknown>).frequency_penalty = mo.frequency_penalty;
				}
				if (typeof mo.presence_penalty === "number") {
					(requestBody as Record<string, unknown>).presence_penalty = mo.presence_penalty;
				}
			}

			if (toolConfig.tools) {
				(requestBody as Record<string, unknown>).tools = toolConfig.tools;
			}
			if (toolConfig.tool_choice) {
				(requestBody as Record<string, unknown>).tool_choice = toolConfig.tool_choice;
			}
			const abort = new AbortController();
			const cancelSub = token.onCancellationRequested(() => abort.abort());
			let response: Response;
			try {
				response = await fetchWithRetry(
					`${BASE_URL}/chat/completions`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json",
							"User-Agent": this.userAgent,
						},
						body: JSON.stringify(requestBody),
						signal: abort.signal,
					},
					abort.signal,
					(msg, data) => this.log(msg, data),
				);
			} finally {
				cancelSub.dispose();
			}

			if (!response.ok) {
				const errorText = await response.text();
				const errorMsg = formatApiError(response.status, response.statusText, errorText);
				this.log("api.error", { status: response.status, body: errorText.slice(0, 400) });
				void notifyApiError(response.status, errorMsg);
				throw new Error(errorMsg);
			}

			if (!response.body) {
				throw new Error("No response body from DeepSeek API");
			}
			const usage = await this.processStreamingResponse(ctx, response.body, captureProgress, token);
			if (usage) {
				// Refine the chars/token estimator now that we know the real
				// prompt_tokens for this request's input chars. We use the
				// local `requestInputChars` captured before fetch — NOT an
				// instance field — to stay correct under concurrent calls.
				this.calibrateCharsPerToken(requestInputChars, usage.prompt_tokens);
				this._sessionRequestCount += 1;
				const promptTotal = usage.prompt_tokens ?? 0;
				const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
				const cacheHitPct = promptTotal > 0 ? (cacheHit / promptTotal) * 100 : 0;

				// Snapshot the usage numbers so the status bar and tooltip can
				// render them. `prompt_tokens` is the API-reported total — it
				// already includes history, so we do NOT accumulate across
				// turns. Each turn's value supersedes the previous one.
				this._lastPromptTokens = promptTotal;
				const estimatedBreakdown = inputTokenCount + toolTokenCount;
				if (promptTotal > 0 && estimatedBreakdown > 0) {
					this._lastToolTokens = Math.round(promptTotal * (toolTokenCount / estimatedBreakdown));
					this._lastMessageTokens = Math.max(0, promptTotal - this._lastToolTokens);
				} else {
					this._lastMessageTokens = promptTotal;
					this._lastToolTokens = 0;
				}
				this._lastCacheHitTokens = cacheHit;
				this._lastModelMaxInputTokens = variant.maxInputTokens;
				// Publish authoritative API values to the shared snapshot.
				// `usage.prompt_cache_miss_tokens` is computed defensively
				// here too in case the server omits it (older API behaviour).
				this.contextUsage.updateFromApi({
					modelId: variant.id,
					modelDisplayName: variant.displayName,
					thinking: variant.thinking,
					maxInputTokens: variant.maxInputTokens,
					maxOutputTokens: variant.maxOutputTokens,
					apiPromptTokens: promptTotal,
					apiCompletionTokens: usage.completion_tokens ?? 0,
					apiCacheHitTokens: cacheHit,
					apiCacheMissTokens: usage.prompt_cache_miss_tokens ?? Math.max(0, promptTotal - cacheHit),
					apiReasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
				});
				const currHitRate = promptTotal > 0 ? cacheHit / promptTotal : 0;
				this._lastCacheHitRate = currHitRate;
				this._peakCacheHitRate = Math.max(this._peakCacheHitRate ?? 0, currHitRate);

				// Detect prompt-cache breakdown caused by local reasoning-cache
				// misses. See shouldWarnCacheBreakdown for the causal rationale.
				if (
					shouldWarnCacheBreakdown(
						currHitRate,
						this._peakCacheHitRate,
						reasoningStats.misses,
						this._lastCacheWarnTime,
					)
				) {
					this._lastCacheWarnTime = Date.now();
					void this.warnCacheBreakdown(currHitRate, this._peakCacheHitRate, reasoningStats.misses);
				}

				this.log("usage", {
					prompt: promptTotal,
					cache_hit: cacheHit,
					cache_miss: usage.prompt_cache_miss_tokens ?? Math.max(0, promptTotal - cacheHit),
					cache_hit_pct: cacheHitPct.toFixed(1) + "%",
					completion: usage.completion_tokens ?? 0,
					reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
					chars_per_token: this._charsPerToken.toFixed(2),
					session_reqs: this._sessionRequestCount,
					// Real cost will surface after the next balance refresh
					// as `sessionSpend = startBalance - currentBalance`.
				});
				this.refreshStatusBar();
				// Background-refresh balance after each chat (debounced).
				// No-op if the user hasn't fetched balance manually yet.
				this.scheduleBalanceRefresh();
			}
		} catch (err) {
			console.error("[DeepSeek V4] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			throw err;
		}
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return this.estimateText(text);
		}
		let total = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += this.estimateText(part.value);
			}
		}
		return total;
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param silent If true, do not prompt the user.
	 */
	private async ensureApiKey(silent: boolean): Promise<string | undefined> {
		let apiKey = await this.secrets.get("deepseekv4.apiKey");
		if (!apiKey && !silent) {
			const entered = await vscode.window.showInputBox({
				title: "DeepSeek API Key",
				prompt: "Enter your DeepSeek API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("deepseekv4.apiKey", apiKey);
			}
		}
		return apiKey;
	}

	/**
	 * Read and parse the DeepSeek streaming (SSE) response and report parts.
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	    private async processStreamingResponse(
	        ctx: StreamContext,
	        responseBody: ReadableStream<Uint8Array>,
	        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	        token: vscode.CancellationToken,
	    ): Promise<DSUsage | undefined> {
        const reader = responseBody.getReader();
        // Bridge user-cancellation into reader.cancel() so an in-flight
        // `await reader.read()` resolves immediately (done=true) instead of
        // blocking until the next SSE chunk arrives. Without this, cancelling
        // a long thinking-mode request leaves the read promise hanging until
        // DeepSeek emits its next byte — could be tens of seconds for
        // max-effort reasoning chains.
        const cancelSub = token.onCancellationRequested(() => {
            void reader.cancel().catch(() => { /* reader already closed */ });
        });
        const decoder = new TextDecoder();
        let buffer = "";
        let lastUsage: DSUsage | undefined;

			try {
				while (!token.isCancellationRequested) {
					const { done, value } = await reader.read();
                if (done) { break; }

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) {
							continue;
						}
						const data = line.slice(6);
                    if (data === "[DONE]") {
                        // Do not throw on [DONE]; any incomplete/empty buffers are ignored.
                        await this.flushToolCallBuffers(ctx, progress, /*throwOnInvalid*/ false);
                        // Defensive cache write: if no finish_reason was seen but reasoning
                        // was streamed, still persist it. Idempotent — same fingerprint
                        // just overwrites.
                        this.persistReasoningForTurn(ctx);
                        continue;
                    }

						try {
							const parsed = JSON.parse(data) as Record<string, unknown>;
                        // DS sends a final chunk with `usage` populated when
                        // stream_options.include_usage=true. Capture it before
                        // dispatching so we have token counts for cost reporting.
                        if (parsed.usage && typeof parsed.usage === "object") {
                            lastUsage = parsed.usage as DSUsage;
                        }
                        await this.processDelta(ctx, parsed, progress);
                    } catch {
                        // Silently ignore malformed SSE lines temporarily
                    }
                }
            }
        } finally {
            cancelSub.dispose();
            reader.releaseLock();
            // ctx is per-call, so no leftover state needs to be cleared here —
            // it just goes out of scope when the request finishes.
        }
        return lastUsage;
    }

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param ctx Per-call stream state.
	 * @param delta Parsed SSE chunk from the Router.
	 * @param progress Progress reporter for parts.
	 */
    private async processDelta(
        ctx: StreamContext,
        delta: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) { return false; }

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// DeepSeek streams chain-of-thought as `reasoning_content` interleaved
		// with `content`. We always accumulate it into the per-turn buffer so
		// the cache write at finish-time can round-trip it on the next turn.
		// We also try to surface it to the UI: prefer the proposed
		// LanguageModelThinkingPart via reflection; fall back to a one-shot
		// "💭 Thinking..." text hint if the API isn't available.
		// Either way, the raw reasoning is mirrored live to the OutputChannel
		// so you can watch the model think in real time.
		const reasoningChunk = deltaObj?.reasoning_content;
		if (typeof reasoningChunk === "string" && reasoningChunk.length > 0) {
			const logRawReasoning = vscode.workspace
				.getConfiguration("deepseekv4")
				.get<boolean>("logRawReasoning", false);
			if (ctx.reasoning === "" && logRawReasoning) {
				// First reasoning chunk this turn — mark the section start.
				this.outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] thinking.start ▼`);
			}
			ctx.reasoning += reasoningChunk;
			// Raw reasoning may contain private code/paths/intermediate state.
			// Gated behind `deepseekv4.logRawReasoning` (default off). The
			// `thinking.end` summary line in persistReasoningForTurn still
			// fires regardless, so users see *that* reasoning happened.
			if (logRawReasoning) {
				this.outputChannel.append(reasoningChunk);
			}
			const ThinkingCtor = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
				| (new (text: string, id?: string, metadata?: unknown) => unknown)
				| undefined;
			if (ThinkingCtor) {
				try {
					progress.report(new ThinkingCtor(reasoningChunk) as unknown as vscode.LanguageModelResponsePart);
					emitted = true;
				} catch (e) {
					console.error("[DeepSeek V4] ThinkingPart emit failed", e);
				}
			} else if (!ctx.hasShownThinkingHint) {
				progress.report(new vscode.LanguageModelTextPart("💭 Thinking...\n\n"));
				ctx.hasShownThinkingHint = true;
				emitted = true;
			}
		}

            if (deltaObj?.content) {
                const content = String(deltaObj.content);
                if (content.length > 0) {
                    progress.report(new vscode.LanguageModelTextPart(content));
                    emitted = true;
                }
            }

			if (deltaObj?.tool_calls) {
                const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

				for (const tc of toolCalls) {
					const idx = (tc.index as number) ?? 0;
					// Ignore any further deltas for an index we've already completed
					if (ctx.completedToolCallIndices.has(idx)) {
						continue;
					}
					const buf = ctx.toolCallBuffers.get(idx) ?? { args: "" };
					if (tc.id && typeof tc.id === "string") {
						buf.id = tc.id as string;
					}
					const func = tc.function as Record<string, unknown> | undefined;
					if (func?.name && typeof func.name === "string") {
						buf.name = func.name as string;
					}
					if (typeof func?.arguments === "string") {
						buf.args += func.arguments as string;
					}
					ctx.toolCallBuffers.set(idx, buf);

					// Emit immediately once arguments become valid JSON to avoid perceived hanging
                    await this.tryEmitBufferedToolCall(ctx, idx, progress);
                }
            }

        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish !== undefined) {
            // DeepSeek can return special finish_reasons INSIDE an HTTP 200
            // response (i.e. mid-stream truncation). The official docs list:
            //   stop | length | content_filter | tool_calls | insufficient_system_resource
            // We surface non-clean ones so the user knows the turn was cut
            // off, and so we don't accidentally throw on partial tool-call
            // JSON that the model never finished emitting.
            if (finish === "insufficient_system_resource") {
                this.log("api.midstream_truncate", {
                    finish,
                    reasoningLen: ctx.reasoning.length,
                    contentLen: ctx.emittedText.length,
                });
                // Severity: this is a true mid-stream failure, not a hint —
                // upgrade to ErrorMessage. We do NOT bind a "Retry" button
                // to a chat-host command (e.g. workbench.action.chat.send)
                // because Copilot Chat's submit/resend flow is panel-internal
                // and not exposed as a stable, panel-agnostic command. The
                // user resends from the chat input themselves; we just give
                // them a path to inspect what was truncated.
                void (async () => {
                    const choice = await vscode.window.showErrorMessage(
                        "DeepSeek backend ran out of capacity mid-stream. The response is incomplete — please send your message again.",
                        "Show Log",
                    );
                    if (choice === "Show Log") {
                        void vscode.commands.executeCommand("deepseekv4.showLog");
                    }
                })();
            } else if (finish === "length") {
                this.log("api.length_truncate", { finish });
            } else if (finish === "content_filter") {
                this.log("api.content_filter", { finish });
            }

            // Only require valid JSON args when the stream finished cleanly.
            // On truncation, partial tool-call JSON is expected; we flush
            // best-effort and drop unparseable buffers without throwing.
            const isClean = finish === "tool_calls" || finish === "stop";
            await this.flushToolCallBuffers(ctx, progress, /*throwOnInvalid=*/ isClean);
            this.persistReasoningForTurn(ctx);
        }
        return emitted;
    }

    /**
     * Stash this turn's accumulated reasoning into the LRU cache. We always
     * write — even when this turn has no tool calls — because integration
     * tests confirm that when `tools` are advertised in a thinking-mode
     * request, DeepSeek demands EVERY prior assistant turn carry
     * reasoning_content, not just turns that themselves invoked a tool.
     * (When no tools are advertised, no-tc turns don't need it — but
     * caching them anyway is harmless and simplifies the logic.)
     *
     * Fingerprint anchors:
     *   - tool_calls present → name:id (most stable)
     *   - otherwise          → emitted visible text (whitespace-normalized)
     */
    private persistReasoningForTurn(ctx: StreamContext): void {
        if (!ctx.reasoning) {
            return;
        }
        // Close out the live thinking stream with a newline so subsequent
        // structured log lines render cleanly. The summary line fires
        // unconditionally so users know reasoning happened even when raw
        // streaming is gated off (`deepseekv4.logRawReasoning` = false).
        const logRawReasoning = vscode.workspace
            .getConfiguration("deepseekv4")
            .get<boolean>("logRawReasoning", false);
        if (logRawReasoning) {
            this.outputChannel.appendLine("");
        }
        this.outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] thinking.end ▲ (${ctx.reasoning.length} chars)`);
        const fp = fingerprintAssistantTurn({
            text: ctx.emittedText,
            toolCalls: ctx.emittedToolCalls,
        });
        if (!fp) {
            // No anchor (no text emitted AND no tool calls). Can't key this
            // turn into the cache; drop the reasoning silently.
            this.log("cache.skip", { reason: "no-anchor", reasoningLen: ctx.reasoning.length });
            ctx.reasoning = "";
            return;
        }
        this.log("cache.set", {
            fp,
            mode: fp.startsWith("tc:") ? "tool_calls" : "text",
            toolCalls: ctx.emittedToolCalls,
            textLen: ctx.emittedText.length,
            textHead: ctx.emittedText.slice(0, 80),
            reasoningLen: ctx.reasoning.length,
        });

        const byteLen = Buffer.byteLength(ctx.reasoning, "utf8");
        if (byteLen > ReasoningCache.ENTRY_SIZE_WARN_BYTES) {
            this.log("cache.warn.large_entry", {
                fp,
                byteLen,
                warnLimit: ReasoningCache.ENTRY_SIZE_WARN_BYTES,
                hint: "reasoning chain exceeds recommended size; may cause memory pressure",
            });
        }

        this._reasoningCache.set(fp, ctx.reasoning);

        // After writing, check if the total cache size is approaching the
        // globalState persistence limit. Log a warning so users can monitor
        // via the cache stats command. No eviction here — that's handled
        // inside ReasoningCache.set() by the oldest-first LRU + byte cap.
        const stats = this._reasoningCache.stats();
        if (stats.totalBytes > ReasoningCache.TOTAL_BYTES_WARN) {
            this.log("cache.warn.total_size", {
                totalBytes: stats.totalBytes,
                warnLimit: ReasoningCache.TOTAL_BYTES_WARN,
                maxLimit: ReasoningCache.MAX_TOTAL_BYTES,
                entryCount: stats.entryCount,
                hint: "cache approaching VS Code globalState limits; old entries will be evicted automatically",
            });
        }

        // Reset so a second [DONE]/finish_reason in the same turn doesn't double-write.
        ctx.reasoning = "";
    }

    /**
     * Walk the converted history and re-attach `reasoning_content` to every
     * prior assistant turn (with or without tool_calls). Integration tests
     * confirm: DeepSeek's actual rule for thinking-mode requests is:
     *   - `tools` not advertised → only tc-assistant turns NEED reasoning
     *   - `tools` advertised     → ALL prior assistant turns NEED reasoning
     * Mutates messages in place.
     * On cache miss, sets reasoning_content="" as fallback to prevent a
     * guaranteed 400 from the API. The conversation may be slightly degraded
     * (the model loses one turn's reasoning context) but can continue.
     */
    private attachReasoningToHistory(messages: OpenAIChatMessage[]): { hits: number; misses: number } {
        let hits = 0;
        let misses = 0;
        for (const msg of messages) {
            if (msg.role !== "assistant") {
                continue;
            }
            if (msg.reasoning_content) {
                continue;
            }
            const fp = fingerprintAssistantTurn({
                text: msg.content ?? "",
                toolCalls: (msg.tool_calls ?? []).map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                })),
            });
            if (!fp) {
                continue;
            }
            const reasoning = this._reasoningCache.get(fp);
            if (reasoning) {
                msg.reasoning_content = reasoning;
                hits++;
            } else {
                misses++;
                // Fallback: set empty reasoning_content so the API doesn't 400.
                // This covers turns where reasoning was never cached (empty
                // CoT, evicted, or from a pre-cache session). The model loses
                // this turn's reasoning context but the conversation survives.
                msg.reasoning_content = "";
                const tcSummary = (msg.tool_calls ?? []).map((tc) => `${tc.function.name}:${tc.id}`);
                this.log("cache.MISS", {
                    fp,
                    mode: fp.slice(0, 2),
                    toolCalls: tcSummary,
                    contentLen: msg.content?.length ?? 0,
                    cacheKeys: this._reasoningCache.keys(),
                });
            }
        }
        if (hits + misses > 0) {
            this.log("cache.attach", { hits, misses, total: hits + misses });
        }
        return { hits, misses };
    }

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param ctx Per-call stream state.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
    private async tryEmitBufferedToolCall(
        ctx: StreamContext,
        index: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<void> {
        const buf = ctx.toolCallBuffers.get(index);
        if (!buf) {
            return;
        }
        if (!buf.name) {
            return;
        }
        const canParse = tryParseJSONObject(buf.args);
        if (!canParse.ok) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, canParse.value));
        ctx.toolCallBuffers.delete(index);
        ctx.completedToolCallIndices.add(index);
    }

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param ctx Per-call stream state.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
    private async flushToolCallBuffers(
        ctx: StreamContext,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        throwOnInvalid: boolean,
    ): Promise<void> {
        if (ctx.toolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(ctx.toolCallBuffers.entries())) {
            const parsed = tryParseJSONObject(buf.args);
            if (!parsed.ok) {
                if (throwOnInvalid) {
                    console.error("[DeepSeek V4] Invalid JSON for tool call", { idx, snippet: (buf.args || "").slice(0, 200) });
                    throw new Error("Invalid JSON for tool call");
                }
                // When not throwing (e.g. on [DONE]), drop silently to reduce noise
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
            ctx.toolCallBuffers.delete(idx);
            ctx.completedToolCallIndices.add(idx);
        }
    }
}
