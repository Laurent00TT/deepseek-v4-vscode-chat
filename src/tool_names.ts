/**
 * Tool-name validation against the OpenAI / DeepSeek function-name spec:
 *
 *   "Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a
 *    maximum length of 64."
 *
 * Pure (zero vscode dependency) so unit tests can import it via Node ESM
 * without a VS Code mock.
 *
 * Earlier revisions of this file carried a `sanitizeFunctionName` helper
 * that added two over-defensive rules on top of the official spec —
 * forcing the first character to be a letter, and collapsing consecutive
 * underscores — both inherited from an upstream fork. When we tightened
 * `validateTools` to use that helper as an oracle, the result rejected
 * names like `1tool`, `_private`, and `foo__bar` that DeepSeek itself
 * accepts. We now anchor directly on the spec instead. See
 * https://api-docs.deepseek.com/api/create-chat-completion (tools.function.name).
 */

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidToolName(name: unknown): boolean {
	return typeof name === "string" && TOOL_NAME_RE.test(name);
}
