/**
 * Pure resolver for DeepSeek/OpenAI `tool_choice` from VS Code's
 * `LanguageModelChatToolMode` semantic. Extracted from convertTools so
 * the decision logic is vscode-free and unit-testable without a
 * vscode mock.
 *
 * Semantics:
 *   - `requiredMode === false` (i.e. Auto or undefined) → `"auto"`,
 *     model decides whether to call a tool.
 *   - `requiredMode === true` (VS Code's Required):
 *       * exactly one candidate tool → named-function force; equivalent
 *         to "you must call this specific tool".
 *       * multiple candidates → DeepSeek/OpenAI `"required"` literal;
 *         the model must call SOME tool but picks which one.
 *
 * The multi-tool path previously hard-threw, which broke valid agent
 * scenarios. See https://api-docs.deepseek.com/api/create-chat-completion
 * (tool_choice).
 *
 * This is the caller's intent. Whether the API accepts it depends on the
 * thinking mode — see `fitToolChoiceToThinking` below, which the provider
 * applies before the body is built.
 */

export type ToolChoice = "auto" | "required" | { type: "function"; function: { name: string } };

export function resolveToolChoice(
	requiredMode: boolean,
	toolCount: number,
	firstToolName: string | undefined
): ToolChoice {
	if (!requiredMode) {
		return "auto";
	}
	if (toolCount === 1 && firstToolName) {
		return { type: "function", function: { name: firstToolName } };
	}
	return "required";
}

/**
 * Fit a resolved tool_choice to the request's thinking mode.
 *
 * DeepSeek's thinking mode rejects every forced tool_choice: with
 * `thinking: {type: "enabled"}`, both `"required"` and a named function
 * return 400 "Thinking mode does not support this tool_choice", while
 * `"auto"` and `"none"` are accepted — and with thinking disabled all four
 * are (live, 2026-10-11, `deepseek-flash` and `deepseek-v4-pro`). VS Code's
 * Required tool mode therefore cannot be honoured on a thinking variant:
 * the forced choice is relaxed to `"auto"`. The model sees the same tools
 * and the same history, but is no longer guaranteed to call one.
 *
 * The alternative — running that request with thinking disabled — would
 * keep the guarantee but costs more than it saves: the non-thinking path
 * strips every prior turn's reasoning_content, so the request diverges from
 * the prefix the conversation's server prompt cache holds; the forced turn
 * streams no reasoning to cache, so every later request misses it (and the
 * miss arms the cache-breakdown warning); and the model the user picked is
 * silently swapped for one request.
 *
 * Every other combination passes through by identity, so only the request
 * that used to fail changes on the wire: it now serializes exactly like the
 * same request in Auto mode.
 *
 * @returns The tool_choice to send, plus `relaxedFrom` — the forced choice
 *   that was replaced — when a relaxation happened, for the caller to log.
 */
export function fitToolChoiceToThinking(
	choice: ToolChoice | undefined,
	thinking: boolean
): { tool_choice: ToolChoice | undefined; relaxedFrom?: ToolChoice } {
	// Spelled out rather than `!== "auto"`, so a value thinking mode does
	// accept ("none") would pass through if it ever joins ToolChoice.
	const forced = choice === "required" || typeof choice === "object";
	if (!thinking || !forced) {
		return { tool_choice: choice };
	}
	return { tool_choice: "auto", relaxedFrom: choice };
}
