/**
 * Pure cap for the 128-tools-per-request budget. Extracted from provider.ts
 * so the boundary is vscode-free and unit-testable without a vscode mock
 * (same pattern as tool_choice.ts).
 *
 * 128 is a compatibility budget, not a verified server maximum: DeepSeek's
 * API reference said "A max of 128 functions are supported" (as of 2025-08)
 * but now only requires unique names, and VS Code's own BYOK proxy caps at
 * 128 too. Raise it only after checking the live API.
 *
 * The cap applies to the ADVERTISED (wire) tool set — what buildToolPayload
 * actually broadcasts to the API — not the raw host list. Since the issue #20
 * wire-aliasing fix, assembly may skip unusable or colliding tools, so a
 * host list slightly over 128 can still yield a legal request. Counting the
 * host list would trim tools that never reach the wire anyway.
 *
 * Over the cap the request is TRIMMED, not failed (issue #27). Hosts don't
 * all enforce the limit before calling the provider — VS Code 1.140's agent
 * host forwarded every tool to BYOK models — and a thrown error there came
 * back as a retried 502, so a user with many MCP / extension tools could not
 * chat at all. The policy matches VS Code's own BYOK cap (`capBridgeTools`,
 * 1.141+): tools the conversation already called are kept first, the rest of
 * the budget follows the host's order (built-in tools first), and the kept
 * tools stay in their original order so the request prefix — and DeepSeek's
 * prompt cache — is stable across turns.
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
 * Trim the advertised tool set to the API cap.
 * @param advertised The tool defs buildToolPayload produced; undefined when
 *   the request advertises no tools (always legal).
 * @param calledWireNames Wire names of tools the conversation history has
 *   already called; these are kept ahead of the host order.
 * @returns The defs to send (`advertised` itself when within the cap) and
 *   the wire names left out, in advertised order.
 */
export function capAdvertisedTools(
	advertised: OpenAIFunctionToolDef[] | undefined,
	calledWireNames: ReadonlySet<string>
): { tools: OpenAIFunctionToolDef[] | undefined; dropped: string[] } {
	if (!advertised || advertised.length <= MAX_TOOLS_PER_REQUEST) {
		return { tools: advertised, dropped: [] };
	}
	const kept = new Set<OpenAIFunctionToolDef>();
	for (const t of advertised) {
		if (kept.size < MAX_TOOLS_PER_REQUEST && calledWireNames.has(t.function.name)) {
			kept.add(t);
		}
	}
	for (const t of advertised) {
		if (kept.size >= MAX_TOOLS_PER_REQUEST) {
			break;
		}
		kept.add(t);
	}
	return {
		tools: advertised.filter((t) => kept.has(t)),
		dropped: advertised.filter((t) => !kept.has(t)).map((t) => t.function.name),
	};
}
