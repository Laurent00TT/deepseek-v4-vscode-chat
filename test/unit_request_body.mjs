// Golden-request test: pins the SERIALIZED request body byte-for-byte.
//
// This is the mechanical guard for the repo's most important invariant:
// DeepSeek's server prompt cache keys on the request prefix, and the local
// reasoning-cache fingerprints are computed over the same converted
// messages. A reordered key, an `undefined` that starts serializing, or a
// float that changes shape silently breaks prompt-cache hit rates (12x
// input-price difference) for every user — without failing any behavior
// test. So this test compares JSON.stringify output against literal
// expected strings; if it ever fails, the change is either a deliberate,
// CHANGELOG-worthy wire change or a bug. There is no third option.
//
// Message fixtures mimic convertMessages/attachReasoningToHistory key
// insertion order: {role, content}, assistant tool-call turns
// {role, content, tool_calls, reasoning_content}, tool turns
// {role, tool_call_id, content}.
//
//     npm test
//
// Exits 0 on all-pass, 1 on any failure.

import process from "node:process";
import { buildRequestBody, coerceReasoningEffort } from "../out/request_body.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, expected) {
	if (Object.is(got, expected)) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		failures.push(`  ✗ ${label}\n      expected=${JSON.stringify(expected)}\n      got     =${JSON.stringify(got)}`);
	}
}

// === 1. Effort coercion ===
check("effort: high passes", coerceReasoningEffort("high"), "high");
check("effort: max passes", coerceReasoningEffort("max"), "max");
check("effort: unknown coerces to max", coerceReasoningEffort("extreme"), "max");
check("effort: undefined coerces to max", coerceReasoningEffort(undefined), "max");

// === 2. Golden: thinking request (Pro thinking, no tools) ===
// The exact body shape 0.3.x has always sent for a plain thinking turn.
const thinkingBody = buildRequestBody({
	apiModel: "deepseek-v4-pro",
	messages: [
		{ role: "system", content: "You are an expert AI programming assistant." },
		{ role: "user", content: "What does utils.ts do?" },
		{ role: "assistant", content: "It converts messages.", reasoning_content: "The user asks about utils." },
		{ role: "user", content: "Thanks." },
	],
	thinking: true,
	reasoningEffort: "max",
	maxOutputTokens: 393216,
	modelOptions: undefined,
	tools: undefined,
	tool_choice: undefined,
});
check(
	"golden thinking body serializes byte-identically",
	JSON.stringify(thinkingBody),
	'{"model":"deepseek-v4-pro","messages":[' +
		'{"role":"system","content":"You are an expert AI programming assistant."},' +
		'{"role":"user","content":"What does utils.ts do?"},' +
		'{"role":"assistant","content":"It converts messages.","reasoning_content":"The user asks about utils."},' +
		'{"role":"user","content":"Thanks."}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":393216,' +
		'"thinking":{"type":"enabled"},"reasoning_effort":"max"}'
);

// === 3. Golden: non-thinking request with tools, tool-call history, and the
//        full modelOptions allow-list ===
const toolBody = buildRequestBody({
	apiModel: "deepseek-v4-flash",
	messages: [
		{ role: "user", content: "Weather in Tokyo?" },
		{
			role: "assistant",
			content: undefined,
			tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } }],
		},
		{ role: "tool", tool_call_id: "call_abc123", content: "Sunny, 22°C" },
	],
	thinking: false,
	reasoningEffort: "max", // ignored for non-thinking — must NOT serialize
	maxOutputTokens: 65536,
	modelOptions: { max_tokens: 4096, temperature: 0.2, stop: ["\n\n"], frequency_penalty: 0.5, presence_penalty: 0.1 },
	tools: [
		{
			type: "function",
			function: { name: "get_weather", description: "Get weather.", parameters: { type: "object", properties: {} } },
		},
	],
	tool_choice: "auto",
});
check(
	"golden non-thinking body serializes byte-identically",
	JSON.stringify(toolBody),
	'{"model":"deepseek-v4-flash","messages":[' +
		'{"role":"user","content":"Weather in Tokyo?"},' +
		'{"role":"assistant","tool_calls":[{"id":"call_abc123","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Tokyo\\"}"}}]},' +
		'{"role":"tool","tool_call_id":"call_abc123","content":"Sunny, 22°C"}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":4096,' +
		'"thinking":{"type":"disabled"},"temperature":0.2,"stop":["\\n\\n"],' +
		'"frequency_penalty":0.5,"presence_penalty":0.1,' +
		'"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather.","parameters":{"type":"object","properties":{}}}}],' +
		'"tool_choice":"auto"}'
);

// === 4. Golden: vision content blocks pass through untouched ===
const visionBody = buildRequestBody({
	apiModel: "deepseek-v4-flash-vision-exp",
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "What color?" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,SGVsbG8=" } },
			],
		},
	],
	thinking: false,
	reasoningEffort: "max",
	maxOutputTokens: 65536,
});
check(
	"golden vision body serializes byte-identically",
	JSON.stringify(visionBody),
	'{"model":"deepseek-v4-flash-vision-exp","messages":[' +
		'{"role":"user","content":[{"type":"text","text":"What color?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,SGVsbG8="}}]}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":65536,' +
		'"thinking":{"type":"disabled"},"temperature":0.7}'
);

// === 5. max_tokens clamp semantics ===
const clampHigh = buildRequestBody({
	apiModel: "deepseek-v4-flash",
	messages: [],
	thinking: false,
	reasoningEffort: "max",
	maxOutputTokens: 65536,
	modelOptions: { max_tokens: 999999 },
});
check("max_tokens hint capped to the variant ceiling", clampHigh.max_tokens, 65536);
const clampZero = buildRequestBody({
	apiModel: "deepseek-v4-flash",
	messages: [],
	thinking: false,
	reasoningEffort: "max",
	maxOutputTokens: 65536,
	modelOptions: { max_tokens: 0 },
});
check("max_tokens hint of 0 falls back to the full budget", clampZero.max_tokens, 65536);

// === 6. Gating: thinking mode must not leak sampling params ===
const thinkingWithOptions = buildRequestBody({
	apiModel: "deepseek-v4-pro",
	messages: [],
	thinking: true,
	reasoningEffort: "high",
	maxOutputTokens: 393216,
	modelOptions: { temperature: 0.9, stop: ["x"], frequency_penalty: 1, presence_penalty: 1 },
});
check("thinking body carries reasoning_effort", thinkingWithOptions.reasoning_effort, "high");
for (const key of ["temperature", "stop", "frequency_penalty", "presence_penalty"]) {
	check(`thinking body omits ${key}`, key in thinkingWithOptions, false);
}
check("non-thinking body omits reasoning_effort", "reasoning_effort" in toolBody, false);

console.log("");
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
	console.log("");
	console.log("Failures:");
	for (const f of failures) {
		console.log(f);
	}
	process.exit(1);
}
process.exit(0);
