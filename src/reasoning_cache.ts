import { createHash } from "node:crypto";

export interface CachedTurn {
	fingerprint: string;
	reasoning: string;
}

/** Snapshot returned by ReasoningCache.stats() for diagnostic commands. */
export interface ReasoningCacheStats {
	entryCount: number;
	maxEntries: number;
	totalBytes: number;
	largestEntryBytes: number;
	largestEntryFp: string;
	maxObservedEntryBytes: number;
	maxObservedEntryFp: string;
	entrySizeWarnBytes: number;
	totalBytesWarn: number;
	totalBytesMax: number;
	totalSets: number;
	totalGets: number;
	totalHits: number;
	totalMisses: number;
	totalEvictions: number;
	hitRate: number; // 0..1
}

/**
 * LRU cache keyed by an assistant-turn fingerprint, used to round-trip
 * DeepSeek's `reasoning_content` across turns. DeepSeek requires the
 * reasoning_content of a prior assistant turn (one that contained tool
 * calls) to be passed back in the next request, otherwise the API
 * returns 400. VS Code's chat API has no place for this field, so we
 * stash it here when streaming the turn out, and re-attach it when
 * converting history for the next request.
 */
export class ReasoningCache {
	private buffer: CachedTurn[] = [];
	private onChange?: () => void;

	// Statistics for diagnostics
	private _totalSets = 0;
	private _totalGets = 0;
	private _totalHits = 0;
	private _totalMisses = 0;
	private _totalEvictions = 0;
	private _maxObservedEntrySize = 0;
	private _maxObservedEntryFp = "";

	/** Running total of all reasoning_content bytes in the buffer.
	 * Maintained incrementally so stats() is O(1) and size-check eviction
	 * doesn't need to re-scan the buffer on every set(). */
	private _totalBytes = 0;

	/** Per-entry size cap in bytes. Entries above this trigger a log warning
	 * but are NOT truncated — truncation could cause the API to reject the
	 * reasoning_content, and there is no evidence it validates length.
	 * Default 192 KB is generous even for max-effort chains. */
	static readonly ENTRY_SIZE_WARN_BYTES = 192 * 1024;

	/** Soft warning threshold for total cache bytes. When the serialized
	 * cache exceeds this, persistence to globalState may become slow or
	 * hit undocumented VS Code limits. Logged but no eviction triggered. */
	static readonly TOTAL_BYTES_WARN = 5 * 1024 * 1024; // 5 MB

	/** Hard cap on total cache bytes. When exceeded, the OLDEST entries
	 * (same eviction order as the count-based LRU) are removed until the
	 * total drops below this threshold. This is safe because:
	 *   - It evicts from the front (oldest), same as count-based LRU
	 *   - It never evicts recently-used entries (back of buffer)
	 *   - Active conversation entries are always at the back
	 * Set generously at 20 MB — well below VS Code's ~100 MB globalState
	 * limit but high enough that normal usage never triggers it. */
	static readonly MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB

	constructor(private readonly maxSize = 512) {}

	/** Subscribe to cache mutations (used to trigger persistence). */
	setOnChange(cb: () => void): void {
		this.onChange = cb;
	}

	set(fingerprint: string, reasoning: string): void {
		if (!reasoning || !fingerprint) {
			return;
		}
		this._totalSets++;

		// Track max observed entry size for diagnostics
		const byteLen = Buffer.byteLength(reasoning, "utf8");
		if (byteLen > this._maxObservedEntrySize) {
			this._maxObservedEntrySize = byteLen;
			this._maxObservedEntryFp = fingerprint;
		}
		if (byteLen > ReasoningCache.ENTRY_SIZE_WARN_BYTES) {
			// Logged via the onChange callback's owner (provider), not here —
			// the cache itself has no logger. The warning is surfaced through
			// the stats command instead.
		}

		// Replace existing entry for same fingerprint (update in place)
		const idx = this.buffer.findIndex((e) => e.fingerprint === fingerprint);
		if (idx !== -1) {
			const old = this.buffer.splice(idx, 1)[0];
			this._totalBytes -= Buffer.byteLength(old.reasoning, "utf8");
		}
		this.buffer.push({ fingerprint, reasoning });
		this._totalBytes += byteLen;

		// Evict OLDEST entries until under BOTH the count limit AND the byte
		// limit. Always evicts from the front (oldest), preserving recently-
		// used (back) entries — same semantics as count-only LRU.
		while (this.buffer.length > this.maxSize || this._totalBytes > ReasoningCache.MAX_TOTAL_BYTES) {
			const evicted = this.buffer.shift()!;
			this._totalBytes -= Buffer.byteLength(evicted.reasoning, "utf8");
			this._totalEvictions++;
		}
		this.onChange?.();
	}

	get(fingerprint: string): string | undefined {
		if (!fingerprint) {
			return undefined;
		}
		this._totalGets++;
		const idx = this.buffer.findIndex((e) => e.fingerprint === fingerprint);
		if (idx === -1) {
			this._totalMisses++;
			return undefined;
		}
		this._totalHits++;
		// LRU bump: move to end. Total bytes unchanged since we splice+push
		// the same entry — no need to adjust _totalBytes.
		const entry = this.buffer.splice(idx, 1)[0];
		this.buffer.push(entry);
		return entry.reasoning;
	}

	size(): number {
		return this.buffer.length;
	}

	/** Diagnostic: list current keys in eviction order (oldest first). */
	keys(): string[] {
		return this.buffer.map((e) => e.fingerprint);
	}

	/** Cache health statistics for diagnostic commands. */
	stats(): ReasoningCacheStats {
		let largestEntryBytes = 0;
		let largestEntryFp = "";
		for (const e of this.buffer) {
			const len = Buffer.byteLength(e.reasoning, "utf8");
			if (len > largestEntryBytes) {
				largestEntryBytes = len;
				largestEntryFp = e.fingerprint;
			}
		}
		return {
			entryCount: this.buffer.length,
			maxEntries: this.maxSize,
			totalBytes: this._totalBytes,
			largestEntryBytes,
			largestEntryFp,
			maxObservedEntryBytes: this._maxObservedEntrySize,
			maxObservedEntryFp: this._maxObservedEntryFp,
			entrySizeWarnBytes: ReasoningCache.ENTRY_SIZE_WARN_BYTES,
			totalBytesWarn: ReasoningCache.TOTAL_BYTES_WARN,
			totalBytesMax: ReasoningCache.MAX_TOTAL_BYTES,
			totalSets: this._totalSets,
			totalGets: this._totalGets,
			totalHits: this._totalHits,
			totalMisses: this._totalMisses,
			totalEvictions: this._totalEvictions,
			hitRate: this._totalGets > 0 ? this._totalHits / this._totalGets : 0,
		};
	}

	/** Snapshot for persistence. Order is preserved (oldest first). */
	serialize(): CachedTurn[] {
		return this.buffer.map((e) => ({ ...e }));
	}

	/** Restore from a previously-serialized snapshot. Truncates to maxSize.
	 * Also enforces MAX_TOTAL_BYTES on restore — evicts oldest if needed. */
	restore(entries: CachedTurn[]): void {
		const valid = entries.filter(
			(e) => e && typeof e.fingerprint === "string" && typeof e.reasoning === "string"
		);
		this.buffer = valid.slice(-this.maxSize);
		// Rebuild byte counter from restored entries
		this._totalBytes = 0;
		for (const e of this.buffer) {
			this._totalBytes += Buffer.byteLength(e.reasoning, "utf8");
		}
		// Enforce byte limit on restore (evict oldest if needed)
		while (this._totalBytes > ReasoningCache.MAX_TOTAL_BYTES && this.buffer.length > 0) {
			const evicted = this.buffer.shift()!;
			this._totalBytes -= Buffer.byteLength(evicted.reasoning, "utf8");
			this._totalEvictions++;
		}
	}
}

export interface AssistantTurnFingerprintInput {
	text: string;
	toolCalls: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Deterministic fingerprint for an assistant turn. Strategy:
 *   - If there are tool_calls: use sorted `name:id` pairs. DeepSeek-issued
 *     tool_call ids are stable strings that VS Code preserves verbatim
 *     across history reads, making this the strongest anchor.
 *   - Otherwise: hash the visible text content (whitespace-normalized,
 *     Unicode NFKC-normalized). NFKC ensures that semantically identical
 *     characters with different Unicode representations (e.g. composed
 *     vs. decomposed forms like "é" vs "e\u0301") produce the same hash.
 *     Defense in depth: integration tests show DS requires
 *     reasoning_content on every prior assistant turn (text or tc) once
 *     the conversation history contains any assistant.tool_calls turn.
 *     With no tool_calls in history, the text hash is unused but harmless
 *     — DS accepts redundant reasoning_content without complaint.
 *
 * Prefixes ("tc:" / "tx:") prevent collision between an empty no-text
 * turn and a tool-call turn that happened to hash to the same bytes.
 *
 * Returns "" only if BOTH text and toolCalls are empty — that turn
 * cannot be keyed and the caller should skip caching it.
 */
export function fingerprintAssistantTurn(input: AssistantTurnFingerprintInput): string {
	if (input.toolCalls.length > 0) {
		const tcKeys = input.toolCalls
			.map((tc) => `${tc.name}:${tc.id}`)
			.sort()
			.join("|");
		return "tc:" + createHash("sha256").update(tcKeys).digest("hex").slice(0, 16);
	}
	// Unicode NFKC normalization before whitespace collapse so that
	// composed/decomposed forms of the same glyph produce identical hashes.
	// Example: "\u00E9" (é) and "e\u0301" (e + combining acute) both
	// normalize to "\u00E9" under NFKC.
	const norm = input.text
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim();
	if (!norm) {
		return "";
	}
	return "tx:" + createHash("sha256").update(norm).digest("hex").slice(0, 16);
}
