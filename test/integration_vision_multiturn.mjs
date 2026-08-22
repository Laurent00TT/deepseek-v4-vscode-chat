// Standalone integration test that bypasses VS Code entirely.
// Multi-turn Vision + tools + thinking round-trip against the live API. Run with:
//
//     DEEPSEEK_API_KEY=sk-... node test/integration_vision_multiturn.mjs
//
// integration_vision.mjs proves the single-turn multimodal wire shape. This
// test covers what it leaves open — the interactions the extension actually
// performs in agent mode with a Vision variant selected. The request bodies
// mirror request_body.ts key-for-key (stream_options.include_usage, thinking
// + reasoning_effort, tools + tool_choice) so the usage numbers below are
// what the extension would see.
//
// What this test proves (hard checks — non-zero exit on failure):
//   1. TURN 1: a user turn [text + image] with a tool advertised, thinking
//      on: the model calls the tool with the image's color (it SEES the
//      locally-generated solid-red PNG) and returns reasoning_content.
//   2. TURN 2: the history [user(blocks), assistant(tool_calls +
//      reasoning_content), tool] is accepted — i.e. the reasoning round-trip
//      attachReasoningToHistory performs composes with block-array user
//      turns, and the Vision model follows the same history rules as
//      Pro/Flash at the point that matters.
//   3. TURN 3: a follow-up text question with the full three-role history
//      is accepted.
//
// What this test RECORDS (informational — printed, never fatal):
//   - Whether the re-sent identical image prefix hits the server prompt
//     cache: usage.prompt_cache_hit_tokens on turn 2 vs turn 1's prompt
//     size, and on turn 3 vs turn 2's. This is the fact that decides whether
//     a Files API / file_id reuse would save anything.
//   - Whether turn 2 WITHOUT reasoning_content is rejected (the strict rule
//     Pro/Flash enforce when tools are present). Either answer is safe for
//     the extension — it always attaches — but the answer is worth knowing.
//   - Whether a role:"tool" message may carry an image block. The extension
//     flattens tool results to text; this records whether that is a
//     limitation of ours or a requirement of the API.
//
// Exit codes: 0 all hard checks passed; 1 env/unhandled; 2 turn-1 failure;
// 3 turn-2 (with reasoning_content) failure; 4 turn-3 failure.

import process from "node:process";
import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY env var.");
	process.exit(1);
}

const BASE_URL = "https://api.deepseek.com/v1";
const MODEL = "deepseek-v4-flash-vision-exp";
// DeepSeek's prompt cache is built asynchronously after a request completes;
// give it a moment before the follow-up so a "miss" means miss, not "too soon".
const CACHE_SETTLE_MS = 2500;
// Prefix-cache granularity: hits are counted in 64-token blocks, so a full
// prefix hit can legitimately fall short of the prior prompt by up to a block.
const CACHE_BLOCK_TOKENS = 64;

// --- Minimal PNG writer: 64x64 solid color, RGB8, no interlace. ---
// Same construction as integration_vision.mjs: zero binary fixtures, and the
// expected answer ("red") is guaranteed by construction.
function crc32(bytes) {
	let c;
	const table = [];
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (const b of bytes) {
		crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function solidPng(width, height, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
	for (let x = 0; x < width; x++) {
		scanline[1 + x * 3] = r;
		scanline[2 + x * 3] = g;
		scanline[3 + x * 3] = b;
	}
	const raw = Buffer.concat(Array.from({ length: height }, () => scanline));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const RED_PNG = solidPng(64, 64, [255, 0, 0]);
const RED_DATA_URL = `data:image/png;base64,${RED_PNG.toString("base64")}`;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "record_color",
			description: "Record the dominant color of the attached image.",
			parameters: {
				type: "object",
				properties: {
					color: { type: "string", description: "A single lowercase color word, e.g. blue." },
				},
				required: ["color"],
			},
		},
	},
];

// Mirrors the exact content-block shape convertMessages/buildUserContent emit.
const USER_IMAGE_TURN = {
	role: "user",
	content: [
		{ type: "text", text: "Call the record_color tool with the dominant color of this image (one lowercase word)." },
		{ type: "image_url", image_url: { url: RED_DATA_URL } },
	],
};

// Mirrors buildRequestBody key order for a thinking request with tools.
function thinkingBody(messages, extra = {}) {
	return {
		model: MODEL,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 16384,
		thinking: { type: "enabled" },
		reasoning_effort: "high",
		tools: TOOLS,
		tool_choice: "auto",
		...extra,
	};
}

function formatUsage(u) {
	if (!u) {
		return "(none)";
	}
	return `prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens} miss=${u.prompt_cache_miss_tokens} completion=${u.completion_tokens}`;
}

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
		console.log(`\n[${label}] HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
		return { ok: false, status: res.status, statusText: res.statusText, body: text };
	}
	if (!res.body) {
		return { ok: false, status: 0, statusText: "no body", body: "" };
	}

	let reasoning = "";
	let content = "";
	const toolCalls = new Map();
	let finishReason;
	let usage;

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
			// Usage rides on the final EMPTY-choices chunk — capture it before
			// the choice gate, exactly as sse.ts does.
			if (parsed.usage && typeof parsed.usage === "object") {
				usage = parsed.usage;
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
					const cur = toolCalls.get(idx) ?? { id: undefined, name: undefined, args: "" };
					if (tc.id) {
						cur.id = tc.id;
					}
					if (tc.function?.name) {
						cur.name = tc.function.name;
					}
					if (typeof tc.function?.arguments === "string") {
						cur.args += tc.function.arguments;
					}
					toolCalls.set(idx, cur);
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

	console.log(
		`\n[${label}] finish=${finishReason} reasoningLen=${reasoning.length} contentLen=${content.length} toolCalls=${finalToolCalls.length}`,
	);
	if (content) {
		console.log(`  content: ${content.slice(0, 200).replace(/\n/g, " ")}`);
	}
	for (const tc of finalToolCalls) {
		console.log(`  tool_call: ${tc.function.name}(${tc.function.arguments}) id=${tc.id}`);
	}
	console.log(`  usage: ${formatUsage(usage)}`);
	return { ok: true, reasoning, content, toolCalls: finalToolCalls, finishReason, usage };
}

// Did THIS request's prompt-cache hit cover the previous request's whole
// prompt (which is a strict prefix of this one)? Returns a human verdict.
function cacheVerdict(label, usage, priorPromptTokens) {
	const hit = usage?.prompt_cache_hit_tokens;
	if (typeof hit !== "number" || typeof priorPromptTokens !== "number") {
		return `${label}: usage missing — cannot judge`;
	}
	if (hit === 0) {
		return `${label}: NO cache hit (hit=0, prior prompt=${priorPromptTokens}) — image prefix not served from cache (or cache not built yet; re-run to confirm)`;
	}
	if (hit >= priorPromptTokens - CACHE_BLOCK_TOKENS) {
		return `${label}: FULL prefix hit (hit=${hit} >= prior prompt ${priorPromptTokens} - ${CACHE_BLOCK_TOKENS}) — the image prefix IS cached`;
	}
	return `${label}: PARTIAL hit (hit=${hit} of prior prompt ${priorPromptTokens}) — text prefix cached, image apparently not`;
}

async function main() {
	console.log(`PNG fixture: 64x64 solid red, ${RED_PNG.length} bytes, base64 ${RED_DATA_URL.length} chars`);
	const record = [];

	// === TURN 1: image + tool + thinking; model must call the tool with "red" ===
	console.log("\n=== TURN 1: user [text + image], tool advertised, thinking on ===");
	let turn1 = await streamChat(thinkingBody([USER_IMAGE_TURN]), "turn1-auto");
	if (!turn1.ok) {
		console.error("FAIL: turn 1 rejected:", turn1.status, (turn1.body || "").slice(0, 300));
		process.exit(2);
	}
	if (turn1.toolCalls.length === 0) {
		// Mirrors the extension's Required mode with a single tool (named force).
		console.log("  model answered without a tool call under tool_choice=auto; retrying with a named force");
		turn1 = await streamChat(
			thinkingBody([USER_IMAGE_TURN], { tool_choice: { type: "function", function: { name: "record_color" } } }),
			"turn1-forced",
		);
		if (!turn1.ok || turn1.toolCalls.length === 0) {
			console.error("FAIL: turn 1 produced no tool call even when forced. Vision + tools may not compose.");
			process.exit(2);
		}
	}
	const tc = turn1.toolCalls[0];
	let color = "";
	try {
		color = String(JSON.parse(tc.function.arguments).color ?? "");
	} catch {
		// leave empty — fails the check below with a clear message
	}
	if (!/red/i.test(color)) {
		console.error(`FAIL: tool called but not with the image's color. args=${tc.function.arguments}`);
		process.exit(2);
	}
	if (!turn1.reasoning) {
		console.error("FAIL: thinking mode returned no reasoning_content on the multimodal tool-call turn.");
		process.exit(2);
	}
	console.log(`  ✓ Model saw the image (record_color color=${JSON.stringify(color)}) and returned reasoning_content.`);

	const assistantTurn1 = {
		role: "assistant",
		content: turn1.content || "",
		tool_calls: [tc],
		reasoning_content: turn1.reasoning,
	};
	const toolTurn = { role: "tool", tool_call_id: tc.id, content: "Recorded." };

	// === TURN 2 (POSITIVE): history with reasoning_content attached ===
	console.log("\n=== TURN 2 (with reasoning_content — what the extension sends): expect success ===");
	await sleep(CACHE_SETTLE_MS);
	const turn2 = await streamChat(thinkingBody([USER_IMAGE_TURN, assistantTurn1, toolTurn]), "turn2-pos");
	if (!turn2.ok) {
		console.error(
			"FAIL: turn 2 with reasoning_content rejected — the Vision history rules differ from Pro/Flash:",
			turn2.status,
			(turn2.body || "").slice(0, 400),
		);
		process.exit(3);
	}
	if (!turn2.content && turn2.toolCalls.length === 0) {
		console.error("FAIL: turn 2 succeeded but produced neither content nor a tool call.");
		process.exit(3);
	}
	console.log("  ✓ Vision history [user(blocks), assistant(tc+reasoning), tool] accepted.");
	record.push(cacheVerdict("turn2 vs turn1", turn2.usage, turn1.usage?.prompt_tokens));

	// === TURN 2 (NEGATIVE, informational): same history WITHOUT reasoning_content ===
	console.log("\n=== TURN 2 (WITHOUT reasoning_content — informational): does Vision enforce the strict rule? ===");
	const assistantNoReasoning = { role: "assistant", content: assistantTurn1.content, tool_calls: assistantTurn1.tool_calls };
	const turn2Neg = await streamChat(thinkingBody([USER_IMAGE_TURN, assistantNoReasoning, toolTurn]), "turn2-neg");
	if (turn2Neg.ok) {
		record.push(
			"strict rule: Vision ACCEPTED a prior tool-call turn without reasoning_content (more lenient than Pro/Flash) — extension still attaches, no change needed",
		);
	} else if (/reasoning_content|thinking/i.test(turn2Neg.body || "")) {
		record.push(
			`strict rule: Vision REJECTED it (${turn2Neg.status}, mentions reasoning_content) — same rule as Pro/Flash; attachReasoningToHistory is load-bearing here too`,
		);
	} else {
		record.push(`strict rule: Vision rejected it with ${turn2Neg.status} for another reason: ${(turn2Neg.body || "").slice(0, 160)}`);
	}

	// === TURN 3: follow-up text question over the full history ===
	console.log("\n=== TURN 3: follow-up text question, full history: expect success ===");
	const assistantTurn2 = { role: "assistant", content: turn2.content || "", reasoning_content: turn2.reasoning };
	const history3 = [USER_IMAGE_TURN, assistantTurn1, toolTurn];
	if (turn2.toolCalls.length > 0) {
		assistantTurn2.tool_calls = turn2.toolCalls;
	}
	history3.push(assistantTurn2);
	for (const extra of turn2.toolCalls) {
		history3.push({ role: "tool", tool_call_id: extra.id, content: "Recorded." });
	}
	history3.push({ role: "user", content: "In one lowercase word: which color did you record?" });
	await sleep(CACHE_SETTLE_MS);
	const turn3 = await streamChat(thinkingBody(history3), "turn3");
	if (!turn3.ok) {
		console.error("FAIL: turn 3 rejected:", turn3.status, (turn3.body || "").slice(0, 400));
		process.exit(4);
	}
	if (!turn3.content && turn3.toolCalls.length === 0) {
		console.error("FAIL: turn 3 succeeded but produced neither content nor a tool call.");
		process.exit(4);
	}
	if (!/red/i.test(turn3.content)) {
		console.log(
			`  (note) turn 3 did not say 'red' — content=${turn3.content.slice(0, 80)}; the history being accepted is the hard check`,
		);
	}
	console.log("  ✓ Three-round Vision history accepted.");
	record.push(cacheVerdict("turn3 vs turn2", turn3.usage, turn2.usage?.prompt_tokens));

	// === PROBE (informational): may a role:"tool" message carry an image block? ===
	console.log("\n=== PROBE (informational): tool-role message with an image block ===");
	const toolWithImage = {
		role: "tool",
		tool_call_id: tc.id,
		content: [
			{ type: "text", text: "Recorded. The image again for reference:" },
			{ type: "image_url", image_url: { url: RED_DATA_URL } },
		],
	};
	const probe = await streamChat(thinkingBody([USER_IMAGE_TURN, assistantTurn1, toolWithImage]), "probe-tool-image");
	if (probe.ok) {
		record.push("tool-role image block: ACCEPTED (200) — flattening tool results to text is our limitation, not the API's");
	} else {
		record.push(
			`tool-role image block: REJECTED (${probe.status}: ${(probe.body || "").slice(0, 160)}) — flattening tool results to text is required`,
		);
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
