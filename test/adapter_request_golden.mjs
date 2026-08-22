// End-to-end golden: VS Code history → convertMessages → reasoning attach →
// buildRequestBody → JSON.stringify, compared byte-for-byte. This is the
// upgrade gate for the wire: it sits above unit_request_body (which starts
// from already-converted messages) and pins the adapter + body together.
// If it fails, the change is a deliberate, CHANGELOG-worthy wire change or a
// bug — there is no third option.
import { createRequire } from "node:module";
import { check, summary } from "./helpers/check.mjs";
import { vscode, OUT, userText, assistantText, textMsg, userImageMsg, assistantToolCallMsg, toolResultMsg } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { convertMessages } = require(OUT("utils.js"));
const { ReasoningCache, fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const { buildRequestBody } = require(OUT("request_body.js"));
const { buildToolPayload } = require(OUT("tool_payload.js"));

// Mirrors provider.attachReasoningToHistory (same algorithm, no logging).
function attach(messages, cache) {
	for (const m of messages) {
		if (m.role !== "assistant" || m.reasoning_content) continue;
		const fp = fingerprintAssistantTurn({
			text: typeof m.content === "string" ? m.content : "",
			toolCalls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name })),
		});
		if (!fp) continue;
		m.reasoning_content = cache.get(fp) ?? "";
	}
}

const sentinel = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
const HISTORY = [
	textMsg(99, "You are an expert AI programming assistant."),
	userText("What's the weather in Tokyo?"),
	assistantToolCallMsg("", [{ callId: "call_00_abc", name: "get_weather", input: { city: "Tokyo" } }]),
	toolResultMsg([{ callId: "call_00_abc", content: [new vscode.LanguageModelTextPart("Sunny, 22°C"), sentinel] }]),
	assistantText("It is sunny and 22°C in Tokyo."),
	userText("And tomorrow?"),
];
const TOOLS = [{ name: "get_weather", description: "Get the weather", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

// Seed the cache exactly as a previous turn would have: tc: for the tool-call turn, tx: for the text turn.
const cache = new ReasoningCache(512);
cache.set(fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "call_00_abc", name: "get_weather" }] }), "I should call get_weather for Tokyo.");
cache.set(fingerprintAssistantTurn({ text: "It is sunny and 22°C in Tokyo.", toolCalls: [] }), "The tool says sunny.");

// === Golden 1: thinking + tools (Pro thinking) ===
{
	const messages = convertMessages(HISTORY, { imageInput: false });
	attach(messages, cache);
	const payload = buildToolPayload(TOOLS, false);
	const body = buildRequestBody({ apiModel: "deepseek-v4-pro", messages, thinking: true, reasoningEffort: "max", maxOutputTokens: 393216, modelOptions: undefined, tools: payload.tools, tool_choice: payload.tool_choice });
	const actual = JSON.stringify(body);
	const EXPECTED =
		'{"model":"deepseek-v4-pro","messages":[' +
		'{"role":"system","content":"You are an expert AI programming assistant."},' +
		'{"role":"user","content":"What\'s the weather in Tokyo?"},' +
		'{"role":"assistant","tool_calls":[{"id":"call_00_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}],"reasoning_content":"I should call get_weather for Tokyo."},' +
		'{"role":"tool","tool_call_id":"call_00_abc","content":"Sunny, 22°C"},' +
		'{"role":"assistant","content":"It is sunny and 22°C in Tokyo.","reasoning_content":"The tool says sunny."},' +
		'{"role":"user","content":"And tomorrow?"}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":393216,' +
		'"thinking":{"type":"enabled"},"reasoning_effort":"max",' +
		'"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],' +
		'"tool_choice":"auto"}';
	check("golden 1: thinking + tools, byte-identical", actual, EXPECTED);
	check("golden 1 sanity: both reasoning_content values attached", (actual.match(/"reasoning_content":"/g) ?? []).length, 2);
	check("golden 1 sanity: sentinel not in tool content", actual.includes("ephemeral"), false);
}
// === Golden 2: non-thinking, no tools (Flash), reasoning must NOT appear ===
{
	const messages = convertMessages(HISTORY, { imageInput: false });
	// provider strips reasoning_content for non-thinking variants; nothing attached here.
	const body = buildRequestBody({ apiModel: "deepseek-v4-flash", messages, thinking: false, reasoningEffort: "max", maxOutputTokens: 65536, modelOptions: { temperature: 0.2 }, tools: undefined, tool_choice: undefined });
	const actual = JSON.stringify(body);
	const EXPECTED =
		'{"model":"deepseek-v4-flash","messages":[' +
		'{"role":"system","content":"You are an expert AI programming assistant."},' +
		'{"role":"user","content":"What\'s the weather in Tokyo?"},' +
		'{"role":"assistant","tool_calls":[{"id":"call_00_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},' +
		'{"role":"tool","tool_call_id":"call_00_abc","content":"Sunny, 22°C"},' +
		'{"role":"assistant","content":"It is sunny and 22°C in Tokyo."},' +
		'{"role":"user","content":"And tomorrow?"}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":65536,' +
		'"thinking":{"type":"disabled"},"temperature":0.2}';
	check("golden 2: non-thinking, byte-identical", actual, EXPECTED);
	check("golden 2 sanity: no reasoning_content", actual.includes("reasoning_content"), false);
	check("golden 2 sanity: temperature honoured", actual.includes('"temperature":0.2'), true);
}
// === Golden 3: vision, image in the last user turn (Flash Vision thinking) ===
{
	const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const messages = convertMessages([...HISTORY.slice(0, 5), userImageMsg("What colour is this?", png)], { imageInput: true });
	attach(messages, cache);
	const body = buildRequestBody({ apiModel: "deepseek-v4-flash-vision-exp", messages, thinking: true, reasoningEffort: "high", maxOutputTokens: 393216, modelOptions: undefined, tools: undefined, tool_choice: undefined });
	const actual = JSON.stringify(body);
	const EXPECTED =
		'{"model":"deepseek-v4-flash-vision-exp","messages":[' +
		'{"role":"system","content":"You are an expert AI programming assistant."},' +
		'{"role":"user","content":"What\'s the weather in Tokyo?"},' +
		'{"role":"assistant","tool_calls":[{"id":"call_00_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}],"reasoning_content":"I should call get_weather for Tokyo."},' +
		'{"role":"tool","tool_call_id":"call_00_abc","content":"Sunny, 22°C"},' +
		'{"role":"assistant","content":"It is sunny and 22°C in Tokyo.","reasoning_content":"The tool says sunny."},' +
		'{"role":"user","content":[{"type":"text","text":"What colour is this?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]}' +
		'],"stream":true,"stream_options":{"include_usage":true},"max_tokens":393216,' +
		'"thinking":{"type":"enabled"},"reasoning_effort":"high"}';
	check("golden 3: vision, byte-identical", actual, EXPECTED);
	check("golden 3 sanity: exactly one image block", (actual.match(/"type":"image_url"/g) ?? []).length, 1);
	check("golden 3 sanity: earlier text-only user turns stay strings", actual.includes('"content":"What\'s the weather in Tokyo?"'), true);
}
summary("adapter_request_golden");
