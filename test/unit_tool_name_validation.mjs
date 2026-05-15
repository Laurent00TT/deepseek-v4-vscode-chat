// Truth-table test for `isValidToolName` — the strict predicate used by
// `validateTools` to reject any name that would drift through
// sanitizeFunctionName before reaching DeepSeek.
//
// The function is inlined here for now (same constraint as
// unit_cache_breakdown.mjs — .mjs can't directly import .ts). Step 5 of
// the review-fix series will switch both unit tests to import from
// compiled `out/utils.js` and add CI coverage.
//
// Run:  node test/unit_tool_name_validation.mjs
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";

// === INLINED FROM src/utils.ts — keep in sync ===
function sanitizeFunctionName(name) {
    if (typeof name !== "string" || !name) {
        return "tool";
    }
    let s = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(s)) {
        s = `tool_${s}`;
    }
    s = s.replace(/_+/g, "_");
    return s.slice(0, 64);
}

function isValidToolName(name) {
    return typeof name === "string" && name.length > 0 && sanitizeFunctionName(name) === name;
}
// === END INLINE ===

const cases = [
    // [label, input, expectedValid]

    // === The 4 drift cases the strict predicate must reject ===
    ["digit-leading: '1tool' is rewritten to 'tool_1tool'",        "1tool",                  false],
    ["underscore-leading: '_private' is rewritten to 'tool_private'", "_private",            false],
    ["consecutive underscores: 'foo__bar' is collapsed to 'foo_bar'", "foo__bar",            false],
    ["over-64 chars: 'a'.repeat(70) gets truncated",                 "a".repeat(70),          false],

    // === Names that should pass cleanly ===
    ["plain alphanumeric: 'normal_name'",                            "normal_name",           true],
    ["hyphenated: 'foo-bar'",                                        "foo-bar",               true],
    ["alphanumeric with single underscore: 'tool_v2'",               "tool_v2",               true],
    ["exactly 64 chars",                                             "a".repeat(64),          true],
    ["lowercase letters and digits: 'getweather'",                   "getweather",            true],

    // === Names that should fail (illegal characters) ===
    ["contains dot: 'weather.get' becomes 'weather_get'",            "weather.get",           false],
    ["contains space: 'get weather' becomes 'get_weather'",          "get weather",           false],
    ["non-ASCII: '获取天气' becomes '____' then 'tool_____'",         "获取天气",                false],

    // === Edge cases ===
    ["empty string",                                                 "",                      false],
    ["single letter 'a'",                                            "a",                     true],
    ["only digits: '123'",                                           "123",                   false],
    ["only underscore: '_'",                                         "_",                     false],
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
