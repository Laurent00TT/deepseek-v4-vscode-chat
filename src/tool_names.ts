/**
 * Tool-name sanitization and validation. Pure (zero vscode dependency)
 * so unit tests can import it via Node ESM without a VS Code mock.
 *
 * DeepSeek's OpenAI-compatible tool-call protocol echoes the tool name
 * back verbatim in the streaming response. If we ever rewrite a name
 * before sending it (e.g. `weather.get` → `weather_get`), the echo
 * won't match VS Code's host tool registry and the call routes nowhere.
 *
 * `sanitizeFunctionName` produces a name that satisfies DeepSeek's
 * naming rules; `isValidToolName` returns true iff sanitization is a
 * no-op on the input, which is the strict pre-condition we enforce at
 * the API boundary in `validateTools`.
 */

export function sanitizeFunctionName(name: unknown): string {
	if (typeof name !== "string" || !name) {
		return "tool";
	}
	let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!/^[a-zA-Z]/.test(sanitized)) {
		sanitized = `tool_${sanitized}`;
	}
	sanitized = sanitized.replace(/_+/g, "_");
	return sanitized.slice(0, 64);
}

/**
 * A tool name is valid iff `sanitizeFunctionName` is a no-op on it. This
 * catches every case where the prior weaker regex (`^[\w-]+$`) would let
 * a name through but `sanitizeFunctionName` would still rewrite it, e.g.:
 *   - leading digit `1tool` → `tool_1tool`
 *   - leading underscore `_private` → `tool_private`
 *   - consecutive underscores `foo__bar` → `foo_bar`
 *   - length > 64 → truncated
 */
export function isValidToolName(name: unknown): boolean {
	return typeof name === "string" && name.length > 0 && sanitizeFunctionName(name) === name;
}
