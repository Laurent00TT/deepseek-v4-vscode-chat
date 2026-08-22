// Tests for the vscode-free HTTP layer (src/api_client.ts): the Retry-After
// delay computation, the abortable backoff sleep, formatApiError rendering,
// and fetchWithRetry's retry/no-retry/abort semantics via a monkey-patched
// global fetch. The retry sleep being abortable is a user-facing fix: a
// Cancel during a plain setTimeout backoff used to be ignored until the
// sleep ran out.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import {
	MAX_RETRY_AFTER_MS,
	computeRetryDelay,
	abortableDelay,
	fetchWithRetry,
	formatApiError,
} from "../out/api_client.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	if (Object.is(got, expected)) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
	}
}

const silentLogger = () => {};

// === 1. computeRetryDelay ===
check("no header → 1s backoff on attempt 0", computeRetryDelay(0, null), 1000);
check("no header → 2s backoff on attempt 1", computeRetryDelay(1, null), 2000);
check("Retry-After 5 raises the delay to 5s", computeRetryDelay(0, "5"), 5000);
check("Retry-After 5 with whitespace accepted", computeRetryDelay(0, " 5 "), 5000);
check("Retry-After 0 never lowers below backoff", computeRetryDelay(0, "0"), 1000);
check("Retry-After 9999 capped at MAX_RETRY_AFTER_MS", computeRetryDelay(0, "9999"), MAX_RETRY_AFTER_MS);
check("cap constant is 10s", MAX_RETRY_AFTER_MS, 10_000);
check("HTTP-date form ignored (backoff)", computeRetryDelay(0, "Fri, 22 Aug 2026 03:00:00 GMT"), 1000);
check("junk ignored (backoff)", computeRetryDelay(1, "soon"), 2000);
check("negative ignored (backoff)", computeRetryDelay(0, "-5"), 1000);
check("empty string ignored (backoff)", computeRetryDelay(0, ""), 1000);

// === 2. abortableDelay ===
async function checkAbortable() {
	// Resolves normally.
	const t0 = Date.now();
	await abortableDelay(30, new AbortController().signal);
	check("delay resolves after the wait", Date.now() - t0 >= 25, true);

	// Pre-aborted signal rejects immediately.
	const pre = new AbortController();
	pre.abort();
	const preResult = await abortableDelay(5000, pre.signal).then(
		() => ({ rejected: false, name: undefined }),
		(e) => ({ rejected: true, name: e?.name })
	);
	check("pre-aborted signal rejects immediately", preResult.rejected, true);
	check("pre-aborted rejection is AbortError", preResult.name, "AbortError");

	// Abort mid-sleep cuts the wait short.
	const mid = new AbortController();
	const t1 = Date.now();
	const midPromise = abortableDelay(5000, mid.signal).then(
		() => ({ rejected: false }),
		(e) => ({ rejected: true, name: e?.name, elapsed: Date.now() - t1 })
	);
	setTimeout(() => mid.abort(), 30);
	const midResult = await midPromise;
	check("abort mid-sleep rejects", midResult.rejected, true);
	check("abort mid-sleep rejects promptly (<1s)", (midResult.elapsed ?? 9999) < 1000, true);
}

// === 3. fetchWithRetry via monkey-patched fetch ===
function makeResponse(status, { headers = {}, body = "", statusText = "" } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		text: async () => body,
	};
}

async function checkFetchWithRetry() {
	const realFetch = globalThis.fetch;
	try {
		// 4xx (non-429) does not retry.
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return makeResponse(400);
		};
		const res400 = await fetchWithRetry("https://x/", {}, new AbortController().signal, silentLogger);
		check("400 returned without retry", res400.status, 400);
		check("400 made exactly one attempt", calls, 1);

		// 429 with Retry-After: 0 retries (delay = backoff 1s) then succeeds,
		// and the honored header shows up in the retry.delay log.
		calls = 0;
		const logged = [];
		globalThis.fetch = async () => {
			calls++;
			return calls === 1 ? makeResponse(429, { headers: { "retry-after": "0" } }) : makeResponse(200);
		};
		const t0 = Date.now();
		const res429 = await fetchWithRetry("https://x/", {}, new AbortController().signal, (msg, data) =>
			logged.push({ msg, data })
		);
		check("429 then 200 succeeds", res429.status, 200);
		check("429 retried once", calls, 2);
		check("backoff floor applied (~1s wait)", Date.now() - t0 >= 900, true);
		const delayLog = logged.find((l) => l.msg === "retry.delay");
		check("honored Retry-After logged", delayLog?.data?.retryAfter, "0");
		const retryLog = logged.find((l) => l.msg === "retry");
		check("retry log carries the header", retryLog?.data?.retryAfter, "0");

		// User abort during the backoff sleep propagates AbortError promptly.
		calls = 0;
		const abort = new AbortController();
		globalThis.fetch = async () => {
			calls++;
			return makeResponse(429, { headers: { "retry-after": "9999" } });
		};
		setTimeout(() => abort.abort(), 30);
		const t1 = Date.now();
		const abortResult = await fetchWithRetry("https://x/", {}, abort.signal, silentLogger).then(
			() => ({ threw: false }),
			(e) => ({ threw: true, name: e?.name, elapsed: Date.now() - t1 })
		);
		check("abort during backoff sleep throws", abortResult.threw, true);
		check("abort surfaces as AbortError", abortResult.name, "AbortError");
		check("abort cuts the capped 10s sleep short (<2s)", (abortResult.elapsed ?? 9999) < 2000, true);
		check("aborted call stopped after the first attempt", calls, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// === 4. formatApiError (moved in the previous commit — pin the strings) ===
check("plain error line", formatApiError(500, "Internal Server Error", ""), "DeepSeek API error: 500 Internal Server Error");
check(
	"structured error message preferred",
	formatApiError(400, "Bad Request", '{"error":{"message":"context length exceeded","code":"ctx"}}'),
	"DeepSeek API error: 400 Bad Request [ctx]: context length exceeded"
);
check(
	"unparseable body appended raw",
	formatApiError(502, "Bad Gateway", "<html>oops</html>"),
	"DeepSeek API error: 502 Bad Gateway\n<html>oops</html>"
);

await checkAbortable();
await checkFetchWithRetry();

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
	console.log("");
	console.log("Failures:");
	for (const f of failures) {
		console.log(f);
	}
	process.exit(1);
}
process.exit(0);
