/**
 * Model variants exposed to the VS Code model picker. Moved verbatim from
 * provider.ts (v0.4 series) — pure data, vscode-free, so future variant
 * additions touch a leaf module instead of the provider. The picker-info
 * assembly (ThemeIcon, secrets gating) deliberately stays in provider.ts:
 * it is host-coupled and moving it would buy no testability.
 *
 * DeepSeek V4 Pro and V4.1 Flash support 1M context and up to 384K output.
 * Think Max requires at least 384K of context allocated to the reasoning
 * chain to avoid silent truncation, so the thinking entries are configured
 * generously.
 *
 * Order matters — VS Code shows the first entry as default. The strongest
 * variant (pro + thinking-max) is intentionally listed first.
 */

import type { DeepSeekModelVariant } from "./types";

// DS V4 / V4.1's context window is 1M (input + output total). Max output is
// 384K (which subsumes the reasoning chain — `max_tokens` covers both the
// hidden reasoning_content and the visible content). Thinking variants
// budget the full 384K so max-effort reasoning chains can't be truncated.
// Non-thinking variants only emit visible content, so 64K is plenty.
//
// Input budgets are sized as `1M - output budget`:
//   - thinking variants:  1M - 384K = 640K → rounded down to 640K
//   - non-thinking:        1M - 64K = 960K → rounded down to 960K
// (We keep slightly conservative rounding to avoid edge-case overflows
// when the server's tokenizer disagrees with our estimator.)
//
// `reasoning_effort` is read from the `deepseekv4.reasoningEffort` user
// setting at request time, not stored on the variant.
//
// Listed strongest→cheapest; VS Code uses the first entry as the default.
export const MODEL_VARIANTS: DeepSeekModelVariant[] = [
	{
		id: "deepseek-v4-pro::thinking",
		displayName: "DeepSeek V4 Pro (thinking)",
		tooltip: "DeepSeek V4 Pro — strongest, extended thinking",
		apiModel: "deepseek-v4-pro",
		thinking: true,
		maxInputTokens: 655360, // 640K (= 1M - 384K output)
		maxOutputTokens: 393216, // 384K (covers reasoning chain + visible content)
	},
	{
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		tooltip: "DeepSeek V4 Pro — strong, no extended thinking, lower latency",
		apiModel: "deepseek-v4-pro",
		thinking: false,
		maxInputTokens: 983040, // 960K (= 1M - 64K output)
		maxOutputTokens: 65536, // 64K
	},
	// V4.1 Flash (released 2026-09-10) retired both V4 Flash and the V4 Flash
	// Vision Exp preview. Its API name `deepseek-flash` carries no version:
	// DeepSeek serves the latest Flash under it. The retired names
	// `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are only
	// temporarily routed to V4.1 Flash (no end date published), so nothing
	// here sends them any more.
	//
	// The picker ids keep their V4-era spelling on purpose — they are
	// user-persisted (CONTRIBUTING red line #2), so renaming them would
	// orphan every Flash user's picker selection.
	//
	// Image input is native (JPEG/PNG/GIF/WebP, sent as base64 data: URLs in
	// content blocks — see image_content.ts), which made the two Vision Exp
	// entries (0.4.0) the same model behind a second label; they were
	// dropped rather than kept as duplicates.
	{
		id: "deepseek-v4-flash::thinking",
		displayName: "DeepSeek V4.1 Flash (thinking)",
		tooltip: "DeepSeek V4.1 Flash — cheapest with extended thinking, image input",
		apiModel: "deepseek-flash",
		thinking: true,
		vision: true,
		maxInputTokens: 655360, // 640K (= 1M - 384K output)
		maxOutputTokens: 393216, // 384K
	},
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4.1 Flash",
		tooltip: "DeepSeek V4.1 Flash — cheapest, image input, no extended thinking",
		apiModel: "deepseek-flash",
		thinking: false,
		vision: true,
		maxInputTokens: 983040, // 960K (= 1M - 64K output)
		maxOutputTokens: 65536, // 64K
	},
];

export function findVariant(id: string): DeepSeekModelVariant | undefined {
	return MODEL_VARIANTS.find((v) => v.id === id);
}
