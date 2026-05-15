// Truth-table test for `isValidToolName`, the strict predicate used by
// `validateTools` to reject names that DeepSeek would not accept.
//
// Oracle: OpenAI / DeepSeek function-name spec — `^[A-Za-z0-9_-]{1,64}$`.
// Names like `1tool`, `_private`, `foo__bar` are SPEC-LEGAL even though
// they were rejected by an earlier over-defensive sanitization layer we
// inherited from the upstream fork. The spec is the source of truth;
// we no longer rewrite legal names before sending them.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { isValidToolName } from "../out/tool_names.js";

const cases = [
	// [label, input, expectedValid]

	// === Names previously rejected over-zealously — now accepted (spec-legal) ===
	["digit-leading: '1tool' is spec-legal ([A-Za-z0-9_-])",         "1tool",                  true],
	["underscore-leading: '_private' is spec-legal",                  "_private",               true],
	["consecutive underscores: 'foo__bar' is spec-legal",             "foo__bar",               true],
	["only digits: '123' is spec-legal",                              "123",                    true],
	["only underscore: '_' is spec-legal",                            "_",                      true],
	["only dash: '-' is spec-legal",                                  "-",                      true],

	// === Names that should pass cleanly ===
	["plain alphanumeric: 'normal_name'",                             "normal_name",            true],
	["hyphenated: 'foo-bar'",                                         "foo-bar",                true],
	["alphanumeric with single underscore: 'tool_v2'",                "tool_v2",                true],
	["exactly 64 chars",                                              "a".repeat(64),           true],
	["lowercase letters and digits: 'getweather'",                    "getweather",             true],
	["single letter 'a'",                                             "a",                      true],

	// === Names that should fail (illegal characters per spec) ===
	["contains dot: 'weather.get'",                                   "weather.get",            false],
	["contains space: 'get weather'",                                 "get weather",            false],
	["contains plus: 'a+b'",                                          "a+b",                    false],
	["non-ASCII: '获取天气'",                                          "获取天气",                 false],

	// === Length constraint ===
	["empty string",                                                  "",                       false],
	["over-64 chars: 'a'.repeat(70)",                                 "a".repeat(70),           false],
	["exactly 65 chars: just over",                                   "a".repeat(65),           false],
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
		failures.push(
			`  ✗ ${label}\n      input=${JSON.stringify(input)} (len=${input.length}) expected=${expected} got=${got}`,
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
