/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/**
 * OpenAI-style chat message. `reasoning_content` is the DeepSeek extension that
 * carries the assistant's chain-of-thought; it must be passed back when the
 * assistant turn contained tool_calls.
 */
export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

/**
 * Streamed delta payload returned by DeepSeek /v1/chat/completions in stream mode.
 * `reasoning_content` arrives interleaved with `content`, both can be partial.
 */
export interface DeepSeekStreamDelta {
	role?: string;
	content?: string;
	reasoning_content?: string;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

/**
 * Buffer used to accumulate streamed tool call parts until arguments are valid JSON.
 */
export interface ToolCallBuffer {
	id?: string;
	name?: string;
	args: string;
}

/**
 * DeepSeek model variant published to the VS Code model picker.
 * `apiModel` is what we send in the OpenAI-compatible request body;
 * `thinking` controls whether to enable extended thinking mode.
 *
 * `reasoning_effort` is no longer a per-variant constant — it is read at
 * request time from the user setting `deepseekv4.reasoningEffort` (values
 * `"high"` | `"max"`, default `"max"`). The setting only takes effect for
 * variants where `thinking === true`.
 */
export interface DeepSeekModelVariant {
	id: string;
	displayName: string;
	tooltip: string;
	apiModel: "deepseek-v4-pro" | "deepseek-v4-flash";
	thinking: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
}
