// Behavioural tests for `toWireName` / `buildWireNameMap`, the deterministic
// wire-aliasing layer that replaced the hard-throwing `validateTools`
// (issue #20: one over-long PyLance MCP tool name crashed every request).
//
// Properties under test:
//   1. spec-legal names pass through UNCHANGED (aliasing is invisible for
//      the common case — anything else would break existing fingerprints);
//   2. every output is spec-legal (`^[A-Za-z0-9_-]{1,64}$`);
//   3. deterministic AND idempotent — history re-aliasing and the reasoning
//      cache fingerprint both rely on `toWireName(toWireName(x)) === toWireName(x)`;
//   4. distinct inputs stay distinct (hash over the ORIGINAL name);
//   5. the frozen literal below pins the algorithm — changing head/tail
//      split or hash function breaks conversations that span extension
//      versions, so it must be a DELIBERATE decision, not drift.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { isValidToolName, toWireName, buildWireNameMap } from "../out/tool_names.js";

// The exact name from issue #20: PyLance v2026.3.1 behind VS Code's MCP
// prefix — 72 chars, 8 over the limit.
const PYLANCE = "activate_fallback_mcp_pylance_mcp_s_pylanceCheckSignatureCompatibility_1";
// Same length, differs only in the middle — must NOT collide.
const PYLANCE_SIBLING = "activate_fallback_mcp_pylance_mcp_s_pylanceRunCodeSnippetCompatibility_1";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	const ok = Object.is(got, expected);
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
	}
}

// === 1. Spec-legal names pass through unchanged ===
check("passthrough: 'normal_name'", toWireName("normal_name"), "normal_name");
check("passthrough: hyphenated 'foo-bar'", toWireName("foo-bar"), "foo-bar");
check("passthrough: digit-leading '1tool'", toWireName("1tool"), "1tool");
check("passthrough: exactly 64 chars", toWireName("a".repeat(64)), "a".repeat(64));

// === 2. Illegal characters sanitize to underscore + hash of the original ===
// The hash rides along on EVERY changed alias, not just over-long ones:
// bare sanitization is lossy — 'weather.get' would collide with a
// legitimate sibling tool literally named 'weather_get', and equal-length
// CJK names would all collapse to the same underscore run, silently
// dropping real tools via the first-wins collision guard.
check("sanitize: 'weather.get' → 'weather_get_<hash>'", toWireName("weather.get"), "weather_get_78f8c471");
check("sanitize: 'get weather' → 'get_weather_<hash>'", toWireName("get weather"), "get_weather_f7ed9c23");
check("sanitize: non-ASCII '获取天气' → '____<hash>'", toWireName("获取天气"), "_____82722bed");
check(
	"no collision with a spec-legal sibling: 'weather.get' vs 'weather_get'",
	toWireName("weather.get") === toWireName("weather_get"),
	false,
);
check(
	"equal-length CJK names stay distinct: '获取天气' vs '发送邮件'",
	toWireName("获取天气") === toWireName("发送邮件"),
	false,
);

// === 3. Over-long names compress to head + tail + hash, exactly 64 ===
check("issue #20 name is over-long", PYLANCE.length > 64, true);
const pylanceWire = toWireName(PYLANCE);
check(
	"frozen alias for the issue #20 PyLance name",
	pylanceWire,
	"activate_fallback_mcp__nceCheckSignatureCompatibility_1_66ad0585",
);
check("compressed length is exactly 64", pylanceWire.length, 64);
check("compressed name is spec-legal", isValidToolName(pylanceWire), true);
check("head preserved (MCP prefix)", pylanceWire.startsWith("activate_fallback_mcp_"), true);
check(
	"semantic tail preserved before hash",
	pylanceWire.includes("CheckSignatureCompatibility_1"),
	true,
);
check("hash suffix shape: /_[0-9a-f]{8}$/", /_[0-9a-f]{8}$/.test(pylanceWire), true);

// === 4. Deterministic and idempotent ===
check("deterministic: repeated call, same result", toWireName(PYLANCE), pylanceWire);
for (const input of ["normal_name", "weather.get", "获取天气", PYLANCE, PYLANCE_SIBLING, "a".repeat(200)]) {
	check(
		`idempotent: ${JSON.stringify(input.slice(0, 24))}…`,
		toWireName(toWireName(input)),
		toWireName(input),
	);
}

// === 5. Distinct inputs stay distinct ===
check(
	"middle-differing siblings do not collide",
	toWireName(PYLANCE) === toWireName(PYLANCE_SIBLING),
	false,
);
// `a.b…` and `a_b…` sanitize identically — the hash over the ORIGINAL
// name must still keep them apart in the over-long branch.
const dotted = "a.b" + "x".repeat(70);
const scored = "a_b" + "x".repeat(70);
check("sanitize-collision under length: hash disambiguates", toWireName(dotted) === toWireName(scored), false);

// === 6. Degenerate input ===
check("empty string stays empty (caller must skip)", toWireName(""), "");

// === 7. buildWireNameMap: reverse map round-trips ===
const names = [PYLANCE, PYLANCE_SIBLING, "normal_name", "weather.get"];
const map = buildWireNameMap(names);
check("map size covers all usable names", map.size, 4);
for (const n of names) {
	check(`round-trip: wire(${JSON.stringify(n.slice(0, 24))}…) → host`, map.get(toWireName(n)), n);
}

// === 8. buildWireNameMap: first-wins and skip-unusable ===
const dupMap = buildWireNameMap(["same_name", "same_name", "", undefined, 42]);
check("duplicate host names keep one entry", dupMap.size, 1);
check("duplicate maps to the (first) host name", dupMap.get("same_name"), "same_name");

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
