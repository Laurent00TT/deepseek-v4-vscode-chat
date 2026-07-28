// Tests for the pure request classifier in src/request_kind.ts (issue #17).
// The classifier decides which requests' token usage may drive Copilot's native
// context-window indicator: only real conversation turns (`main-agent` /
// `background`), never the small auxiliary requests (chat-title, progress
// messages, etc.) Copilot routes through the model.
//
// Imports the REAL implementation from compiled `out/request_kind.js`.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { classifyRequestKind, isReportableContextRequest } from "../out/request_kind.js";

let passed = 0;
let failed = 0;
function assertEq(label, got, expected) {
	if (got === expected) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.log(`  ✗ ${label}`);
		console.log(`      expected=${JSON.stringify(expected)}`);
		console.log(`      got     =${JSON.stringify(got)}`);
		failed++;
	}
}

// Real Copilot system-prompt prefixes (truncated) for each kind.
console.log("Case 1: auxiliary kinds are classified and are NOT reportable");
{
	const aux = [
		["chat-title", "You are an expert in crafting ultra-compact titles for a chat conversation."],
		["chat-title", "You are an expert in crafting pithy titles."],
		["inline-progress-message", "You are an expert in writing short, catchy, and encouraging progress messages."],
		["todo-tracker", "You are a background task tracker that maintains a todo list."],
		["prompt-categorizer", "You are an expert classifier for AI coding assistant prompts. Categorize."],
		["settings-resolver", "You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings."],
		["git-branch-name", "You are an expert in crafting pithy branch names for a repository."],
		["git-commit-message", "You are an AI programming assistant, helping a software developer to come with the best git commit message."],
		["rename-suggestions", "You are a distinguished software engineer tasked with renaming a symbol."],
		// Copilot conversation summarization / compaction — the request that
		// re-renders the whole history. Prefix verified against
		// microsoft/vscode-copilot-chat summarizedConversationHistory.tsx
		// (shared by full and simple summarization modes). Issue #19.
		["conversation-summarizer", "Your task is to create a comprehensive, detailed summary of the entire conversation that captures all essential information needed to seamlessly continue the work."],
	];
	for (const [kind, prompt] of aux) {
		const got = classifyRequestKind(prompt, "do it", []);
		assertEq(`'${kind}' detected`, got, kind);
		assertEq(`'${kind}' is NOT reportable`, isReportableContextRequest(got), false);
	}
}

console.log("");
console.log("Case 2: todo-tracker / prompt-categorizer also detected by single tool");
{
	assertEq("only manage_todo_list tool → todo-tracker", classifyRequestKind("", "", ["manage_todo_list"]), "todo-tracker");
	assertEq("only categorize_prompt tool → prompt-categorizer", classifyRequestKind("", "", ["categorize_prompt"]), "prompt-categorizer");
}

console.log("");
console.log("Case 3: terminal notification → terminal-steering (not reportable)");
{
	const got = classifyRequestKind("anything", "[Terminal abc123 notification: command finished]", []);
	assertEq("terminal-steering detected", got, "terminal-steering");
	assertEq("terminal-steering NOT reportable", isReportableContextRequest(got), false);
}

console.log("");
console.log("Case 4: REAL conversation turns are reportable");
{
	// Agent mode — canonical main-agent prompt.
	const agent = classifyRequestKind("You are an expert AI programming assistant working in VS Code.", "fix the bug", ["read_file", "edit_file"]);
	assertEq("main-agent detected", agent, "main-agent");
	assertEq("main-agent IS reportable", isReportableContextRequest(agent), true);

	// Agent variant detected via <skills>/<agents> markers.
	assertEq("<skills> → main-agent", classifyRequestKind("<skills>...</skills>", "go", []), "main-agent");

	// Ordinary ask-mode chat: a non-matching system prompt + content → background.
	const ask = classifyRequestKind("You are a helpful coding assistant.", "explain this code", []);
	assertEq("ask-mode → background", ask, "background");
	assertEq("background IS reportable", isReportableContextRequest(ask), true);

	// Agent turn whose prompt doesn't match a known prefix but has tools → background → reportable.
	const toolish = classifyRequestKind("Custom system prompt", "continue", ["run_terminal"]);
	assertEq("tools + unknown prompt → background", toolish, "background");
	assertEq("→ reportable", isReportableContextRequest(toolish), true);
}

console.log("");
console.log("Case 5: empty request → unknown (NOT reportable — can't clobber the indicator)");
{
	const got = classifyRequestKind("", "", []);
	assertEq("unknown detected", got, "unknown");
	assertEq("unknown NOT reportable", isReportableContextRequest(got), false);
}

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
