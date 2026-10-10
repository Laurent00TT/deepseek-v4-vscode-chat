// Standalone integration test that bypasses VS Code entirely. Run with:
//
//     DEEPSEEK_API_KEY=sk-... node test/integration_tool_choice_thinking.mjs
//
// Which `tool_choice` values does DeepSeek accept with thinking on, and with
// it off? VS Code's Required tool mode maps to a forced choice — a named
// function for one tool, "required" for several (resolveToolChoice). Thinking
// mode rejects both with 400 "Thinking mode does not support this
// tool_choice" (first seen 2026-10-11), so the extension sends Required mode
// as "auto" on thinking variants (fitToolChoiceToThinking). This script pins
// the premises of that design on both API models the extension sends. The
// request bodies mirror request_body.ts key-for-key.
//
// What this test proves (hard checks — non-zero exit on failure): every
// tool_choice the extension can send is accepted —
//   1. thinking on + "auto" (Auto mode, and Required mode after relaxing);
//   2. thinking off + "auto", "required" and a named function (Auto and
//      Required mode on the non-thinking variants, sent untouched).
//
// What this test RECORDS (informational — printed, never fatal):
//   - thinking on + "required" / a named function: rejected as expected, or
//     ACCEPTED — then the restriction is lifted and the relaxation can be
//     revisited.
//   - whether the model still called the tool under thinking + "auto", with
//     one tool advertised and a question that needs it — what a relaxed
//     Required request gets.
//   - "none" (never sent by the extension), for completeness.
//
// Exit codes: 0 all hard checks passed; 1 env/unhandled; 2 a hard check failed.

import process from "node:process";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY env var.");
	process.exit(1);
}

const BASE_URL = "https://api.deepseek.com/v1";
// V4 Pro, and V4.1 Flash under its own id — the retired `deepseek-v4-flash`
// and `deepseek-v4-flash-vision-exp` ids are routed to it.
const MODELS = ["deepseek-v4-pro", "deepseek-flash"];

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_time",
			description: "Get the current local time in a city.",
			parameters: {
				type: "object",
				properties: { city: { type: "string", description: "City name, e.g. Tokyo." } },
				required: ["city"],
			},
		},
	},
];
const NAMED = { type: "function", function: { name: "get_time" } };
const CHOICES = ["auto", "none", "required", NAMED];

// Mirrors buildRequestBody key order (thinking → reasoning_effort, otherwise
// temperature; tools, tool_choice last).
function requestBody(model, thinking, toolChoice) {
	return {
		model,
		messages: [{ role: "user", content: "What time is it in Tokyo right now?" }],
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 4096,
		thinking: { type: thinking ? "enabled" : "disabled" },
		...(thinking ? { reasoning_effort: "high" } : { temperature: 0.7 }),
		tools: TOOLS,
		tool_choice: toolChoice,
	};
}

// Sends one request and drains the stream, so "accepted" means a completed
// response, not just a 200 header. Returns the status, the server's error
// message on rejection, and how many tool calls the model made.
async function probe(model, thinking, toolChoice) {
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(requestBody(model, thinking, toolChoice)),
	});
	if (!res.ok) {
		const text = await res.text();
		let error = text.slice(0, 200);
		try {
			error = JSON.parse(text)?.error?.message ?? error;
		} catch {
			// not JSON — keep the raw snippet
		}
		return { status: res.status, error, toolCalls: 0 };
	}
	const callIndexes = new Set();
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
			if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") {
				continue;
			}
			try {
				for (const tc of JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) {
					callIndexes.add(tc.index ?? 0);
				}
			} catch {
				// malformed chunk — irrelevant to what is measured here
			}
		}
	}
	return { status: res.status, toolCalls: callIndexes.size };
}

const describe = (choice) => (typeof choice === "string" ? `"${choice}"` : `named(${choice.function.name})`);

async function main() {
	const failures = [];
	const record = [];
	for (const model of MODELS) {
		for (const thinking of [true, false]) {
			console.log(`\n=== ${model}, thinking ${thinking ? "on" : "off"} ===`);
			for (const choice of CHOICES) {
				const r = await probe(model, thinking, choice);
				const outcome = r.error ? `${r.status} ${r.error}` : `${r.status}, ${r.toolCalls} tool call(s)`;
				const line = `${model} thinking=${thinking ? "on" : "off"} tool_choice=${describe(choice)} → ${outcome}`;
				console.log(`  ${line}`);
				const forced = choice !== "auto" && choice !== "none";
				const sentByExtension = choice === "auto" || (forced && !thinking);
				if (sentByExtension && r.status !== 200) {
					failures.push(line);
				}
				if (thinking && forced) {
					if (r.status === 200) {
						record.push(`${model}: thinking mode ACCEPTED tool_choice=${describe(choice)} — the restriction is lifted; the relaxation in fitToolChoiceToThinking can be revisited`);
					} else if (!/does not support this tool_choice/i.test(r.error ?? "")) {
						record.push(`${model}: thinking mode rejected tool_choice=${describe(choice)} with a different error: ${outcome}`);
					}
				}
				if (thinking && choice === "auto" && r.status === 200) {
					record.push(`${model}: thinking + "auto" (a relaxed Required request) — the model ${r.toolCalls > 0 ? "still called" : "did NOT call"} the tool`);
				}
				if (choice === "none" && r.status !== 200) {
					record.push(`${model}: tool_choice="none" rejected with thinking ${thinking ? "on" : "off"}: ${outcome}`);
				}
			}
		}
	}

	if (failures.length > 0) {
		console.error("\nFAIL: a tool_choice the extension sends was rejected:");
		for (const f of failures) {
			console.error(`  - ${f}`);
		}
		process.exit(2);
	}
	console.log("\n=== ALL HARD CHECKS PASSED ===");
	console.log("Recorded facts (informational):");
	for (const line of record) {
		console.log(`  - ${line}`);
	}
}

main().catch((e) => {
	console.error("Unhandled error:", e);
	process.exit(1);
});
