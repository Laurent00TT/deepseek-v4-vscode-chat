// convertMessages / convertTools / validateRequest — the VS Code → OpenAI
// adapter in src/utils.ts, tested as compiled under the vscode shim.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary, withConsole } from "./helpers/check.mjs";
import { vscode, OUT, userText, assistantText, textMsg, userImageMsg, assistantToolCallMsg, toolResultMsg } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { convertMessages, convertTools, validateRequest, isToolResultPart } = require(OUT("utils.js"));
const Role = vscode.LanguageModelChatMessageRole;

// --- roles and plain text ---
checkDeep("user text → {role:user, content:string}", convertMessages([userText("hi")]), [{ role: "user", content: "hi" }]);
checkDeep("assistant text", convertMessages([assistantText("yo")]), [{ role: "assistant", content: "yo" }]);
checkDeep("unknown role number → system", convertMessages([textMsg(99, "sys")]), [{ role: "system", content: "sys" }]);
checkDeep("adjacent text parts concatenate", convertMessages([{ role: Role.User, content: [new vscode.LanguageModelTextPart("a"), new vscode.LanguageModelTextPart("b")] }]), [{ role: "user", content: "ab" }]);
checkDeep("empty text user message emits nothing", convertMessages([userText("")]), []);
checkDeep("empty assistant emits nothing", convertMessages([assistantText("")]), []);
checkDeep("empty message list → []", convertMessages([]), []);

// --- assistant tool calls ---
const tc = convertMessages([assistantToolCallMsg("thinking aloud", [{ callId: "call_1", name: "get_weather", input: { city: "Tokyo" } }])]);
checkDeep("assistant tool call shape", tc, [
	{ role: "assistant", content: "thinking aloud", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
]);
check("tool-call turn without text → content undefined (key absent in JSON)", JSON.stringify(convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "t", input: {} }])])[0]).includes('"content"'), false);
check("missing callId is generated", typeof convertMessages([assistantToolCallMsg("", [{ callId: "", name: "t", input: {} }])])[0].tool_calls[0].id, "string");
check("generated callId is non-empty", convertMessages([assistantToolCallMsg("", [{ callId: "", name: "t", input: {} }])])[0].tool_calls[0].id.length > 0, true);
check("input undefined → '{}'", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "t", input: undefined }])])[0].tool_calls[0].function.arguments, "{}");
checkMatch("host name is aliased to the wire name", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "weather.get", input: {} }])])[0].tool_calls[0].function.name, /^weather_get_[0-9a-f]{8}$/);
check("spec-legal names pass through", convertMessages([assistantToolCallMsg("", [{ callId: "c", name: "read_file", input: {} }])])[0].tool_calls[0].function.name, "read_file");

// --- tool results ---
checkDeep(
	"tool result → role tool with text",
	convertMessages([toolResultMsg([{ callId: "call_1", content: [new vscode.LanguageModelTextPart("Sunny")] }])]),
	[{ role: "tool", tool_call_id: "call_1", content: "Sunny" }],
);
checkDeep("plain-string content parts are accepted", convertMessages([toolResultMsg([{ callId: "c", content: ["a", "b"] }])]), [{ role: "tool", tool_call_id: "c", content: "ab" }]);
checkDeep("empty tool result → content ''", convertMessages([toolResultMsg([{ callId: "c", content: [] }])]), [{ role: "tool", tool_call_id: "c", content: "" }]);
{
	// Issue #11: VS Code 1.118+ appends a cache_control sentinel data part to tool results.
	const sentinel = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
	const r = withConsole("warn", () => convertMessages([toolResultMsg([{ callId: "c", content: [new vscode.LanguageModelTextPart("ok"), sentinel] }])]));
	checkDeep("cache_control sentinel dropped silently", r.result, [{ role: "tool", tool_call_id: "c", content: "ok" }]);
	check("…without a warning", r.lines.length, 0);
	const unknown = withConsole("warn", () => convertMessages([toolResultMsg([{ callId: "c", content: [new vscode.LanguageModelDataPart(new Uint8Array(1), "application/x-mystery")] }])]));
	checkDeep("unknown data part dropped", unknown.result, [{ role: "tool", tool_call_id: "c", content: "" }]);
	checkMatch("…with one warning naming the mime", unknown.lines.join("|"), /dropped unknown tool-result part.*application\/x-mystery/);
}
checkDeep(
	"one user message with two results → two tool messages in order",
	convertMessages([toolResultMsg([{ callId: "a", content: ["1"] }, { callId: "b", content: ["2"] }])]),
	[{ role: "tool", tool_call_id: "a", content: "1" }, { role: "tool", tool_call_id: "b", content: "2" }],
);

// --- images ---
const png = new Uint8Array([137, 80, 78, 71]);
{
	const off = withConsole("warn", () => convertMessages([userImageMsg("look", png)]));
	checkDeep("vision off: image dropped, text stays a string", off.result, [{ role: "user", content: "look" }]);
	checkMatch("vision off: warns 'no image input'", off.lines.join("|"), /dropped 1 image attachment.*no image input/);
	const on = convertMessages([userImageMsg("look", png)], { imageInput: true });
	checkDeep("vision on: block array with data URL", on, [
		{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } }] },
	]);
	const bad = withConsole("warn", () => convertMessages([userImageMsg("look", png, "image/bmp")], { imageInput: true }));
	checkDeep("unsupported MIME: dropped, string content", bad.result, [{ role: "user", content: "look" }]);
	checkMatch("unsupported MIME: warns", bad.lines.join("|"), /unsupported MIME/);
	checkDeep("vision on, text only: still a plain string", convertMessages([userText("plain")], { imageInput: true }), [{ role: "user", content: "plain" }]);
	check("image-only user message → single image block", convertMessages([{ role: Role.User, content: [new vscode.LanguageModelDataPart(png, "image/png")] }], { imageInput: true })[0].content.length, 1);
	checkDeep("images on assistant turns are ignored", convertMessages([{ role: Role.Assistant, content: [new vscode.LanguageModelTextPart("t"), new vscode.LanguageModelDataPart(png, "image/png")] }], { imageInput: true }), [{ role: "assistant", content: "t" }]);
	check("structural data part (no class) is treated as an image", convertMessages([{ role: Role.User, content: [{ mimeType: "image/png", data: png }] }], { imageInput: true })[0].content[0].type, "image_url");
}

// --- a realistic agent history in one call ---
const history = convertMessages([
	textMsg(99, "You are an expert AI programming assistant."),
	userText("weather?"),
	assistantToolCallMsg("", [{ callId: "call_1", name: "get_weather", input: { city: "Tokyo" } }]),
	toolResultMsg([{ callId: "call_1", content: ["Sunny"] }]),
	assistantText("It is sunny."),
	userText("thanks"),
]);
checkDeep("history roles in order", history.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user"]);

// --- convertTools ---
check("convertTools: no tools → {}", JSON.stringify(convertTools({})), "{}");
check("convertTools: Auto → 'auto'", convertTools({ tools: [{ name: "a" }], toolMode: vscode.LanguageModelChatToolMode.Auto }).tool_choice, "auto");
checkDeep("convertTools: Required + 1 tool → named", convertTools({ tools: [{ name: "a" }], toolMode: vscode.LanguageModelChatToolMode.Required }).tool_choice, { type: "function", function: { name: "a" } });

// --- validateRequest ---
const emptyList = withConsole("error", () => { try { validateRequest([]); return false; } catch (e) { return /no messages/.test(e.message); } });
check("validateRequest: empty list throws", emptyList.result, true);
check("validateRequest: empty list throws — one error line captured", emptyList.lines.length, 1);
check("validateRequest: paired call/result passes", (() => { validateRequest([userText("q"), assistantToolCallMsg("", [{ callId: "x", name: "t", input: {} }]), toolResultMsg([{ callId: "x", content: ["r"] }])]); return true; })(), true);
const missingResult = withConsole("error", () => { try { validateRequest([userText("q"), assistantToolCallMsg("", [{ callId: "x", name: "t", input: {} }]), userText("next")]); return false; } catch (e) { return /Tool call part must be followed/.test(e.message); } });
check("validateRequest: missing result throws", missingResult.result, true);
check("validateRequest: missing result throws — one error line captured", missingResult.lines.length, 1);
check("validateRequest: assistant without tool calls needs nothing", (() => { validateRequest([userText("q"), assistantText("a"), userText("b")]); return true; })(), true);

// --- isToolResultPart ---
check("isToolResultPart: real part", isToolResultPart(new vscode.LanguageModelToolResultPart("c", [])), true);
check("isToolResultPart: structural", isToolResultPart({ callId: "c", content: [] }), true);
check("isToolResultPart: text part is not", isToolResultPart(new vscode.LanguageModelTextPart("x")), false);
summary("adapter_convert_messages");
