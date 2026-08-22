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

/** Text block of a multimodal content array. */
export interface OpenAITextContentPart {
	type: "text";
	text: string;
}

/**
 * Image block of a multimodal content array. The Vision API accepts a
 * `data:` URL (base64) or an external https URL; this extension always
 * sends `data:` URLs built from the attachment bytes VS Code hands us.
 */
export interface OpenAIImageContentPart {
	type: "image_url";
	image_url: { url: string };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/**
 * OpenAI-style chat message. `reasoning_content` is the DeepSeek extension that
 * carries the assistant's chain-of-thought; it must be passed back when the
 * assistant turn contained tool_calls.
 *
 * `content` is a plain string for text-only messages (every message before
 * the Vision variants existed) and a block array only for user messages
 * that carry images to a vision-capable model — the string shape is kept
 * wherever possible so text-only requests are byte-identical to previous
 * versions (server prompt-cache prefix stability).
 */
export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string | OpenAIContentPart[];
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
	apiModel: "deepseek-v4-pro" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp";
	thinking: boolean;
	/**
	 * Whether the variant accepts image input (multimodal). Drives the
	 * `capabilities.imageInput` flag in the model picker and gates the
	 * image-block conversion in convertMessages.
	 */
	vision?: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
}
