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
		return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
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
