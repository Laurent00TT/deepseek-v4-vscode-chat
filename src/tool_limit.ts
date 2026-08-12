/**
 * Pure guard for DeepSeek's 128-tools-per-request cap. Extracted from
 * provider.ts so the boundary is vscode-free and unit-testable without a
 * vscode mock (same pattern as tool_choice.ts).
 *
 * The cap applies to the ADVERTISED (wire) tool set — what buildToolPayload
 * actually broadcasts to the API — not the raw host list. Since the issue #20
 * wire-aliasing fix, assembly may skip unusable or colliding tools, so a
 * host list slightly over 128 can still yield a legal request. Counting the
 * host list would reject that request for a violation that never reaches the
 * wire.
 *
 * The parameter is the advertised def array itself, not a count: VS Code's
 * host tool shape ({name, description, inputSchema}) is structurally
 * incompatible with OpenAIFunctionToolDef, so feeding `options.tools` — or
 * any hand-computed number — is a COMPILE error, and the original bug can't
 * be reintroduced through this call. The type-only import keeps the compiled
 * module dependency-free for the Node unit harness.
 */

import type { OpenAIFunctionToolDef } from "./types";

export const MAX_TOOLS_PER_REQUEST = 128;

/**
 * Throw when the advertised tool set exceeds the API cap.
 * @param advertised The tool defs actually sent to the API; undefined when
 *   the request advertises no tools (always legal).
 */
export function assertAdvertisedToolLimit(advertised: readonly OpenAIFunctionToolDef[] | undefined): void {
	if ((advertised?.length ?? 0) > MAX_TOOLS_PER_REQUEST) {
		throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
	}
}
