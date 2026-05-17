// Pure tests for resolveToolChoice — the helper that maps
// VS Code's LanguageModelChatToolMode to DeepSeek/OpenAI's tool_choice
// field. Regression coverage for the bug where ToolMode.Required with
// >1 tool used to hard-throw instead of sending "required".
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { resolveToolChoice } from "../out/tool_choice.js";

let passed = 0;
let failed = 0;

function assertDeep(label, got, expected) {
	const ok = JSON.stringify(got) === JSON.stringify(expected);
	if (ok) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.log(`  ✗ ${label}`);
		console.log(`      expected=${JSON.stringify(expected)}`);
		console.log(`      got     =${JSON.stringify(got)}`);
		failed++;
	}
}

console.log("Case 1: requiredMode=false (Auto) — always 'auto' regardless of tool count");
assertDeep("0 tools → auto", resolveToolChoice(false, 0, undefined), "auto");
assertDeep("1 tool  → auto", resolveToolChoice(false, 1, "read_file"), "auto");
assertDeep("5 tools → auto", resolveToolChoice(false, 5, "read_file"), "auto");

console.log("");
console.log("Case 2: requiredMode=true + exactly one tool → named force");
assertDeep(
	"1 tool 'read_file' → {type:function, function:{name:'read_file'}}",
	resolveToolChoice(true, 1, "read_file"),
	{ type: "function", function: { name: "read_file" } },
);

console.log("");
console.log("Case 3: requiredMode=true + multiple tools → 'required' literal (regression for prior hard-throw)");
assertDeep("2 tools → 'required'", resolveToolChoice(true, 2, "read_file"), "required");
assertDeep("10 tools → 'required'", resolveToolChoice(true, 10, "any_first_name"), "required");

console.log("");
console.log("Case 4: edge — requiredMode=true + 0 tools → 'required' (would never reach here in practice since convertTools early-returns on empty tools, but the helper itself is safe)");
assertDeep("0 tools → 'required'", resolveToolChoice(true, 0, undefined), "required");

console.log("");
console.log("Case 5: edge — requiredMode=true + 1 tool but missing firstToolName → 'required' (defensive: never emit a name-less function force)");
assertDeep("1 tool undefined name → 'required'", resolveToolChoice(true, 1, undefined), "required");
assertDeep("1 tool empty-string name → 'required'", resolveToolChoice(true, 1, ""), "required");

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
