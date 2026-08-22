/**
 * Pure helper: detect prompt-cache breakdown caused by local
 * reasoning_cache misses. Lives in its own file (zero vscode dependency)
 * so the unit test can import it via Node ESM without mocking VS Code.
 *
 * Causal chain: reasoning_cache miss → empty reasoning_content stub →
 * broken prefix → server prompt cache collapses on this turn.
 *
 * We gate on `reasoningMissesThisTurn > 0` rather than raw hit-rate
 * delta — model switches, tool-list changes, and host history trim all
 * legitimately drop the hit rate but aren't actionable bugs and
 * shouldn't pop a warning. The peakHitRate gate excludes users whose
 * cache never worked in the first place.
 *
 * NOTE: the caller must only feed REAL conversation turns into this
 * check (see isReportableContextRequest in request_kind.ts). Copilot's
 * auxiliary requests (chat-title, summarization, …) legitimately score
 * ~0% hit rate with fingerprint misses and would fire false positives
 * against a peak set by the main conversation (issue #19).
 */
export function shouldWarnCacheBreakdown(
	currHitRate: number,
	peakHitRate: number,
	reasoningMissesThisTurn: number,
	lastWarnTime: number | undefined
): boolean {
	if (lastWarnTime && Date.now() - lastWarnTime < 5 * 60_000) {
		return false;
	}
	if (reasoningMissesThisTurn === 0) {
		return false;
	}
	if (peakHitRate < 0.7) {
		return false;
	}
	if (currHitRate > 0.2) {
		return false;
	}
	return true;
}
