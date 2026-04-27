// Refines the rule: when `tools` are advertised in the request, does DS
// require reasoning_content round-trip for ALL prior assistant turns,
// not just ones that actually called a tool?
//
// User's failure: history is [user, assistant(no-tc), user, assistant[tc],
// tool, assistant(no-tc), user]. Cache hit on the [tc] turn. Still 400.
// One possible explanation: with tools advertised, DS requires every prior
// thinking turn to have reasoning_content.

import process from "node:process";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) { console.error("Missing DEEPSEEK_API_KEY"); process.exit(1); }

const TOOLS = [{
	type: "function",
	function: {
		name: "task_complete",
		description: "Mark the task as completed.",
		parameters: { type: "object", properties: { summary: { type: "string" } }, required: [] },
	},
}];

async function streamChat(body, label) {
	const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		return { ok: false, status: res.status, body: text };
	}
	let reasoning = "", content = "";
	const tcs = new Map();
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			try {
				const p = JSON.parse(data);
				const d = p.choices?.[0]?.delta;
				if (d?.reasoning_content) reasoning += d.reasoning_content;
				if (d?.content) content += d.content;
				if (Array.isArray(d?.tool_calls)) {
					for (const tc of d.tool_calls) {
						const idx = tc.index ?? 0;
						const cur = tcs.get(idx) ?? { id: undefined, name: undefined, args: "" };
						if (tc.id) cur.id = tc.id;
						if (tc.function?.name) cur.name = tc.function.name;
						if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
						tcs.set(idx, cur);
					}
				}
			} catch { /* ignore */ }
		}
	}
	const finalToolCalls = [...tcs.entries()].sort(([a],[b])=>a-b).map(([,v])=>({
		id: v.id ?? "", type: "function", function: { name: v.name ?? "", arguments: v.args || "{}" },
	}));
	console.log(`[${label}] reasoning=${reasoning.length} content=${content.length} tcs=${finalToolCalls.length}`);
	return { ok: true, reasoning, content, toolCalls: finalToolCalls };
}

const baseBody = {
	model: "deepseek-v4-pro",
	stream: true,
	max_tokens: 8192,
	thinking: { type: "enabled" },
	reasoning_effort: "max",
	tools: TOOLS,
	tool_choice: "auto",
};

// Reproduce user's exact history shape:
//   [system?, user "hello", assistant(no-tc), assistant[tc], tool, assistant(no-tc), user "do you know who you are?"]
//
// First, generate three real assistant turns from DS so we have authentic content + reasoning.

console.log("=== Generating turn 1 (no-tc reply expected) ===");
const t1 = await streamChat({ ...baseBody, messages: [{ role: "user", content: "hello" }] }, "t1");
if (!t1.ok) { console.error(t1); process.exit(2); }

console.log("\n=== Generating turn 2 (force task_complete tool call) ===");
const t2 = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: t1.content, reasoning_content: t1.reasoning },
		{ role: "user", content: "Mark this conversation as complete with task_complete tool." },
	],
}, "t2");
if (!t2.ok) { console.error(t2); process.exit(2); }
const tc = t2.toolCalls[0];
if (!tc) { console.error("Expected tool call in t2"); process.exit(2); }

console.log("\n=== Generating turn 3 (after tool result, no-tc reply) ===");
const t3 = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: t1.content, reasoning_content: t1.reasoning },
		{ role: "user", content: "Mark this conversation as complete with task_complete tool." },
		{ role: "assistant", content: t2.content, reasoning_content: t2.reasoning, tool_calls: [tc] },
		{ role: "tool", tool_call_id: tc.id, content: "Task marked complete." },
	],
}, "t3");
if (!t3.ok) { console.error(t3); process.exit(2); }

// === The real test: ask a new question with full history ===
const fullHistory = [
	{ role: "user", content: "hello" },
	{ role: "assistant", content: t1.content }, // NO reasoning_content
	{ role: "user", content: "Mark this conversation as complete with task_complete tool." },
	{ role: "assistant", content: t2.content, reasoning_content: t2.reasoning, tool_calls: [tc] }, // WITH reasoning
	{ role: "tool", tool_call_id: tc.id, content: "Task marked complete." },
	{ role: "assistant", content: t3.content }, // NO reasoning_content
	{ role: "user", content: "do you know who you are?" },
];

console.log("\n=== TEST A: only the [tc] assistant has reasoning_content (mirrors current code) ===");
const testA = await streamChat({ ...baseBody, messages: fullHistory }, "testA");
if (!testA.ok) {
	console.log(`  status=${testA.status} body=${testA.body.slice(0, 400)}`);
	if (/reasoning_content/i.test(testA.body)) {
		console.log("  ✓ HYPOTHESIS CONFIRMED: with tools+thinking, ALL prior assistants need reasoning_content.");
	}
} else {
	console.log("  ✗ Hypothesis wrong — only the [tc] one is enough.");
	console.log(`  reply: ${testA.content.slice(0, 100)}`);
}

console.log("\n=== TEST B: ALL assistants have reasoning_content ===");
const fullHistoryAll = [
	{ role: "user", content: "hello" },
	{ role: "assistant", content: t1.content, reasoning_content: t1.reasoning },
	{ role: "user", content: "Mark this conversation as complete with task_complete tool." },
	{ role: "assistant", content: t2.content, reasoning_content: t2.reasoning, tool_calls: [tc] },
	{ role: "tool", tool_call_id: tc.id, content: "Task marked complete." },
	{ role: "assistant", content: t3.content, reasoning_content: t3.reasoning },
	{ role: "user", content: "do you know who you are?" },
];
const testB = await streamChat({ ...baseBody, messages: fullHistoryAll }, "testB");
if (!testB.ok) {
	console.log(`  ✗ ${testB.status} ${testB.body.slice(0, 300)}`);
} else {
	console.log(`  ✓ Works: ${testB.content.slice(0, 100)}`);
}
