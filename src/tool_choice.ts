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
 */

export type ToolChoice =
	| "auto"
	| "required"
	| { type: "function"; function: { name: string } };

export function resolveToolChoice(
	requiredMode: boolean,
	toolCount: number,
	firstToolName: string | undefined,
): ToolChoice {
	if (!requiredMode) {
		return "auto";
	}
	if (toolCount === 1 && firstToolName) {
		return { type: "function", function: { name: firstToolName } };
	}
	return "required";
}
