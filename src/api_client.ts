/**
 * Vscode-free HTTP layer for the DeepSeek API: endpoint constants, the
 * retrying fetch wrapper, and API-error rendering. Moved verbatim from
 * provider.ts (v0.4 series) so retry/backoff semantics can be unit-tested
 * with a monkey-patched global fetch.
 *
 * What deliberately did NOT move: `refreshBalance` (it interleaves the HTTP
 * call with session-anchor mutation, status-bar refresh, and notification
 * routing — no clean seam) and `notifyApiError` / the dialog surfaces
 * (vscode.window throughout). The exact user-facing error strings built by
 * `formatApiError` feed both thrown errors and those dialogs, so its text
 * must stay character-identical across moves.
 */

/** Snapshot of `/user/balance`. Refreshed only on user demand. */
export interface BalanceInfo {
	currency: string;
	totalBalance: number;
	grantedBalance: number;
	toppedUpBalance: number;
	fetchedAt: number;
}

export const BASE_URL = "https://api.deepseek.com/v1";
export const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Ceiling for an honored Retry-After. The server may ask for minutes; a
 * chat request stalled that long inside Copilot's UI (which shows nothing
 * until SSE flows) reads as a hang, so we cap what we're willing to wait. */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Backoff for retry attempt `attemptIndex` (0-based): exponential 1s → 2s,
 * raised to a 429/503 `Retry-After` header when the server sent one —
 * delay-seconds form only (the HTTP-date form is rare and malformed values
 * must never extend the wait), capped at MAX_RETRY_AFTER_MS.
 */
export function computeRetryDelay(attemptIndex: number, retryAfterHeader: string | null): number {
	const backoffMs = 1000 * Math.pow(2, attemptIndex);
	if (retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader.trim())) {
		const retryAfterMs = Number(retryAfterHeader.trim()) * 1000;
		return Math.min(Math.max(backoffMs, retryAfterMs), MAX_RETRY_AFTER_MS);
	}
	return backoffMs;
}

/**
 * setTimeout that loses the race to an abort signal: rejects with
 * AbortError immediately when the signal fires (or already fired). The
 * retry sleep must be abortable — a user's Cancel during a plain
 * `setTimeout` backoff would otherwise be ignored until the sleep ran out.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Fetch with retry on transient failures (network errors, 5xx, 429).
 * 4xx (except 429) are non-retryable client errors and bubble immediately.
 * Aborts (user cancel) bypass retry — including during a backoff sleep.
 *
 * Retries are bounded to attempts=3 with exponential backoff (1s, 2s); a
 * server-sent Retry-After can raise a sleep up to 10s (MAX_RETRY_AFTER_MS),
 * so the worst case adds ~3s normally and ~20s when the server explicitly
 * asks for it — still within Copilot's request timeout window.
 *
 * Resolution contract: 2xx and non-retryable 4xx responses are returned
 * immediately; a retryable status (429 / 5xx) on the LAST attempt is also
 * returned — un-drained, so the caller can read the body and map the status
 * (provider.ts surfaces the 429 toast / 5xx log from it). Only network
 * errors, timeouts and user aborts reject.
 *
 * A per-attempt timeout (default 5 min) prevents hangs. DeepSeek's thinking
 * mode with max effort can take 2–5 minutes for complex reasoning chains,
 * and the API itself gives up after 10 minutes of queuing, so 5 min is a
 * reasonable middle ground that avoids both premature cancellation and
 * indefinite hangs.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	logger: (msg: string, data?: unknown) => void,
	attempts = 3,
	timeoutMs = 300_000 // 5 min per attempt
): Promise<Response> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		if (signal.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		let retryAfterHeader: string | null = null;
		try {
			// Combine user cancel signal with per-attempt timeout.
			// AbortSignal.any() is available in Node 20+ / VS Code 1.104+.
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

			const res = await fetch(url, { ...init, signal: combinedSignal });
			// Non-retryable: 2xx success, 4xx client errors (except 429 rate limit)
			if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
				return res;
			}
			// Retryable: 5xx server errors, 429 rate limit
			retryAfterHeader = res.headers.get("retry-after");
			logger("retry", {
				attempt: i + 1,
				status: res.status,
				willRetry: i < attempts - 1,
				...(retryAfterHeader !== null ? { retryAfter: retryAfterHeader } : {}),
			});
			if (i === attempts - 1) {
				// Last attempt: hand the response back UN-DRAINED so the caller
				// can read the body and map the status like any other non-ok
				// response (provider.ts → formatApiError → notifyApiError: the
				// 429 toast, the 5xx log line). Throwing a synthetic
				// `HTTP <status>` error here used to make those branches
				// unreachable from the chat path — the user saw a bare
				// "HTTP 429" and no toast.
				return res;
			}
			lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
			// Drain body so the connection can be reused
			try {
				await res.text();
			} catch {
				/* ignore */
			}
		} catch (e) {
			if ((e as { name?: string })?.name === "AbortError") {
				// Distinguish user cancel from timeout
				if (signal.aborted) {
					throw e; // User cancelled — propagate immediately
				}
				// Timeout — log and retry (timeout can be transient)
				lastErr = new Error(`Request timeout after ${timeoutMs}ms`);
				logger("retry", {
					attempt: i + 1,
					error: `timeout ${timeoutMs}ms`,
					willRetry: i < attempts - 1,
				});
			} else {
				lastErr = e;
				logger("retry", {
					attempt: i + 1,
					error: e instanceof Error ? e.message : String(e),
					willRetry: i < attempts - 1,
				});
			}
		}
		if (i < attempts - 1) {
			const delayMs = computeRetryDelay(i, retryAfterHeader);
			if (retryAfterHeader !== null) {
				logger("retry.delay", { delayMs, retryAfter: retryAfterHeader });
			}
			await abortableDelay(delayMs, signal);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Render a DeepSeek API error response into a single readable line, preferring
 * the structured `error.message` field when present so the user sees the
 * actual cause instead of a wall of JSON.
 */
export function formatApiError(status: number, statusText: string, body: string): string {
	const head = `DeepSeek API error: ${status} ${statusText}`;
	if (!body) {
		return head;
	}
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
		const errMsg = parsed?.error?.message;
		if (typeof errMsg === "string" && errMsg) {
			const code = parsed.error?.code ? ` [${parsed.error.code}]` : "";
			return `${head}${code}: ${errMsg}`;
		}
	} catch {
		/* fall through to raw body */
	}
	return `${head}\n${body}`;
}
