/**
 * Pure types and helpers for the context-usage snapshot. Lives in its
 * own vscode-free file so unit tests can `import` from `out/context_usage.js`
 * via Node ESM without a VS Code mock — same pattern as
 * `cache_breakdown.ts` and `tool_names.ts`.
 *
 * The stateful wrapper (with vscode.EventEmitter for change notifications)
 * lives in `context_usage_service.ts` and uses the helpers below.
 *
 * Invariants enforced by the helpers:
 *   - `updateEstimate` must NEVER clobber API-reported values when the
 *     model didn't change. The API numbers reflect what the server
 *     actually counted for the last request; the estimate reflects
 *     what we *will* send next. Different requests, different
 *     authority — they shouldn't overwrite each other.
 *   - `usedTokens` prefers the API value; falls back to the local
 *     ESTIMATE TOTAL = estimatedMessageTokens + estimatedToolTokens.
 *     The API's prompt_tokens covers both messages and tool definitions,
 *     so the fallback must sum the two estimate buckets to be comparable.
 *   - A model-variant switch invalidates both prior estimate and prior
 *     API values (they described a different model's budget).
 */

export interface ContextUsageSnapshot {
	modelId: string;
	modelDisplayName: string;
	thinking: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;

	// Local estimate, both buckets. Populated once updateEstimate has been
	// called at least once this session.
	// NOTE: `estimatedMessageTokens` is the messages-only char-ratio estimate
	// (renamed from the old `estimatedPromptTokens`, which was misleading
	// because the API's `prompt_tokens` actually covers messages + tools).
	estimatedMessageTokens: number;
	estimatedToolTokens: number;

	// Authoritative API-reported values. Undefined before the first
	// streaming usage chunk lands.
	apiPromptTokens?: number;
	apiCompletionTokens?: number;
	apiCacheHitTokens?: number;
	apiCacheMissTokens?: number;
	apiReasoningTokens?: number;

	// Derived convenience field. `usedTokens` prefers API value and
	// falls back to the SUM of message + tool estimates (so it stays
	// comparable to the API's prompt_tokens which covers both).
	usedTokens: number;
	updatedAt: number;
}

/** Inputs to `updateEstimate`. Kept as a single object so future fields
 * can be added without breaking provider call sites. */
export interface EstimateInput {
	modelId: string;
	modelDisplayName: string;
	thinking: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	estimatedMessageTokens: number;
	estimatedToolTokens: number;
}

/** Inputs to `updateFromApi`. The model fields come along because the
 * snapshot must always describe a complete (model, usage) pair. */
export interface ApiUsageInput {
	modelId: string;
	modelDisplayName: string;
	thinking: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	apiPromptTokens: number;
	apiCompletionTokens: number;
	apiCacheHitTokens?: number;
	apiCacheMissTokens?: number;
	apiReasoningTokens?: number;
}

/**
 * Pure helper: build a snapshot from an estimate input. Exported for
 * unit testing — see test/unit_context_usage.mjs.
 */
export function snapshotFromEstimate(
	input: EstimateInput,
	previous: ContextUsageSnapshot | undefined,
	now: number
): ContextUsageSnapshot {
	// Preserve any API values we already have for this same model, since
	// they're still describing the previous turn's reality. Drop them if
	// the model changed — they'd be misleading.
	const sameModel = previous?.modelId === input.modelId;
	const apiPromptTokens = sameModel ? previous?.apiPromptTokens : undefined;
	const apiCompletionTokens = sameModel ? previous?.apiCompletionTokens : undefined;
	const apiCacheHitTokens = sameModel ? previous?.apiCacheHitTokens : undefined;
	const apiCacheMissTokens = sameModel ? previous?.apiCacheMissTokens : undefined;
	const apiReasoningTokens = sameModel ? previous?.apiReasoningTokens : undefined;

	// Estimate fallback: messages + tools, so the fallback total is
	// comparable to the API's prompt_tokens (which also covers both).
	const estimateTotal = input.estimatedMessageTokens + input.estimatedToolTokens;
	const usedTokens = apiPromptTokens ?? estimateTotal;

	return {
		modelId: input.modelId,
		modelDisplayName: input.modelDisplayName,
		thinking: input.thinking,
		maxInputTokens: input.maxInputTokens,
		maxOutputTokens: input.maxOutputTokens,
		estimatedMessageTokens: input.estimatedMessageTokens,
		estimatedToolTokens: input.estimatedToolTokens,
		apiPromptTokens,
		apiCompletionTokens,
		apiCacheHitTokens,
		apiCacheMissTokens,
		apiReasoningTokens,
		usedTokens,
		updatedAt: now,
	};
}

/**
 * Pure helper: build a snapshot from an API usage input. Drops the
 * stale estimate from `previous` if the model changed; otherwise
 * keeps it as a debugging breadcrumb.
 */
export function snapshotFromApi(
	input: ApiUsageInput,
	previous: ContextUsageSnapshot | undefined,
	now: number
): ContextUsageSnapshot {
	const sameModel = previous?.modelId === input.modelId;
	const estimatedMessageTokens = sameModel ? (previous?.estimatedMessageTokens ?? 0) : 0;
	const estimatedToolTokens = sameModel ? (previous?.estimatedToolTokens ?? 0) : 0;

	return {
		modelId: input.modelId,
		modelDisplayName: input.modelDisplayName,
		thinking: input.thinking,
		maxInputTokens: input.maxInputTokens,
		maxOutputTokens: input.maxOutputTokens,
		estimatedMessageTokens,
		estimatedToolTokens,
		apiPromptTokens: input.apiPromptTokens,
		apiCompletionTokens: input.apiCompletionTokens,
		apiCacheHitTokens: input.apiCacheHitTokens,
		apiCacheMissTokens: input.apiCacheMissTokens,
		apiReasoningTokens: input.apiReasoningTokens,
		usedTokens: input.apiPromptTokens,
		updatedAt: now,
	};
}
