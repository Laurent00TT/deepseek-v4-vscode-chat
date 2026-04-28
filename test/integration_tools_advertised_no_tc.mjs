// Corner case: `tools` is advertised in the request, but the conversation
// history contains NO assistant turn that actually called a tool. All prior
// assistant turns are plain text replies.
//
// Official docs say only "rounds that performed tool calls" need
// reasoning_content round-trip. If that were true, this scenario should
// accept history without reasoning_content (since no turn called a tool).
//
// If DS rejects with 400 here, the actual rule is stronger:
//   "tools field non-empty in request" => every prior assistant turn must
//   round-trip reasoning_content, regardless of whether it called a tool.
//
// Sequence:
//   turn1: user "Hi, my favorite number is 42." (with tools advertised)
//          -> DS replies in plain text, no tc
//   turn2 NEG: history [user, assistant(no reasoning), user] + tools
//          -> expect 400 if the strong rule holds
//   turn2 POS: history [user, assistant(WITH reasoning), user] + tools
//          -> expect 200

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
	reasoning_effort: "high",
	tools: TOOLS,            // advertised
	tool_choice: "auto",     // do not force a call
};

console.log("=== TURN 1: tools advertised, but plain question (expect no tc) ===");
const t1 = await streamChat({
	...baseBody,
	messages: [{ role: "user", content: "Hi, my favorite number is 42. Just reply briefly in text — do not use any tool." }],
}, "t1");
if (!t1.ok) { console.error(t1); process.exit(2); }
if (t1.toolCalls.length > 0) {
	console.error("Turn 1 unexpectedly produced a tool call; cannot run this corner case.");
	process.exit(3);
}

console.log("\n=== TURN 2 NEG: tools advertised, history has assistant w/o reasoning_content, no tool_calls anywhere ===");
const t2neg = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "Hi, my favorite number is 42. Just reply briefly in text — do not use any tool." },
		{ role: "assistant", content: t1.content }, // NO reasoning_content, NO tool_calls
		{ role: "user", content: "What's my favorite number?" },
	],
}, "t2-neg");
if (!t2neg.ok) {
	console.log(`  status=${t2neg.status} body=${t2neg.body.slice(0, 400)}`);
	if (/reasoning_content/i.test(t2neg.body)) {
		console.log("  ✓ STRONG RULE CONFIRMED: tools advertised => every prior assistant needs reasoning_content,");
		console.log("    even when NO turn ever called a tool. Official docs wording is misleading.");
	} else {
		console.log("  ✗ 400 but for a different reason — inspect body above.");
	}
} else {
	console.log("  ✗ STRONG RULE REFUTED: server accepted a plain text history with tools advertised.");
	console.log(`  reply preview: ${t2neg.content.slice(0, 100)}`);
}

console.log("\n=== TURN 2 POS: same history but WITH reasoning_content on the assistant turn ===");
const t2pos = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "Hi, my favorite number is 42. Just reply briefly in text — do not use any tool." },
		{ role: "assistant", content: t1.content, reasoning_content: t1.reasoning },
		{ role: "user", content: "What's my favorite number?" },
	],
}, "t2-pos");
if (t2pos.ok) {
	console.log(`  ✓ Round-trip works: ${t2pos.content.slice(0, 100)}`);
} else {
	console.log(`  ✗ failed: status=${t2pos.status} body=${t2pos.body.slice(0, 300)}`);
}
