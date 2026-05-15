// Truth-table test for `isValidToolName` — the strict predicate used by
// `validateTools` to reject any name that would drift through
// sanitizeFunctionName before reaching DeepSeek.
//
// Imports the REAL implementation from compiled `out/tool_names.js`
// rather than inlining a copy. `npm test` invokes `npm run compile`
// first via the pretest hook.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { isValidToolName, sanitizeFunctionName } from "../out/tool_names.js";

const cases = [
	// [label, input, expectedValid]

	// === The 4 drift cases the strict predicate must reject ===
	["digit-leading: '1tool' is rewritten to 'tool_1tool'",          "1tool",                  false],
	["underscore-leading: '_private' is rewritten to 'tool_private'", "_private",              false],
	["consecutive underscores: 'foo__bar' is collapsed to 'foo_bar'", "foo__bar",              false],
	["over-64 chars: 'a'.repeat(70) gets truncated",                  "a".repeat(70),          false],

	// === Names that should pass cleanly ===
	["plain alphanumeric: 'normal_name'",                             "normal_name",           true],
	["hyphenated: 'foo-bar'",                                         "foo-bar",               true],
	["alphanumeric with single underscore: 'tool_v2'",                "tool_v2",               true],
	["exactly 64 chars",                                              "a".repeat(64),          true],
	["lowercase letters and digits: 'getweather'",                    "getweather",            true],

	// === Names that should fail (illegal characters) ===
	["contains dot: 'weather.get' becomes 'weather_get'",             "weather.get",           false],
	["contains space: 'get weather' becomes 'get_weather'",           "get weather",           false],
	["non-ASCII: '获取天气' becomes '____' then 'tool_____'",          "获取天气",                false],

	// === Edge cases ===
	["empty string",                                                  "",                      false],
	["single letter 'a'",                                             "a",                     true],
	["only digits: '123'",                                            "123",                   false],
	["only underscore: '_'",                                          "_",                     false],
];

let passed = 0;
let failed = 0;
const failures = [];

for (const [label, input, expected] of cases) {
	const got = isValidToolName(input);
	if (got === expected) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		const sanitized = sanitizeFunctionName(input);
		failures.push(
			`  ✗ ${label}\n      input=${JSON.stringify(input)} expected=${expected} got=${got}\n      sanitizeFunctionName would produce: ${JSON.stringify(sanitized)}`,
		);
	}
}

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
