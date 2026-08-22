// Shared assertion helpers. Output format matches the existing unit suites
// ("  ✓ label" / "  ✗ label", then "=== Results: N passed, M failed ===").
import process from "node:process";

let passed = 0;
let failed = 0;
const failures = [];

function record(ok, label, got, expected) {
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${safe(expected)}\n      got     =${safe(got)}`);
		console.log(`  ✗ ${label}`);
	}
}
function safe(v) {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

/** Strict Object.is comparison. */
export function check(label, got, expected) {
	record(Object.is(got, expected), label, got, expected);
}
/** Structural comparison via JSON.stringify. */
export function checkDeep(label, got, expected) {
	record(JSON.stringify(got) === JSON.stringify(expected), label, got, expected);
}
/** Regex match against String(got). */
export function checkMatch(label, got, regex) {
	record(regex.test(String(got)), label, got, String(regex));
}

/**
 * Poll `predicate` until it returns truthy. Resolves `true` on success and
 * `false` on timeout — never throws, and a throwing predicate counts as
 * "not yet". Use instead of sleeping a guessed duration: assert the result
 * is `true` so a real regression fails the suite instead of racing it.
 */
export async function until(predicate, timeoutMs = 2000, intervalMs = 10) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await predicate()) {
				return true;
			}
		} catch {
			/* not ready yet */
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/**
 * Run `fn` with `console[method]` swapped for a collector, then restore it.
 * Returns `{ result, lines }`; if `fn` returns a thenable, returns a promise
 * of `{ result, lines }` and restores only once it settles. The console is
 * restored on the throwing path too.
 *
 * Nesting- and overlap-safe: a per-method stack tracks the active collectors,
 * so a call that finishes out of order re-installs the innermost collector
 * that is still pending (instead of clobbering it with a stale function), and
 * the real console method is reinstalled only once the last collector is done.
 */
const consoleStacks = new Map();
export function withConsole(method, fn) {
	let stack = consoleStacks.get(method);
	if (!stack) {
		stack = { orig: console[method], frames: [] };
		consoleStacks.set(method, stack);
	}
	const lines = [];
	const frame = { collector: (...a) => lines.push(a.map(String).join(" ")) };
	stack.frames.push(frame);
	console[method] = frame.collector;
	const restore = () => {
		const i = stack.frames.indexOf(frame);
		if (i >= 0) {
			stack.frames.splice(i, 1);
		}
		if (stack.frames.length > 0) {
			console[method] = stack.frames[stack.frames.length - 1].collector;
		} else {
			console[method] = stack.orig;
			consoleStacks.delete(method);
		}
	};
	let deferred = false;
	try {
		const result = fn();
		if (result && typeof result.then === "function") {
			deferred = true;
			return result.then((r) => ({ result: r, lines })).finally(restore);
		}
		return { result, lines };
	} finally {
		if (!deferred) {
			restore();
		}
	}
}
/** Print the summary line and exit (1 if anything failed). */
export function summary(suiteName = "") {
	console.log("");
	console.log(`=== Results: ${passed} passed, ${failed} failed ===${suiteName ? `  (${suiteName})` : ""}`);
	if (failed > 0) {
		console.log("\nFailures:");
		for (const f of failures) {
			console.log(f);
		}
		process.exit(1);
	}
	process.exit(0);
}
