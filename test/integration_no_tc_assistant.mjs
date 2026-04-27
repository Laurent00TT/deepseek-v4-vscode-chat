// Verifies the rule: in thinking mode, EVERY prior assistant turn must
// round-trip reasoning_content, even ones without tool_calls.
//
// Sequence:
//   turn1: user "Hi"  -> assistant (no tools available, no tc) returns reasoning + content
//   turn2: user "What was my message?" with [user, assistant(no reasoning_content), user]
//          -> if DS rejects with 400, the rule is "all turns require it"
//          -> if DS accepts, the rule is "only tc turns require it"

import process from "node:process";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY");
	process.exit(1);
}

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
			} catch { /* ignore */ }
		}
	}
	console.log(`[${label}] reasoning=${reasoning.length} content=${content.length}`);
	return { ok: true, reasoning, content };
}

const baseBody = {
	model: "deepseek-v4-pro",
	stream: true,
	max_tokens: 8192,
	thinking: { type: "enabled" },
	reasoning_effort: "high",
	// no tools — we want a no-tc assistant turn
};

console.log("=== TURN 1: plain reply, no tools ===");
const t1 = await streamChat({ ...baseBody, messages: [{ role: "user", content: "Hi, my favorite number is 42." }] }, "t1");
if (!t1.ok) { console.error(t1); process.exit(2); }

console.log("\n=== TURN 2 NEG: omit reasoning_content from prior no-tc assistant ===");
const t2neg = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "Hi, my favorite number is 42." },
		{ role: "assistant", content: t1.content },
		{ role: "user", content: "What's my favorite number?" },
	],
}, "t2-neg");
if (!t2neg.ok) {
	console.log(`  status=${t2neg.status} body=${t2neg.body.slice(0, 300)}`);
	if (/reasoning_content/i.test(t2neg.body)) {
		console.log("  ✓ HYPOTHESIS CONFIRMED: no-tc assistant ALSO requires reasoning_content round-trip.");
	} else {
		console.log("  ✗ 400 but for different reason.");
	}
} else {
	console.log("  ✗ HYPOTHESIS WRONG: no-tc assistant accepted without reasoning_content.");
}

console.log("\n=== TURN 2 POS: attach reasoning_content ===");
const t2pos = await streamChat({
	...baseBody,
	messages: [
		{ role: "user", content: "Hi, my favorite number is 42." },
		{ role: "assistant", content: t1.content, reasoning_content: t1.reasoning },
		{ role: "user", content: "What's my favorite number?" },
	],
}, "t2-pos");
if (t2pos.ok) {
	console.log(`  ✓ Round-trip works: ${t2pos.content.slice(0, 100)}`);
} else {
	console.log(`  ✗ failed: ${t2pos.body.slice(0, 200)}`);
}
