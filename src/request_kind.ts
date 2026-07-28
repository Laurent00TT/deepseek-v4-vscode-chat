/**
 * Classify an incoming Copilot Chat request by its system-prompt prefix so we
 * can tell a real conversation turn from the many AUXILIARY requests Copilot
 * routes through the selected model — chat-title generation, progress
 * messages, todo tracking, prompt categorization, git branch/commit messages,
 * rename suggestions, conversation summarization (compaction), etc.
 *
 * Why this matters (issue #17): we report token usage to Copilot's NATIVE
 * context-window indicator (see the `usage` data part in provider.ts). Copilot
 * fires those auxiliary requests through the model too — notably a `chat-title`
 * request right after the FIRST turn — and each carries only a few hundred
 * tokens. If we reported their usage, they'd clobber the indicator, resetting
 * the displayed context to ~0% even though the real conversation is large. So
 * we only report usage for the kinds that represent the real conversation
 * (`main-agent` and the `background` catch-all, which covers ordinary ask-mode
 * turns).
 *
 * The prefix list mirrors the upstream Vizards/deepseek-v4-for-copilot
 * classifier. Pure (vscode-free) so it is unit-testable — see
 * test/unit_request_kind.mjs.
 */

export type RequestKind =
	| "main-agent"
	| "terminal-steering"
	| "todo-tracker"
	| "prompt-categorizer"
	| "settings-resolver"
	| "chat-title"
	| "inline-progress-message"
	| "git-branch-name"
	| "git-commit-message"
	| "rename-suggestions"
	| "conversation-summarizer"
	| "background"
	| "unknown";

const TODO_TRACKER_PREFIX = "You are a background task tracker";
const PROMPT_CATEGORIZER_PREFIX = "You are an expert classifier for AI coding assistant prompts";
const SETTINGS_RESOLVER_PREFIX =
	"You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings";
const CHAT_TITLE_PREFIXES = [
	"You are an expert in crafting ultra-compact titles",
	"You are an expert in crafting pithy titles",
] as const;
const INLINE_PROGRESS_MESSAGE_PREFIX =
	"You are an expert in writing short, catchy, and encouraging progress messages";
const GIT_BRANCH_NAME_PREFIX = "You are an expert in crafting pithy branch names";
const GIT_COMMIT_MESSAGE_PREFIX =
	"You are an AI programming assistant, helping a software developer to come with the best git commit message";
const RENAME_SUGGESTIONS_PREFIX = "You are a distinguished software engineer";
/** Copilot's conversation-summarization (compaction) request. Verified against
 * microsoft/vscode-copilot-chat `summarizedConversationHistory.tsx`: both the
 * full and the "simple" summarization modes share one SystemMessage whose text
 * begins with this sentence. Summarization requests re-render the whole
 * conversation history, so their reasoning fingerprints systematically miss
 * and their prompt prefix is novel — they must never feed the cache-breakdown
 * warning or the context indicator (issue #19). */
const CONVERSATION_SUMMARIZER_PREFIX =
	"Your task is to create a comprehensive, detailed summary of the entire conversation";
const MAIN_AGENT_PREFIX = "You are an expert AI programming assistant";
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
	return prefixes.some((p) => text.startsWith(p));
}

function isOnlyTool(toolNames: readonly string[], toolName: string): boolean {
	return toolNames.length === 1 && toolNames[0] === toolName;
}

/**
 * Classify a request from its first message text (the system prompt), the
 * latest user message text, and the advertised tool names.
 */
export function classifyRequestKind(
	firstText: string,
	latestUserText: string,
	toolNames: readonly string[],
): RequestKind {
	const first = firstText.trimStart();
	const latest = latestUserText.trimStart();
	if (TERMINAL_NOTIFICATION_PATTERN.test(latest)) {
		return "terminal-steering";
	}
	if (isOnlyTool(toolNames, "manage_todo_list") || first.startsWith(TODO_TRACKER_PREFIX)) {
		return "todo-tracker";
	}
	if (isOnlyTool(toolNames, "categorize_prompt") || first.startsWith(PROMPT_CATEGORIZER_PREFIX)) {
		return "prompt-categorizer";
	}
	if (first.startsWith(SETTINGS_RESOLVER_PREFIX)) {
		return "settings-resolver";
	}
	if (startsWithAny(first, CHAT_TITLE_PREFIXES)) {
		return "chat-title";
	}
	if (first.startsWith(INLINE_PROGRESS_MESSAGE_PREFIX)) {
		return "inline-progress-message";
	}
	if (first.startsWith(GIT_BRANCH_NAME_PREFIX)) {
		return "git-branch-name";
	}
	if (first.startsWith(GIT_COMMIT_MESSAGE_PREFIX)) {
		return "git-commit-message";
	}
	if (first.startsWith(RENAME_SUGGESTIONS_PREFIX)) {
		return "rename-suggestions";
	}
	if (first.startsWith(CONVERSATION_SUMMARIZER_PREFIX)) {
		return "conversation-summarizer";
	}
	if (
		first.startsWith(MAIN_AGENT_PREFIX) ||
		first.includes("<skills>") ||
		first.includes("<agents>")
	) {
		return "main-agent";
	}
	if (toolNames.length > 0 || first.length > 0) {
		return "background";
	}
	return "unknown";
}

/**
 * Whether a request is a REAL conversation turn: `main-agent` (agent-mode
 * turns) and `background` (the catch-all that covers ordinary ask-mode chat).
 * Every recognised auxiliary kind — and the empty `unknown` — is excluded.
 *
 * Two consumers (both in provider.ts):
 *   - the native context-window indicator usage report (issue #17): auxiliary
 *     requests would reset the indicator with their tiny, non-conversational
 *     context;
 *   - the prompt-cache-breakdown statistics and warning (issue #19): auxiliary
 *     requests have a novel prompt prefix (legitimately ~0% server cache hit)
 *     and re-rendered history (fingerprint misses), so feeding them into the
 *     peak/current hit-rate comparison fired false "cache breakdown" popups.
 */
export function isReportableContextRequest(kind: RequestKind): boolean {
	return kind === "main-agent" || kind === "background";
}
