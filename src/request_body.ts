/**
 * Pure (vscode-free) assembly of the /chat/completions request body.
 *
 * Moved verbatim from `provideLanguageModelChatResponse` so the byte layout
 * of the serialized request is pinned by a golden test
 * (test/unit_request_body.mjs). This is the load-bearing invariant of the
 * whole extension: DeepSeek's server prompt cache keys on the request
 * prefix, and the local reasoning-cache fingerprints are computed over the
 * same converted messages — so ANY drift here (a reordered key, an
 * `undefined` that starts serializing, a number that changes shape) silently
 * breaks prompt-cache hit rates for every user. `JSON.stringify` emits keys
 * in insertion order; the insertion order below is therefore part of the
 * wire contract and must not be "tidied".
 *
 * Same vscode-free extraction pattern as tool_payload.ts / image_content.ts:
 * the provider reads VS Code config/options and passes plain values in.
 */

import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "./types";
import type { ToolChoice } from "./tool_choice";

/**
 * Coerce the raw `deepseekv4.reasoningEffort` setting value. The settings UI
 * constrains it to "high" | "max", but a hand-edited settings.json could
 * contain anything — unknown values become "max" rather than being passed
 * through to the API.
 */
export function coerceReasoningEffort(raw: string | undefined): "high" | "max" {
	return raw === "high" ? "high" : "max";
}

export interface RequestBodyInputs {
	/** Wire model name (variant.apiModel). */
	apiModel: string;
	/** Converted history, already reasoning-attached/stripped by the caller. */
	messages: OpenAIChatMessage[];
	/** Whether the selected variant runs in thinking mode. */
	thinking: boolean;
	/** Coerced effort — only sent when `thinking` is true. */
	reasoningEffort: "high" | "max";
	/** The variant's output ceiling; the host's max_tokens hint is capped to it. */
	maxOutputTokens: number;
	/** Raw host model options (max_tokens hint, temperature, stop, penalties). */
	modelOptions?: Record<string, unknown>;
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: ToolChoice;
}

/**
 * Build the request body object. Key insertion order (= serialization order):
 * model, messages, stream, stream_options, max_tokens, thinking, then
 * reasoning_effort (thinking) or temperature (non-thinking), then the
 * non-thinking allow-list (stop, frequency_penalty, presence_penalty), then
 * tools, tool_choice.
 */
export function buildRequestBody(inputs: RequestBodyInputs): Record<string, unknown> {
	// When the host supplies a max_tokens hint we honour it (capped to
	// the variant's ceiling). When it doesn't, we hand the model the
	// full configured budget — important for thinking-max so the
	// reasoning chain isn't silently truncated.
	const requestedMaxTokens = inputs.modelOptions?.max_tokens;
	const maxTokens =
		typeof requestedMaxTokens === "number" && requestedMaxTokens > 0
			? Math.min(requestedMaxTokens, inputs.maxOutputTokens)
			: inputs.maxOutputTokens;

	const requestBody: Record<string, unknown> = {
		model: inputs.apiModel,
		messages: inputs.messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens,
		thinking: { type: inputs.thinking ? "enabled" : "disabled" },
	};

	if (inputs.thinking) {
		requestBody.reasoning_effort = inputs.reasoningEffort;
		// Per DeepSeek docs: temperature/top_p/penalty params are ignored
		// in thinking mode. We omit them to keep the request body honest.
	} else {
		requestBody.temperature = inputs.modelOptions?.temperature ?? 0.7;
	}

	// Allow-list non-thinking-mode tuning options
	if (inputs.modelOptions && !inputs.thinking) {
		const mo = inputs.modelOptions;
		if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
			requestBody.stop = mo.stop;
		}
		if (typeof mo.frequency_penalty === "number") {
			requestBody.frequency_penalty = mo.frequency_penalty;
		}
		if (typeof mo.presence_penalty === "number") {
			requestBody.presence_penalty = mo.presence_penalty;
		}
	}

	if (inputs.tools) {
		requestBody.tools = inputs.tools;
	}
	if (inputs.tool_choice) {
		requestBody.tool_choice = inputs.tool_choice;
	}
	return requestBody;
}
