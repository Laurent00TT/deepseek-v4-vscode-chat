// Standalone integration test that bypasses VS Code entirely.
// Directly hits the DeepSeek API to validate the multi-turn reasoning_content
// round-trip protocol. Run with:
//
//     DEEPSEEK_API_KEY=sk-... node test/integration_round_trip.mjs
//
// What this test proves:
//   1. With thinking enabled, turn-1 returns reasoning_content + tool_call.
//   2. Sending turn-2 WITHOUT reasoning_content reproduces the 400 the
//      user is hitting in VS Code (sanity-check of the failure mode).
//   3. Sending turn-2 WITH reasoning_content attached to the prior assistant
//      message succeeds — i.e. the round-trip fix at the protocol level works.

import process from "node:process";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY env var.");
	process.exit(1);
}

const BASE_URL = "https://api.deepseek.com/v1";

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "Get the current weather in a given location.",
			parameters: {
				type: "object",
				properties: {
					location: { type: "string", description: "City name." },
				},
				required: ["location"],
			},
		},
	},
];

async function streamChat(body, label) {
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		return { ok: false, status: res.status, statusText: res.statusText, body: text };
	}
	if (!res.body) {
		return { ok: false, status: 0, statusText: "no body", body: "" };
	}

	let reasoning = "";
	let content = "";
	const toolCalls = new Map();
	let finishReason;

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) {
				continue;
			}
			const data = line.slice(6).trim();
			if (data === "[DONE]") {
				continue;
			}
			let parsed;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			const choice = parsed.choices?.[0];
			if (!choice) {
				continue;
			}
			const delta = choice.delta;
			if (delta?.reasoning_content) {
				reasoning += delta.reasoning_content;
			}
			if (delta?.content) {
				content += delta.content;
			}
			if (Array.isArray(delta?.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					const buf = toolCalls.get(idx) ?? { id: undefined, name: undefined, args: "" };
					if (tc.id) {
						buf.id = tc.id;
					}
					if (tc.function?.name) {
						buf.name = tc.function.name;
					}
					if (typeof tc.function?.arguments === "string") {
						buf.args += tc.function.arguments;
					}
					toolCalls.set(idx, buf);
				}
			}
			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
		}
	}

	const finalToolCalls = [...toolCalls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, v]) => ({
			id: v.id ?? "",
			type: "function",
			function: { name: v.name ?? "", arguments: v.args || "{}" },
		}));

	console.log(`\n[${label}] finish=${finishReason} reasoningLen=${reasoning.length} contentLen=${content.length} toolCalls=${finalToolCalls.length}`);
	if (reasoning) {
		console.log(`  reasoning head: ${reasoning.slice(0, 120).replace(/\n/g, " ")}...`);
	}
	if (content) {
		console.log(`  content: ${content.slice(0, 200)}`);
	}
	for (const tc of finalToolCalls) {
		console.log(`  tool_call: ${tc.function.name}(${tc.function.arguments}) id=${tc.id}`);
	}

	return { ok: true, reasoning, content, toolCalls: finalToolCalls, finishReason };
}

async function main() {
	const baseBody = {
		model: "deepseek-v4-pro",
		stream: true,
		max_tokens: 16384,
		thinking: { type: "enabled" },
		reasoning_effort: "high",
		tools: TOOLS,
		tool_choice: "auto",
	};

	// === TURN 1: user asks for weather ===
	console.log("=== TURN 1: user asks weather ===");
	const turn1 = await streamChat(
		{
			...baseBody,
			messages: [{ role: "user", content: "What's the weather in Tokyo right now?" }],
		},
		"turn1"
	);
	if (!turn1.ok) {
		console.error("Turn 1 failed unexpectedly:", turn1);
		process.exit(2);
	}
	if (turn1.toolCalls.length === 0) {
		console.error("Turn 1: model did not request a tool call. Test cannot proceed.");
		process.exit(2);
	}
	const tc = turn1.toolCalls[0];

	// === TURN 2 (NEGATIVE): omit reasoning_content from prior assistant turn ===
	console.log("\n=== TURN 2 (NEGATIVE — no reasoning_content): expect 400 ===");
	const turn2NegMessages = [
		{ role: "user", content: "What's the weather in Tokyo right now?" },
		{
			role: "assistant",
			content: turn1.content || "",
			tool_calls: [tc],
			// reasoning_content INTENTIONALLY OMITTED to reproduce the failure
		},
		{
			role: "tool",
			tool_call_id: tc.id,
			content: "Sunny, 22°C, light breeze.",
		},
	];
	const turn2Neg = await streamChat({ ...baseBody, messages: turn2NegMessages }, "turn2-neg");
	if (turn2Neg.ok) {
		console.error("UNEXPECTED: turn-2 without reasoning_content was accepted by DS. The protocol assumption is wrong.");
		process.exit(3);
	}
	console.log(`  status=${turn2Neg.status} statusText=${turn2Neg.statusText}`);
	console.log(`  body=${turn2Neg.body.slice(0, 400)}`);
	if (!/reasoning_content|thinking/i.test(turn2Neg.body)) {
		console.error("UNEXPECTED: 400 returned but not for reasoning_content reason.");
		process.exit(3);
	}
	console.log("  ✓ Reproduced the 400 we are trying to fix.");

	// === TURN 2 (POSITIVE): attach reasoning_content ===
	console.log("\n=== TURN 2 (POSITIVE — with reasoning_content): expect success ===");
	const turn2PosMessages = [
		{ role: "user", content: "What's the weather in Tokyo right now?" },
		{
			role: "assistant",
			content: turn1.content || "",
			tool_calls: [tc],
			reasoning_content: turn1.reasoning, // <-- the fix
		},
		{
			role: "tool",
			tool_call_id: tc.id,
			content: "Sunny, 22°C, light breeze.",
		},
	];
	const turn2Pos = await streamChat({ ...baseBody, messages: turn2PosMessages }, "turn2-pos");
	if (!turn2Pos.ok) {
		console.error("FAIL: turn-2 with reasoning_content still failed:", turn2Pos);
		process.exit(4);
	}
	if (!turn2Pos.content) {
		console.error("FAIL: turn-2 succeeded but produced no content.");
		process.exit(4);
	}
	console.log("  ✓ Round-trip succeeded.");

	console.log("\n=== ALL CHECKS PASSED ===");
	console.log("Protocol-level fix is correct. If VS Code still 400s, it's a fingerprint/cache issue.");
}

main().catch((e) => {
	console.error("Unhandled error:", e);
	process.exit(1);
});
