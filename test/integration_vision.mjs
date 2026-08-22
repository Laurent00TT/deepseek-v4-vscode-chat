// Standalone integration test that bypasses VS Code entirely.
// Directly hits the DeepSeek API to validate the Vision (multimodal) wire
// protocol used by this extension for deepseek-v4-flash-vision-exp. Run with:
//
//     DEEPSEEK_API_KEY=sk-... node test/integration_vision.mjs
//
// What this test proves:
//   1. The content-block shape we send ({type:"text"} + {type:"image_url",
//      image_url:{url:"data:image/png;base64,..."}}) is accepted by
//      /chat/completions for deepseek-v4-flash-vision-exp.
//   2. The model actually SEES the image (it names the color of a
//      locally-generated solid-red PNG — no proxy description involved).
//   3. The same multimodal request works in thinking mode and returns
//      reasoning_content, i.e. Vision composes with the extension's
//      extended-thinking round-trip.

import process from "node:process";
import { deflateSync } from "node:zlib";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY env var.");
	process.exit(1);
}

const BASE_URL = "https://api.deepseek.com/v1";
const MODEL = "deepseek-v4-flash-vision-exp";

// --- Minimal PNG writer: 64x64 solid color, RGB8, no interlace. ---
// Generated locally so the test has zero binary fixtures and the expected
// answer ("red") is guaranteed by construction.
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
	// compression 0, filter 0, interlace 0 — already zeroed
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

// Mirrors the exact content-block shape convertMessages/buildUserContent emit.
const VISION_MESSAGES = [
	{
		role: "user",
		content: [
			{ type: "text", text: "What is the dominant color of this image? Answer with a single lowercase word." },
			{ type: "image_url", image_url: { url: RED_DATA_URL } },
		],
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
			if (choice.delta?.reasoning_content) {
				reasoning += choice.delta.reasoning_content;
			}
			if (choice.delta?.content) {
				content += choice.delta.content;
			}
			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
		}
	}

	console.log(`\n[${label}] finish=${finishReason} reasoningLen=${reasoning.length} contentLen=${content.length}`);
	if (content) {
		console.log(`  content: ${content.slice(0, 200)}`);
	}
	return { ok: true, reasoning, content, finishReason };
}

async function main() {
	console.log(`PNG fixture: 64x64 solid red, ${RED_PNG.length} bytes, base64 ${RED_DATA_URL.length} chars`);

	// === CHECK 1+2: non-thinking multimodal request; model must SEE red ===
	console.log("\n=== VISION (non-thinking): expect the model to answer 'red' ===");
	const plain = await streamChat(
		{
			model: MODEL,
			stream: true,
			max_tokens: 1024,
			thinking: { type: "disabled" },
			messages: VISION_MESSAGES,
		},
		"vision-plain",
	);
	if (!plain.ok) {
		console.error("FAIL: multimodal content blocks rejected:", plain);
		process.exit(2);
	}
	if (!/red/i.test(plain.content)) {
		console.error(`FAIL: model did not identify the red image. content=${plain.content}`);
		process.exit(2);
	}
	console.log("  ✓ Content-block shape accepted; model saw the image.");

	// === CHECK 3: same request in thinking mode ===
	console.log("\n=== VISION (thinking): expect reasoning_content + 'red' ===");
	const thinking = await streamChat(
		{
			model: MODEL,
			stream: true,
			max_tokens: 16384,
			thinking: { type: "enabled" },
			reasoning_effort: "high",
			messages: VISION_MESSAGES,
		},
		"vision-thinking",
	);
	if (!thinking.ok) {
		console.error("FAIL: thinking-mode multimodal request rejected:", thinking);
		process.exit(3);
	}
	if (!/red/i.test(thinking.content)) {
		console.error(`FAIL: thinking mode did not identify the red image. content=${thinking.content}`);
		process.exit(3);
	}
	if (!thinking.reasoning) {
		console.error("FAIL: thinking mode returned no reasoning_content for a multimodal request.");
		process.exit(3);
	}
	console.log("  ✓ Vision composes with extended thinking.");

	console.log("\n=== ALL CHECKS PASSED ===");
	console.log("The Vision wire protocol this extension emits is accepted end-to-end.");
}

main().catch((e) => {
	console.error("Unhandled error:", e);
	process.exit(1);
});
