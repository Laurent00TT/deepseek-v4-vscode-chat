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

import type { DSUsage, OpenAIChatMessage } from "./types";

import { convertTools, convertMessages, validateRequest } from "./utils";
import {
	splitSseLines,
	parseSseData,
	extractDelta,
	isCleanFinish,
	ToolCallAssembler,
	type CompletedToolCall,
} from "./sse";
import { IMAGE_TOKENS_PER_IMAGE, MAX_REQUEST_BODY_BYTES, contentText } from "./image_content";
import { buildRequestBody, coerceReasoningEffort } from "./request_body";
import { MODEL_VARIANTS, findVariant } from "./model_catalog";
import { BASE_URL, BALANCE_URL, fetchWithRetry, formatApiError, type BalanceInfo } from "./api_client";
import { toWireName, buildWireNameMap } from "./tool_names";
import { assertAdvertisedToolLimit } from "./tool_limit";
import { ReasoningCache, fingerprintAssistantTurn, type CachedTurn, type ReasoningCacheStats } from "./reasoning_cache";
import { shouldWarnCacheBreakdown } from "./cache_breakdown";
import { isPeakTime, nextBoundary, offPeakWindowsUtc, formatWindowsLocal, PEAK_WINDOWS_UTC } from "./off_peak";
import { ContextUsageService } from "./context_usage_service";
import { classifyRequestKind, isReportableContextRequest, type RequestKind } from "./request_kind";

const REASONING_CACHE_STATE_KEY = "deepseekv4.reasoningCache";

/** Fallback text emitted as a real TextPart when the host lacks
 * LanguageModelThinkingPart. Shared by the stream path (emit) and
 * persistReasoningForTurn (which must refuse to fingerprint a turn whose
 * only text is this constant — see the degenerate-anchor comment there). */
const THINKING_FALLBACK_HINT = "💭 Thinking...\n\n";

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
 * are still pulled from API `usage` (the DSUsage shape in types.ts) and
 * surfaced in the status bar and tooltip — that part doesn't depend on
 * pricing.
 */

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
		case "CNY":
			return "¥";
		case "USD":
			return "$";
		case "EUR":
			return "€";
		case "GBP":
			return "£";
		case "JPY":
			return "¥";
		default:
			return currency + " ";
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
		"Show Log"
	);
	if (choice === "Start New Chat") {
		void vscode.commands.executeCommand("workbench.action.chat.newChat");
	} else if (choice === "Show Log") {
		void vscode.commands.executeCommand("deepseekv4.showLog");
	}
}

function formatTokenK(tokens: number): string {
	// Auto-pick K vs M unit using SI (base-1000), matching how LLM APIs
	// report and price tokens ("$X / 1M tokens"). The previous base-1024
	// (KiB) convention was inherited from byte-formatting templates and
	// caused a confusing mismatch with raw token counts elsewhere in the
	// UI — e.g. header showing "106.8K" while the Prompt-tokens row
	// showed "109,067" for the same value.
	//
	// The ".0" trim keeps near-integer megatoken counts clean ("1M" not
	// "1.0M") since model windows are typically marketed in round
	// megatokens even when the precise sum (e.g. 1,048,576) isn't.
	if (tokens >= 1_000_000) {
		const s = (tokens / 1_000_000).toFixed(1);
		return s.endsWith(".0") ? `${s.slice(0, -2)}M` : `${s}M`;
	}
	return `${(tokens / 1000).toFixed(1)}K`;
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
			"Update API Key"
		);
		if (choice === "Update API Key") {
			void vscode.commands.executeCommand("deepseekv4.manage");
		}
		return;
	}
	if (status === 402) {
		const choice = await vscode.window.showErrorMessage(
			`DeepSeek account has insufficient balance (402). ${summary}`,
			"Open DeepSeek Billing"
		);
		if (choice === "Open DeepSeek Billing") {
			void vscode.env.openExternal(vscode.Uri.parse("https://platform.deepseek.com/usage"));
		}
		return;
	}
	if (status === 422) {
		const choice = await vscode.window.showErrorMessage(
			`DeepSeek rejected the request schema (422). This usually means the extension and host are out of sync. ${summary}`,
			"Reload Window"
		);
		if (choice === "Reload Window") {
			void vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
		return;
	}
	if (status === 429) {
		void vscode.window.showWarningMessage(
			`DeepSeek rate limited (429). The extension already retried — try again in a moment.`
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
				"Show Log"
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
 * State scoped to a single `provideLanguageModelChatResponse` invocation.
 *
 * Previously these were instance fields on the provider, which assumed VS
 * Code calls `provideLanguageModelChatResponse` strictly serially. With
 * multi-window / multi-chat-panel scenarios that assumption is fragile; an
 * outer scheduler now creates a fresh StreamContext per call so concurrent
 * turns can't trample each other's tool-call buffers or reasoning capture.
 */
class StreamContext {
	/** Incremental tool-call assembly (buffers + completed-index dedup) —
	 * the pure state machine lives in sse.ts; this holds one per turn. */
	readonly toolCalls = new ToolCallAssembler();
	/** Full reasoning_content for this turn — round-tripped on the next turn. */
	reasoning = "";
	/** Visible text emitted this turn — fallback fingerprint when no tool_calls. */
	emittedText = "";
	/** Tool calls emitted this turn — primary fingerprint anchor when present. */
	readonly emittedToolCalls: Array<{ id: string; name: string }> = [];
	/**
	 * wire→host tool-name reverse map for THIS request's advertised tools
	 * (issue #20). The API only ever sees deterministic spec-legal aliases;
	 * echoed tool_calls are mapped back through this before reporting so
	 * VS Code's tool registry dispatches on the names it registered.
	 */
	wireNameToHost = new Map<string, string>();
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

	/** Running maximum of prompt-cache hit-rate observed this session.
	 * Persists across turns because the breakdown detector needs to know
	 * "did this cache ever work?" — that question requires history.
	 * Other per-turn token counts (prompt/completion/cache_hit/etc) are
	 * read straight from `this.contextUsage.getSnapshot()`, so they don't
	 * need duplicated provider fields. */
	private _peakCacheHitRate?: number;
	private _lastCacheWarnTime?: number;

	/** Tracks whether the 95% context-window nudge has already fired
	 * this session. Auto-resets when usage drops below 80% (i.e. user
	 * compacted or started new chat) so the next fill-up re-arms it.
	 * Manually reset by clearSession / secret-change. */
	private _contextNudgeFired = false;

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

	/** Fires at the next peak/off-peak window edge so an idle window's
	 * tooltip doesn't go stale across a boundary (issue #22). Re-armed on
	 * every firing; cleared on dispose. */
	private _peakBoundaryTimer: NodeJS.Timeout | undefined;

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
		private readonly statusBar: vscode.StatusBarItem
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
					this._contextNudgeFired = false;
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
			})
		);

		this.refreshStatusBar();
		this.schedulePeakBoundaryRefresh();

		// Fire-and-forget initial fetch so the status bar shows balance after
		// VS Code reload without requiring a manual hover-refresh first.
		// Silent: errors swallowed — no-op if API key isn't configured yet.
		void this.refreshBalance(true);
	}

	/**
	 * Arm a one-shot timer for the next peak/off-peak window edge, then
	 * re-arm on firing. The tooltip is declarative (see flashRefreshAck's
	 * comment): it renders whatever `buildTooltip()` produced at the last
	 * `refreshStatusBar()`. Chat activity rebuilds it constantly, but an
	 * idle window that sits across a boundary (e.g. overnight) would keep
	 * showing the stale side — this timer covers exactly that gap.
	 *
	 * +250ms pad so clock rounding can't fire the callback a hair BEFORE
	 * the edge, which would render the old state and then sleep ~24h.
	 */
	private schedulePeakBoundaryRefresh(): void {
		if (this._peakBoundaryTimer) {
			clearTimeout(this._peakBoundaryTimer);
		}
		const now = new Date();
		const delayMs = nextBoundary(now).getTime() - now.getTime() + 250;
		this._peakBoundaryTimer = setTimeout(() => {
			this._peakBoundaryTimer = undefined;
			this.refreshStatusBar();
			this.schedulePeakBoundaryRefresh();
		}, delayMs);
	}

	private refreshStatusBar(): void {
		const balanceStr = this._balance
			? ` ${currencySymbol(this._balance.currency)}${this._balance.totalBalance.toFixed(2)}`
			: "";
		// Issue #17: the status bar shows the account balance only. Per-turn
		// context usage used to live here as `| X%`, but a status-bar item has
		// no conversation id and no focus signal, so with multiple chats open it
		// could only ever show "the last turn that ran" — it swapped between
		// conversations. Context usage is now reported to GitHub Copilot Chat's
		// NATIVE per-conversation context indicator instead (see the `usage`
		// data part in provideLanguageModelChatResponse).
		this.statusBar.text = `V₄${balanceStr}`;
		this.statusBar.color = new vscode.ThemeColor("descriptionForeground");
		this.statusBar.tooltip = this.buildTooltip();
		this.statusBar.backgroundColor = undefined;
		this.statusBar.show();
	}

	/**
	 * Single-turn footprint as a fraction of the 1M shared context window:
	 *   numerator   = prompt_tokens + completion_tokens   (server-reported)
	 *   denominator = maxInputTokens + maxOutputTokens    (= 1M total)
	 *
	 * Conceptually this is the most honest framing: DeepSeek enforces
	 * prompt + completion ≤ 1M on a single request, so both quantities
	 * consume the same shared pool and both are precisely measured. The
	 * percentage therefore answers "how much of the 1M did this turn
	 * actually use, end to end".
	 *
	 * Prior framings (input-only numerator over input-budget denominator)
	 * hid output cost entirely; including completion_tokens here surfaces
	 * how much of the budget was actually spent on reasoning + visible
	 * response, not just prompt history.
	 *
	 * Falls back to estimate (no completion data) before the first response.
	 */
	private contextUsagePct(): number | undefined {
		const snap = this.contextUsage.getSnapshot();
		if (!snap) {
			return undefined;
		}
		const totalWindow = snap.maxInputTokens + snap.maxOutputTokens;
		if (totalWindow <= 0) {
			return undefined;
		}
		const completion = snap.apiCompletionTokens ?? 0;
		return (snap.usedTokens + completion) / totalWindow;
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
			4000
		);
	}

	private buildTooltip(): vscode.MarkdownString {
		const md = new vscode.MarkdownString("", true);
		// Narrow `isTrusted` to exactly the commands this tooltip renders.
		// Using `true` (full trust) would allow ANY command:URI in the
		// markdown to execute on click — defense-in-depth against a future
		// regression where dynamic data (e.g. balance API response fields,
		// model display names) leaks into a command-link href position.
		// Today there's no such path, but principle of least privilege is
		// free here.
		md.isTrusted = {
			enabledCommands: [
				"deepseekv4.refreshBalance",
				"deepseekv4.compactCopilotChat",
				"deepseekv4.showLog",
				"workbench.action.openSettings",
			],
		};
		md.supportThemeIcons = true;

		// Issue #22: pricing-window panel, pinned above the header as its own
		// visually separate section. Both windows are listed in LOCAL wall-clock
		// time and the row the system clock currently falls in carries the
		// filled radio dot (bold label); the other row stays outlined — a
		// read-only radio group driven by the clock. No prices or multipliers
		// (those drift; see the session-cost rationale above the BalanceInfo
		// interface). The dot can go stale while the hover popup is open across
		// a window edge; the boundary timer (schedulePeakBoundaryRefresh)
		// rebuilds the tooltip for the next hover, matching the accepted
		// staleness model documented on flashRefreshAck.
		const now = new Date();
		const peakNow = isPeakTime(now);
		const tzOffset = -now.getTimezoneOffset();
		const row = (active: boolean, label: string, windows: string) =>
			`${active ? "$(circle-filled)" : "$(circle-outline)"} ${active ? `**${label}**` : label} &nbsp;&nbsp; ${windows}\n\n`;
		md.appendMarkdown(row(peakNow, "Peak/高峰", formatWindowsLocal(PEAK_WINDOWS_UTC, tzOffset)));
		md.appendMarkdown(row(!peakNow, "Off-peak/非高峰", formatWindowsLocal(offPeakWindowsUtc(), tzOffset)));
		md.appendMarkdown("---\n\n");

		md.appendMarkdown("### DeepSeek V4\n\n");

		// Balance row: refresh action sits inline next to the **Balance** label.
		md.appendMarkdown(
			this._balance
				? "**Balance** &nbsp; [$(refresh) refresh](command:deepseekv4.refreshBalance)\n\n"
				: "**Balance** &nbsp; [$(refresh) click to fetch](command:deepseekv4.refreshBalance)\n\n"
		);
		if (this._balance) {
			const sym = currencySymbol(this._balance.currency);
			const time = formatTime24(this._balance.fetchedAt);
			md.appendMarkdown(`${sym}${this._balance.totalBalance.toFixed(2)} &nbsp;·&nbsp; ${time}\n\n`);
			if (this._balance.grantedBalance > 0) {
				md.appendMarkdown(
					`_${sym}${this._balance.grantedBalance.toFixed(2)} granted + ${sym}${this._balance.toppedUpBalance.toFixed(2)} topped up_\n\n`
				);
			}
			// Session spend = startBalance - currentBalance. This is the
			// real billed amount (lagged ~1.5s by debounced balance refresh)
			// rather than a hardcoded-price estimate.
			const spend = this.sessionSpend();
			if (spend !== undefined && spend.amount > 0) {
				const reqWord = this._sessionRequestCount === 1 ? "request" : "requests";
				md.appendMarkdown(
					`_Session: ${sym}${spend.amount.toFixed(4)} &nbsp;·&nbsp; ${this._sessionRequestCount} ${reqWord}_\n\n`
				);
			}
		}

		md.appendMarkdown("---\n\n");

		// Per-turn context usage is no longer rendered here. It's reported to
		// GitHub Copilot Chat's native per-conversation context indicator
		// instead (see the `usage` data part in
		// provideLanguageModelChatResponse), which — unlike a status-bar item —
		// follows the focused chat. The snapshot is still read below for the
		// DeepSeek-specific cache-hit row, which Copilot's UI doesn't surface.
		const snap = this.contextUsage.getSnapshot();

		// Cache hit-rate row — derived from the snapshot. Uses the same
		// SI-K formatting as the tooltip header so the cached value
		// visually matches the prompt-token row.
		if (snap?.apiPromptTokens !== undefined && snap.apiPromptTokens > 0 && snap.apiCacheHitTokens !== undefined) {
			const hitRate = snap.apiCacheHitTokens / snap.apiPromptTokens;
			const hitPctStr = (hitRate * 100).toFixed(1);
			md.appendMarkdown(
				`**Cache hit (last turn)** &nbsp; ${hitPctStr}% (${formatTokenK(snap.apiCacheHitTokens)} cached)\n\n`
			);
		}

		md.appendMarkdown("---\n\n");

		// Reasoning effort row: shows the current setting value plus a click-
		// through to the specific setting. Helps discoverability — users who
		// hover the status bar to check cost will also notice this control.
		const currentEffort = vscode.workspace.getConfiguration("deepseekv4").get<string>("reasoningEffort", "max");
		md.appendMarkdown(
			`**Reasoning effort** &nbsp; \`${currentEffort}\` &nbsp; [$(gear) configure](command:workbench.action.openSettings?%22deepseekv4.reasoningEffort%22)\n\n`
		);
		md.appendMarkdown("[View full log](command:deepseekv4.showLog)");

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
		// Reset cross-turn state; per-turn token counts are cleared via the
		// contextUsage.clear() below (which wipes the snapshot).
		this._peakCacheHitRate = undefined;
		this._contextNudgeFired = false;
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
		vscode.window.showInformationMessage(`Cleared ${before} reasoning cache entr${before === 1 ? "y" : "ies"}.`);
	}

	/**
	 * Notify the user that the prompt cache is no longer benefiting them.
	 * Triggered by `shouldWarnCacheBreakdown`. The two CTAs (start a new chat
	 * vs inspect the cache stats) cover the two reasonable responses: cut
	 * losses, or diagnose. Either is better than silently burning money.
	 *
	 * The message deliberately lists causes without asserting one: the code
	 * cannot tell WHY a fingerprint missed (issue #19 was misdiagnosed for
	 * weeks because an earlier wording claimed "lost across a restart" as
	 * fact). Diagnosis belongs in Show Cache Stats, not in the toast.
	 */
	private async warnCacheBreakdown(currHitRate: number, peakHitRate: number, reasoningMisses: number): Promise<void> {
		const curr = (currHitRate * 100).toFixed(0);
		const peak = (peakHitRate * 100).toFixed(0);
		const missWord = reasoningMisses === 1 ? "miss" : "misses";
		const choice = await vscode.window.showWarningMessage(
			`DeepSeek prompt cache hit rate dropped to ${curr}% (peak ${peak}%). ${reasoningMisses} reasoning cache ${missWord} this turn broke the cached prompt prefix — possible causes: an earlier turn that was cancelled or failed mid-stream, cache eviction in a very long session, or an editor restart. Continuing risks higher cost (cache-miss tokens cost ~12× more).`,
			"Start New Chat",
			"Show Cache Stats"
		);
		if (choice === "Start New Chat") {
			void vscode.commands.executeCommand("workbench.action.chat.newChat");
		} else if (choice === "Show Cache Stats") {
			void vscode.commands.executeCommand("deepseekv4.showCacheStats");
		}
	}

	/**
	 * Single-shot nudge when the 1M shared context window crosses 95%.
	 * Offers the user two actionable paths (Compact / Show Details) and
	 * a passive Dismiss. Re-arms automatically when usage drops below
	 * 80% (handled in the usage handler — see _contextNudgeFired).
	 *
	 * Why warning-level not info-level: at 95% the user is one
	 * non-trivial turn away from a context-overflow 400 error. A
	 * yellow toast is the right urgency.
	 */
	private async nudgeContextNearLimit(pct: number): Promise<void> {
		const pctStr = (pct * 100).toFixed(0);
		this.log("context.nudge.fired", { ctxPct: pct.toFixed(3) });
		const choice = await vscode.window.showWarningMessage(
			`DeepSeek context window at ${pctStr}% — approaching the 1M limit. Compact the conversation to free space?`,
			"Compact Conversation"
		);
		if (choice === "Compact Conversation") {
			void vscode.commands.executeCommand("deepseekv4.compactCopilotChat");
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
				vscode.window.showWarningMessage('DeepSeek API key not configured. Run "Manage DeepSeek V4 Provider" first.');
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
		if (this._peakBoundaryTimer) {
			clearTimeout(this._peakBoundaryTimer);
			this._peakBoundaryTimer = undefined;
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
			try {
				sub.dispose();
			} catch {
				/* ignore */
			}
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

	/**
	 * Count image attachments across USER turns — the only place the wire
	 * conversion emits image blocks. Uses the same structural detection as
	 * convertMessages (mimeType `image/*` + Uint8Array data) so the estimate
	 * counts exactly the parts that will be sent. Char-based estimation
	 * doesn't work for images, so they are budgeted separately at the fixed
	 * IMAGE_TOKENS_PER_IMAGE ceiling.
	 */
	private countImageParts(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let count = 0;
		for (const m of msgs) {
			if (m.role !== vscode.LanguageModelChatMessageRole.User) {
				continue;
			}
			for (const part of m.content) {
				const obj = part as { mimeType?: unknown; data?: unknown };
				if (typeof obj.mimeType === "string" && obj.mimeType.startsWith("image/") && obj.data instanceof Uint8Array) {
					count++;
				}
			}
		}
		return count;
	}

	/** Concatenated text of a single chat message (text parts only). */
	private messageText(m: vscode.LanguageModelChatMessage | undefined): string {
		if (!m) {
			return "";
		}
		let text = "";
		for (const part of m.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			}
		}
		return text;
	}

	/** Classify a request (issue #17) so we only report token usage to
	 * Copilot's native context indicator for real conversation turns — not for
	 * the small auxiliary requests (chat-title, progress messages, etc.) Copilot
	 * routes through the model. See `./request_kind`. */
	private classifyRequest(
		messages: readonly vscode.LanguageModelChatMessage[],
		options: ProvideLanguageModelChatResponseOptions
	): ReturnType<typeof classifyRequestKind> {
		const firstText = this.messageText(messages[0]);
		let latestUserText = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
				latestUserText = this.messageText(messages[i]);
				break;
			}
		}
		const toolNames = options.tools?.map((t) => t.name) ?? [];
		return classifyRequestKind(firstText, latestUserText, toolNames);
	}

	private countToolChars(
		tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
	): number {
		if (!tools || tools.length === 0) {
			return 0;
		}
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

		return MODEL_VARIANTS.map(
			(v) =>
				({
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
						// Vision variants accept image attachments; Copilot Chat only
						// enables the attach-image UI when this is true.
						imageInput: v.vision === true,
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
				}) as unknown as LanguageModelChatInformation
		);
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
							// Fingerprint on the WIRE name, not the host name the
							// part carries: the get-side fingerprint
							// (attachReasoningToHistory) runs over convertMessages
							// output, which aliases names via toWireName. Keying
							// the set side on host names would make every aliased
							// tool call a guaranteed cache miss on the next
							// request — reasoning loss + broken prompt-cache
							// prefix (issue #19's failure mode).
							name: toWireName(part.name),
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

			const openaiMessages = convertMessages(messages, { imageInput: variant.vision === true });
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
			// Classify the request once, up front. Three consumers: the
			// reasoning-cache stats gate right below, the native context-
			// indicator usage report, and the cache-breakdown warning (both
			// in the post-stream usage block). On classifier failure fall
			// back to "unknown", which every consumer excludes — a real turn
			// simply re-classifies on its next request.
			let kind: RequestKind = "unknown";
			try {
				kind = this.classifyRequest(messages, options);
			} catch (e) {
				this.log("ctxusage.classify_failed", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
			const isRealTurn = isReportableContextRequest(kind);

			// Only attach reasoning_content when the current request is in
			// thinking mode. Sending reasoning_content to a non-thinking
			// endpoint wastes prefix tokens (server still has to tokenise it
			// before discarding) and the empty-string fallback breaks
			// prompt-cache prefix anyway. When user switches from a thinking
			// variant to a non-thinking one mid-conversation, prior assistant
			// turns may also already carry reasoning_content — strip it.
			//
			// The attach itself runs for EVERY thinking request — auxiliary
			// requests need the "" stub too or the API 400s — but only real
			// conversation turns count toward the cache hit/miss statistics.
			let reasoningStats = { hits: 0, misses: 0 };
			if (variant.thinking) {
				reasoningStats = this.attachReasoningToHistory(openaiMessages, isRealTurn);
			} else {
				for (const m of openaiMessages) {
					if (m.role === "assistant" && m.reasoning_content !== undefined) {
						delete m.reasoning_content;
					}
				}
			}

			validateRequest(messages);

			const toolConfig = convertTools(options);
			// Reverse map for THIS request's tool set (first-wins on the
			// astronomically-rare wire-name collision, mirroring the
			// advertise-side skip in convertTools).
			ctx.wireNameToHost = buildWireNameMap((options.tools ?? []).map((t) => t?.name));

			// The cap counts the ADVERTISED set, not options.tools — since
			// the issue #20 wire-aliasing fix, tool assembly may skip
			// unusable/colliding tools, so the host list can be over 128
			// while the set actually broadcast to the API is legal. The
			// guard's parameter type makes feeding the host list a compile
			// error; see tool_limit.ts.
			assertAdvertisedToolLimit(toolConfig.tools);

			const messageChars = this.countMessageChars(messages);
			const toolChars = this.countToolChars(toolConfig.tools);
			// Per-request char count lives in a LOCAL — if it were on the
			// instance, two concurrent provideLanguageModelChatResponse calls
			// could overwrite each other between the fetch and the usage
			// callback, polluting the EMA estimator with the wrong request's
			// size.
			const requestInputChars = messageChars + toolChars;
			// Images bypass the char-based estimator: each is billed at up to
			// 384 tokens regardless of byte size. Counted only for vision
			// variants — everywhere else convertMessages drops them.
			const imageTokenCount = variant.vision === true ? this.countImageParts(messages) * IMAGE_TOKENS_PER_IMAGE : 0;
			const inputTokenCount = Math.ceil(messageChars / this._charsPerToken) + imageTokenCount;
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
				estimatedMessageTokens: inputTokenCount,
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
					`Estimated ${(estimated / 1000).toFixed(0)}K input tokens exceeds the ${(tokenLimit / 1000).toFixed(0)}K limit for ${model.name}.`
				);
				throw new Error("Message exceeds token limit.");
			}

			// Body layout (key order, param gating, max_tokens clamp) lives in
			// the pure buildRequestBody — pinned byte-for-byte by the golden
			// test in test/unit_request_body.mjs. Only the VS Code reads stay
			// here.
			const effort = coerceReasoningEffort(
				vscode.workspace.getConfiguration("deepseekv4").get<string>("reasoningEffort", "max")
			);
			if (variant.thinking) {
				this.outputChannel.appendLine(`[req] reasoning_effort=${effort} (variant=${variant.id})`);
			}
			requestBody = buildRequestBody({
				apiModel: variant.apiModel,
				messages: openaiMessages,
				thinking: variant.thinking,
				reasoningEffort: effort,
				maxOutputTokens: model.maxOutputTokens,
				modelOptions: options.modelOptions as Record<string, unknown> | undefined,
				tools: toolConfig.tools,
				tool_choice: toolConfig.tool_choice,
			});
			// Serialize once: reused for the size guard and the fetch body.
			// DeepSeek caps the request body at 48 MiB, and base64 image
			// payloads are what realistically get near it — the token
			// pre-check can pass (images are ~384 tokens each) while the
			// encoded bytes blow the transport cap. Catch it locally with an
			// actionable message instead of surfacing an opaque server 4xx.
			const bodyJson = JSON.stringify(requestBody);
			if (bodyJson.length > MAX_REQUEST_BODY_BYTES) {
				const sizeMiB = (bodyJson.length / (1024 * 1024)).toFixed(1);
				this.log("request.too_large", { bytes: bodyJson.length, limit: MAX_REQUEST_BODY_BYTES });
				const detail = variant.vision
					? `Request body is ${sizeMiB} MiB — over DeepSeek's 48 MiB limit. Attach fewer or smaller images, or start a new chat.`
					: `Request body is ${sizeMiB} MiB — over DeepSeek's 48 MiB limit. Start a new chat or shorten the conversation.`;
				void vscode.window.showErrorMessage(`DeepSeek request too large. ${detail}`);
				throw new Error(`Request body exceeds DeepSeek's 48 MiB limit (${sizeMiB} MiB).`);
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
						body: bodyJson,
						signal: abort.signal,
					},
					abort.signal,
					(msg, data) => this.log(msg, data)
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
				// Image tokens are subtracted first: they contribute prompt
				// tokens without contributing chars, so leaving them in would
				// drag the chars/token ratio down on every multimodal turn.
				this.calibrateCharsPerToken(
					requestInputChars,
					usage.prompt_tokens !== undefined ? Math.max(0, usage.prompt_tokens - imageTokenCount) : undefined
				);
				this._sessionRequestCount += 1;
				const promptTotal = usage.prompt_tokens ?? 0;
				const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
				const cacheHitPct = promptTotal > 0 ? (cacheHit / promptTotal) * 100 : 0;

				// Publish authoritative API values to the shared snapshot.
				// `usage.prompt_cache_miss_tokens` is computed defensively
				// here too in case the server omits it (older API behaviour).
				// Snapshot is the single source of truth for per-turn token
				// counts — tooltip, status bar, and webview all read from it.
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

				// Issue #17: report token usage to GitHub Copilot Chat's NATIVE
				// context-window indicator via a `usage` data part. The host owns
				// the conversation, so its native indicator is inherently
				// per-conversation and follows window focus — something our own
				// status-bar item can never do (a LanguageModelChatProvider gets
				// no conversation id and no focus signal). Mechanism mirrors the
				// upstream Vizards/deepseek-v4-for-copilot provider.
				//
				// BUT only for REAL conversation turns. Copilot routes small
				// auxiliary requests through the model too — notably a `chat-title`
				// request right after the first turn — each carrying only a few
				// hundred tokens. Reporting those would clobber the indicator and
				// reset the displayed context to ~0%. So we classify the request
				// and skip the auxiliary kinds (see ./request_kind).
				// `kind` / `isRealTurn` were classified once at request start
				// (before the reasoning attach) and are reused here.
				try {
					this.log("ctxusage", { kind, prompt: promptTotal, reported: isRealTurn });
					if (isRealTurn) {
						const completion = usage.completion_tokens ?? 0;
						progress.report(
							vscode.LanguageModelDataPart.json(
								{
									prompt_tokens: promptTotal,
									completion_tokens: completion,
									total_tokens: promptTotal + completion,
									prompt_tokens_details: { cached_tokens: cacheHit },
								},
								"usage"
							)
						);
					}
				} catch (e) {
					this.log("ctxusage.report_failed", {
						error: e instanceof Error ? e.message : String(e),
					});
				}

				const currHitRate = promptTotal > 0 ? cacheHit / promptTotal : 0;

				// Issue #19: peak tracking and the breakdown warning consider
				// REAL conversation turns only. Copilot's auxiliary requests
				// (chat-title, conversation-summarizer, todo tracking, …)
				// carry a novel prompt prefix, so their server cache hit rate
				// is legitimately ~0%, and Copilot re-renders history inside
				// them so their reasoning fingerprints can miss — comparing
				// their numbers against a peak set by the main conversation
				// produced false "cache breakdown" popups while the main chat
				// was perfectly healthy. (The contextUsage snapshot above is
				// deliberately NOT gated: the status-bar "last turn" row shows
				// the raw truth of whatever request ran last.)
				if (isRealTurn) {
					this._peakCacheHitRate = Math.max(this._peakCacheHitRate ?? 0, currHitRate);

					// Detect prompt-cache breakdown caused by local reasoning-cache
					// misses. See shouldWarnCacheBreakdown for the causal rationale.
					if (
						shouldWarnCacheBreakdown(
							currHitRate,
							this._peakCacheHitRate,
							reasoningStats.misses,
							this._lastCacheWarnTime
						)
					) {
						this._lastCacheWarnTime = Date.now();
						void this.warnCacheBreakdown(currHitRate, this._peakCacheHitRate, reasoningStats.misses);
					}
				}

				// Context-window nudge at 95%. Fires once per session; auto-rearms
				// when usage drops below 80% (i.e. after the user compacts or
				// clears the conversation). Hysteresis gap (95→80) prevents
				// re-firing on small fluctuations around the threshold.
				const ctxPct = this.contextUsagePct();
				if (ctxPct !== undefined) {
					if (ctxPct < 0.8 && this._contextNudgeFired) {
						this._contextNudgeFired = false;
						this.log("context.nudge.rearmed", { ctxPct: ctxPct.toFixed(3) });
					} else if (ctxPct >= 0.95 && !this._contextNudgeFired) {
						this._contextNudgeFired = true;
						void this.nudgeContextNearLimit(ctxPct);
					}
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
			} else {
				// Image attachments bill at up to 384 tokens each on the Vision
				// variants — budget them at the ceiling so the host's prompt
				// planning never under-counts. Same structural detection as
				// countImageParts.
				const obj = part as { mimeType?: unknown; data?: unknown };
				if (typeof obj.mimeType === "string" && obj.mimeType.startsWith("image/") && obj.data instanceof Uint8Array) {
					total += IMAGE_TOKENS_PER_IMAGE;
				}
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
		token: vscode.CancellationToken
	): Promise<DSUsage | undefined> {
		const reader = responseBody.getReader();
		// Bridge user-cancellation into reader.cancel() so an in-flight
		// `await reader.read()` resolves immediately (done=true) instead of
		// blocking until the next SSE chunk arrives. Without this, cancelling
		// a long thinking-mode request leaves the read promise hanging until
		// DeepSeek emits its next byte — could be tens of seconds for
		// max-effort reasoning chains.
		const cancelSub = token.onCancellationRequested(() => {
			void reader.cancel().catch(() => {
				/* reader already closed */
			});
		});
		const decoder = new TextDecoder();
		let buffer = "";
		let lastUsage: DSUsage | undefined;

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				// Line splitting / data-line classification are the pure
				// splitSseLines / parseSseData in sse.ts (unit-pinned there:
				// "\n"-only splitting, exact "data: " prefix, exact [DONE],
				// only-JSON.parse-errors-are-malformed). The decoder keeps its
				// streaming state here — a multi-byte char split across chunks
				// must be decoded once, by one decoder.
				const { lines, rest } = splitSseLines(buffer + decoder.decode(value, { stream: true }));
				buffer = rest;

				for (const line of lines) {
					const data = parseSseData(line);
					if (data.kind === "not-data") {
						continue;
					}
					if (data.kind === "done") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						this.reportToolCalls(ctx, ctx.toolCalls.flush(/*throwOnInvalid*/ false), progress);
						// Defensive cache write: if no finish_reason was seen but reasoning
						// was streamed, still persist it. Idempotent — same fingerprint
						// just overwrites.
						this.persistReasoningForTurn(ctx);
						continue;
					}
					if (data.kind === "malformed") {
						// Log and skip; see parseSseData for why ONLY parse errors
						// take this path — errors from acting on a well-formed
						// chunk (e.g. clean finish with invalid tool-call JSON)
						// must propagate up so the host sees the failed turn
						// instead of a silently-dropped tool call.
						this.log("sse.parse_error", { snippet: data.snippet, err: data.error });
						continue;
					}
					// DS sends a final chunk with `usage` populated when
					// stream_options.include_usage=true. Captured before — and
					// independently of — delta dispatch (the usage chunk has an
					// EMPTY choices array) so token counts always reach the
					// post-stream accounting.
					if (data.usage) {
						lastUsage = data.usage;
					}
					await this.processDelta(ctx, data.parsed, progress);
				}
			}
		} finally {
			cancelSub.dispose();
			reader.releaseLock();
			// Best-effort cache write for ABNORMAL exits: user cancellation
			// breaks the read loop before any finish_reason/[DONE], and a
			// mid-stream throw (e.g. flushToolCallBuffers rejecting invalid
			// tool-call JSON) propagates before the normal persist call. In
			// both cases the host may keep the partially-streamed assistant
			// turn in chat history — and any history turn missing from the
			// reasoning cache is a guaranteed fingerprint miss (and a broken
			// server prompt-cache prefix) on EVERY later request in the
			// conversation (issue #19). The fingerprint is computed over
			// ctx.emittedText/emittedToolCalls, i.e. exactly what was already
			// reported to the host, so partial turns key correctly.
			// Idempotent: clean finish paths already persisted and reset
			// ctx.reasoning, making this a no-op for normal exits. Wrapped so
			// a failure here can never mask an in-flight exception from the
			// try block (finally-throw would replace it).
			try {
				this.persistReasoningForTurn(ctx);
			} catch (e) {
				// persistReasoningForTurn writes to the output channel, so
				// the most plausible throw is a disposed channel during
				// shutdown — in which case this.log would throw again and
				// clobber the in-flight exception. Swallow-log defensively.
				try {
					this.log("cache.persist_failed", {
						error: e instanceof Error ? e.message : String(e),
					});
				} catch {
					// Output channel disposed mid-shutdown; nothing to do.
				}
			}
		}
		return lastUsage;
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * Field extraction and tool-call assembly are the pure `extractDelta` /
	 * `ToolCallAssembler` in sse.ts; everything that touches the host
	 * (progress parts, ThinkingPart reflection, config reads, dialogs,
	 * reasoning accumulation) stays here.
	 * @param ctx Per-call stream state.
	 * @param delta Parsed SSE chunk from the Router.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		ctx: StreamContext,
		delta: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		const events = extractDelta(delta);
		if (!events) {
			return;
		}

		// DeepSeek streams chain-of-thought as `reasoning_content` interleaved
		// with `content`. We always accumulate it into the per-turn buffer so
		// the cache write at finish-time can round-trip it on the next turn.
		// We also try to surface it to the UI: prefer the proposed
		// LanguageModelThinkingPart via reflection; fall back to a one-shot
		// "💭 Thinking..." text hint if the API isn't available.
		// Either way, the raw reasoning is mirrored live to the OutputChannel
		// so you can watch the model think in real time.
		const reasoningChunk = events.reasoning;
		if (reasoningChunk !== undefined) {
			const logRawReasoning = vscode.workspace.getConfiguration("deepseekv4").get<boolean>("logRawReasoning", false);
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
				} catch (e) {
					console.error("[DeepSeek V4] ThinkingPart emit failed", e);
				}
			} else if (!ctx.hasShownThinkingHint) {
				progress.report(new vscode.LanguageModelTextPart(THINKING_FALLBACK_HINT));
				ctx.hasShownThinkingHint = true;
			}
		}

		if (events.content !== undefined) {
			progress.report(new vscode.LanguageModelTextPart(events.content));
		}

		if (events.toolCallDeltas) {
			// Assembly semantics (index dedup, early emit once JSON args are
			// valid) live in ToolCallAssembler — sse.ts. Emit whatever this
			// chunk completed, in order.
			this.reportToolCalls(ctx, ctx.toolCalls.add(events.toolCallDeltas), progress);
		}

		const finish = events.finishReason;
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
						"Show Log"
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
			this.reportToolCalls(ctx, ctx.toolCalls.flush(/*throwOnInvalid=*/ isCleanFinish(finish)), progress);
			this.persistReasoningForTurn(ctx);
		}
	}

	/**
	 * Report assembled tool calls to the host. The model echoes the wire
	 * alias; report the HOST name so VS Code's tool registry can dispatch
	 * (issue #20). Names not in the map (model hallucination) pass through
	 * unchanged — the same failure mode that existed before aliasing.
	 */
	private reportToolCalls(
		ctx: StreamContext,
		calls: readonly CompletedToolCall[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): void {
		for (const call of calls) {
			const hostName = ctx.wireNameToHost.get(call.name) ?? call.name;
			progress.report(new vscode.LanguageModelToolCallPart(call.id, hostName, call.args));
		}
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
		const logRawReasoning = vscode.workspace.getConfiguration("deepseekv4").get<boolean>("logRawReasoning", false);
		if (logRawReasoning) {
			this.outputChannel.appendLine("");
		}
		this.outputChannel.appendLine(
			`[${new Date().toISOString().slice(11, 23)}] thinking.end ▲ (${ctx.reasoning.length} chars)`
		);
		// Degenerate anchor: on hosts without LanguageModelThinkingPart the
		// hint is a real TextPart, so EVERY turn cancelled before its first
		// content/tool-call delta has emittedText === THINKING_FALLBACK_HINT.
		// Fingerprinting that constant would make unrelated cancelled turns
		// share one tx: key and overwrite each other's reasoning — attaching
		// the WRONG chain to a turn is worse than a clean miss. Treat it as
		// no anchor instead.
		const anchorText =
			ctx.emittedToolCalls.length === 0 && ctx.emittedText.trim() === THINKING_FALLBACK_HINT.trim()
				? ""
				: ctx.emittedText;
		const fp = fingerprintAssistantTurn({
			text: anchorText,
			toolCalls: ctx.emittedToolCalls,
		});
		if (!fp) {
			// No anchor (no keyable text emitted AND no tool calls). Can't
			// key this turn into the cache; drop the reasoning silently.
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
	 *
	 * `countStats=false` (auxiliary requests) performs the identical attach —
	 * the "" stub is required for every thinking request — but keeps the
	 * lookups out of the cache's hit/miss statistics; see ReasoningCache.get.
	 * The returned {hits, misses} always reflects THIS request regardless.
	 */
	private attachReasoningToHistory(messages: OpenAIChatMessage[], countStats = true): { hits: number; misses: number } {
		let hits = 0;
		let misses = 0;
		for (const msg of messages) {
			if (msg.role !== "assistant") {
				continue;
			}
			if (msg.reasoning_content) {
				continue;
			}
			// contentText flattens the (string | block-array) union; assistant
			// turns are always plain strings by construction, but the type is
			// shared with multimodal user turns since the Vision variants.
			const fp = fingerprintAssistantTurn({
				text: contentText(msg.content),
				toolCalls: (msg.tool_calls ?? []).map((tc) => ({
					id: tc.id,
					name: tc.function.name,
				})),
			});
			if (!fp) {
				continue;
			}
			const reasoning = this._reasoningCache.get(fp, countStats);
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
					contentLen: contentText(msg.content).length,
					cacheKeys: this._reasoningCache.keys(),
				});
			}
		}
		if (hits + misses > 0) {
			this.log("cache.attach", { hits, misses, total: hits + misses });
		}
		return { hits, misses };
	}
}
