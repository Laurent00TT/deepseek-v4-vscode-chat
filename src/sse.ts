/**
 * Pure (vscode-free) SSE protocol logic for the DeepSeek streaming response:
 * line splitting, data-line classification, delta normalization, and
 * incremental tool-call assembly. Extracted verbatim from
 * `processStreamingResponse` / `processDelta` / `tryEmitBufferedToolCall` /
 * `flushToolCallBuffers` in provider.ts so the highest-churn path in the
 * extension (issues #19, #20, the 0.3.x cancellation and error-scoping
 * fixes all landed here) finally has unit coverage — see test/unit_sse.mjs.
 *
 * What deliberately did NOT move (stays in provider.ts): the reader loop and
 * its TextDecoder streaming state, the cancellation→reader.cancel bridge,
 * every `progress.report` emission (TextPart / ThinkingPart reflection /
 * ToolCallPart), the wire→host tool-name mapping, reasoning accumulation and
 * `persistReasoningForTurn` (including the `finally`-path write), and all
 * dialogs/logging. Those are host-coupled seams whose exact ordering the
 * CHANGELOG documents; this module only decides WHAT a chunk means, never
 * what to do about it.
 *
 * Behavior pins worth naming (all covered by unit tests): lines split on
 * `"\n"` only (no `\r` stripping — a "spec-correct" SSE parser here would be
 * a silent protocol change); the data prefix is exactly `"data: "` (with the
 * space); `[DONE]` is matched exactly (no trim); ONLY JSON.parse failures
 * classify as malformed — downstream dispatch errors must propagate;
 * `usage` is captured from every chunk independently of `choices` (DeepSeek
 * sends the final usage chunk with an EMPTY choices array).
 */

import type { DSUsage } from "./types";

/**
 * Append a decoded chunk to the carry-over buffer and split into complete
 * lines. The last element (a possibly-empty partial line) is returned as
 * `rest` and must be fed back as the next call's buffer.
 */
export function splitSseLines(input: string): { lines: string[]; rest: string } {
	const lines = input.split("\n");
	const rest = lines.pop() || "";
	return { lines, rest };
}

/** Classification of one SSE line. */
export type SseData =
	| { kind: "not-data" }
	| { kind: "done" }
	| { kind: "malformed"; snippet: string; error: string }
	| { kind: "chunk"; parsed: Record<string, unknown>; usage?: DSUsage };

/**
 * Classify one line of the SSE stream.
 *
 * `usage` rides on the chunk result and is captured BEFORE any delta
 * dispatch decision: DeepSeek's final usage chunk (stream_options.
 * include_usage) arrives with an empty `choices` array, so tying usage to a
 * choice would drop it — and with it the entire post-stream accounting
 * block (EMA calibration, context indicator, cache-breakdown detection).
 */
export function parseSseData(line: string): SseData {
	if (!line.startsWith("data: ")) {
		return { kind: "not-data" };
	}
	const data = line.slice(6);
	if (data === "[DONE]") {
		return { kind: "done" };
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(data) as Record<string, unknown>;
	} catch (e) {
		// Malformed SSE line — the caller logs and skips. These come from DS
		// occasionally (keep-alive lines, server hiccups); continuing is safe
		// and matches the OpenAI SDK convention. Critically, ONLY parse
		// errors are classified malformed — any error from acting on a
		// well-formed chunk (e.g. clean finish with invalid tool-call JSON)
		// must propagate so the host sees the failed turn instead of a
		// silently-dropped tool call.
		return { kind: "malformed", snippet: data.slice(0, 200), error: e instanceof Error ? e.message : String(e) };
	}
	if (parsed.usage && typeof parsed.usage === "object") {
		return { kind: "chunk", parsed, usage: parsed.usage as DSUsage };
	}
	return { kind: "chunk", parsed };
}

/** Normalized view of one chunk's first choice. */
export interface DeltaEvents {
	/** Non-empty reasoning_content fragment, when present. */
	reasoning?: string;
	/** Non-empty visible-content fragment (String()-coerced), when present. */
	content?: string;
	/** Raw tool_calls delta array, to feed ToolCallAssembler.add. */
	toolCallDeltas?: Array<Record<string, unknown>>;
	/** finish_reason, when this chunk carries one. */
	finishReason?: string;
}

/**
 * Pluck the dispatchable events out of a parsed chunk. Returns undefined
 * when the chunk has no first choice (usage-only and keep-alive chunks).
 * Gating mirrors the historical dispatch exactly: reasoning must be a
 * non-empty string; content must be truthy before AND non-empty after
 * String() coercion; tool_calls passes through on truthiness alone.
 */
export function extractDelta(parsed: Record<string, unknown>): DeltaEvents | undefined {
	const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
	if (!choice) {
		return undefined;
	}
	const deltaObj = choice.delta as Record<string, unknown> | undefined;
	const events: DeltaEvents = {};

	const reasoningChunk = deltaObj?.reasoning_content;
	if (typeof reasoningChunk === "string" && reasoningChunk.length > 0) {
		events.reasoning = reasoningChunk;
	}

	if (deltaObj?.content) {
		const content = String(deltaObj.content);
		if (content.length > 0) {
			events.content = content;
		}
	}

	if (deltaObj?.tool_calls) {
		events.toolCallDeltas = deltaObj.tool_calls as Array<Record<string, unknown>>;
	}

	const finish = (choice.finish_reason as string | undefined) ?? undefined;
	if (finish !== undefined) {
		events.finishReason = finish;
	}
	return events;
}

/**
 * Whether a finish_reason ends the stream cleanly. Only on a clean finish
 * do unparseable buffered tool calls become an error; on truncation
 * (length / content_filter / insufficient_system_resource) partial JSON is
 * expected and flushed best-effort.
 */
export function isCleanFinish(finish: string | undefined): boolean {
	return finish === "tool_calls" || finish === "stop";
}

/** A fully-assembled tool call, ready to report (wire name, unmapped). */
export interface CompletedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/**
 * Incremental tool-call assembly, keyed by `tool_calls.index`.
 *
 * Semantics (pinned by unit tests, inherited verbatim from the 0.3.x
 * provider):
 *   - a call completes EARLY, as soon as a name exists and the accumulated
 *     arguments parse as a JSON object — waiting for finish would look like
 *     a hang to the user;
 *   - once an index has completed, ALL later deltas for it are ignored
 *     (DeepSeek occasionally re-sends fragments);
 *   - `add` requires a name to complete; `flush` substitutes "unknown_tool"
 *     (the asymmetry is deliberate — mid-stream we can afford to wait for
 *     the name, at end-of-stream we can't);
 *   - `flush(throwOnInvalid=true)` (clean finish) throws on unparseable
 *     args; `flush(false)` ([DONE] / truncation) drops them silently;
 *   - a missing id is replaced with `call_<random>` at completion time.
 */
export class ToolCallAssembler {
	private readonly buffers = new Map<number, { id?: string; name?: string; args: string }>();
	private readonly completedIndices = new Set<number>();

	/** Apply one chunk's tool_calls deltas; returns calls completed by it. */
	add(deltas: Array<Record<string, unknown>>): CompletedToolCall[] {
		const completed: CompletedToolCall[] = [];
		for (const tc of deltas) {
			const idx = (tc.index as number) ?? 0;
			// Ignore any further deltas for an index we've already completed
			if (this.completedIndices.has(idx)) {
				continue;
			}
			const buf = this.buffers.get(idx) ?? { args: "" };
			if (tc.id && typeof tc.id === "string") {
				buf.id = tc.id;
			}
			const func = tc.function as Record<string, unknown> | undefined;
			if (func?.name && typeof func.name === "string") {
				buf.name = func.name;
			}
			if (typeof func?.arguments === "string") {
				buf.args += func.arguments;
			}
			this.buffers.set(idx, buf);

			// Complete immediately once arguments become valid JSON to avoid
			// perceived hanging
			if (!buf.name) {
				continue;
			}
			const canParse = tryParseJSONObject(buf.args);
			if (!canParse.ok) {
				continue;
			}
			completed.push({
				id: buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
				name: buf.name,
				args: canParse.value,
			});
			this.buffers.delete(idx);
			this.completedIndices.add(idx);
		}
		return completed;
	}

	/** Flush all remaining buffers; see class doc for the throw semantics. */
	flush(throwOnInvalid: boolean): CompletedToolCall[] {
		if (this.buffers.size === 0) {
			return [];
		}
		const completed: CompletedToolCall[] = [];
		for (const [idx, buf] of Array.from(this.buffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[DeepSeek V4] Invalid JSON for tool call", { idx, snippet: (buf.args || "").slice(0, 200) });
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			completed.push({
				id: buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
				name: buf.name ?? "unknown_tool",
				args: parsed.value,
			});
			this.buffers.delete(idx);
			this.completedIndices.add(idx);
		}
		return completed;
	}
}

/**
 * Try to parse a JSON object from a string. (Moved from utils.ts — its only
 * consumers are the assembler paths above, and utils.ts imports `vscode`,
 * which would drag the host module into this file's unit-test import chain.)
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}
