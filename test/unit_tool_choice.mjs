// Pure tests for resolveToolChoice — the helper that maps
// VS Code's LanguageModelChatToolMode to DeepSeek/OpenAI's tool_choice
// field. Regression coverage for the bug where ToolMode.Required with
// >1 tool used to hard-throw instead of sending "required".
//
// Also covers fitToolChoiceToThinking, which relaxes a forced choice to
// "auto" on thinking variants: DeepSeek's thinking mode rejects both
// "required" and a named function with a 400 ("Thinking mode does not
// support this tool_choice"), so VS Code's Required mode failed on every
// thinking variant.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { resolveToolChoice, fitToolChoiceToThinking } from "../out/tool_choice.js";

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

// Identity, not structure: pass-through must hand back the caller's own
// value, so the request body cannot change shape for requests that work.
function assertSame(label, got, expected) {
	if (Object.is(got, expected)) {
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

const named = { type: "function", function: { name: "read_file" } };

console.log("");
console.log("Case 6: fitToolChoiceToThinking, thinking=false — everything passes through by identity (non-thinking accepts all of them)");
for (const choice of [undefined, "auto", "required", named]) {
	const fitted = fitToolChoiceToThinking(choice, false);
	assertSame(`${JSON.stringify(choice)} → the same value`, fitted.tool_choice, choice);
	assertSame(`${JSON.stringify(choice)} → no relaxedFrom key`, "relaxedFrom" in fitted, false);
}

console.log("");
console.log("Case 7: fitToolChoiceToThinking, thinking=true — a forced choice is relaxed to 'auto' and reported");
assertDeep("'required' → 'auto', relaxedFrom 'required'", fitToolChoiceToThinking("required", true), { tool_choice: "auto", relaxedFrom: "required" });
const relaxedNamed = fitToolChoiceToThinking(named, true);
assertSame("named force → 'auto'", relaxedNamed.tool_choice, "auto");
assertSame("…relaxedFrom is the forced choice itself", relaxedNamed.relaxedFrom, named);

console.log("");
console.log("Case 8: fitToolChoiceToThinking, thinking=true — what thinking mode accepts is left alone (\"none\" is not produced today; pinned so only FORCED choices are ever relaxed)");
for (const choice of [undefined, "auto", "none"]) {
	const fitted = fitToolChoiceToThinking(choice, true);
	assertSame(`${JSON.stringify(choice)} → the same value`, fitted.tool_choice, choice);
	assertSame(`${JSON.stringify(choice)} → no relaxedFrom key`, "relaxedFrom" in fitted, false);
}

console.log("");
console.log("Case 9: resolve → fit, as the provider composes them — Required never reaches the wire forced on a thinking variant");
assertSame("Required + 1 tool, thinking → 'auto'", fitToolChoiceToThinking(resolveToolChoice(true, 1, "read_file"), true).tool_choice, "auto");
assertSame("Required + 3 tools, thinking → 'auto'", fitToolChoiceToThinking(resolveToolChoice(true, 3, "read_file"), true).tool_choice, "auto");
assertDeep("Required + 1 tool, non-thinking → named force, unchanged", fitToolChoiceToThinking(resolveToolChoice(true, 1, "read_file"), false).tool_choice, named);
assertSame("Required + 3 tools, non-thinking → 'required', unchanged", fitToolChoiceToThinking(resolveToolChoice(true, 3, "read_file"), false).tool_choice, "required");
assertSame("Auto, thinking → not reported as relaxed", "relaxedFrom" in fitToolChoiceToThinking(resolveToolChoice(false, 3, "read_file"), true), false);

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
