// Pins buildToolPayload's schema sanitization and tool_choice passthrough —
// the part of the tool wire shape not covered by unit_tool_limit (which
// covers the skip/cap path) or unit_tool_wire_name (aliasing).
//
//     npm test
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { buildToolPayload } from "../out/tool_payload.js";

const one = (tool, required = false) => buildToolPayload([tool], required).tools[0].function;
const silent = (fn) => {
	const orig = console.error;
	console.error = () => {};
	try {
		return fn();
	} finally {
		console.error = orig;
	}
};

// --- envelope ---
check("no tools → {}", JSON.stringify(buildToolPayload([], false)), "{}");
checkDeep("function envelope", buildToolPayload([{ name: "ping" }], false).tools[0], {
	type: "function",
	function: { name: "ping", description: "", parameters: { type: "object", properties: {} } },
});
check("description passthrough", one({ name: "a", description: "desc" }).description, "desc");
check("non-string description → empty", one({ name: "a", description: 42 }).description, "");

// --- tool_choice ---
check("auto when not required", buildToolPayload([{ name: "a" }], false).tool_choice, "auto");
checkDeep("single tool + required → named force", buildToolPayload([{ name: "a" }], true).tool_choice, { type: "function", function: { name: "a" } });
check("multiple tools + required → 'required'", buildToolPayload([{ name: "a" }, { name: "b" }], true).tool_choice, "required");
checkDeep("named force uses the WIRE name of an aliased tool", buildToolPayload([{ name: "weather.get" }], true).tool_choice.function.name.startsWith("weather_get_"), true);

// --- schema sanitization ---
checkDeep("null schema → empty object schema", one({ name: "a", inputSchema: null }).parameters, { type: "object", properties: {} });
checkDeep("array schema → empty object schema", one({ name: "a", inputSchema: [] }).parameters, { type: "object", properties: {} });
checkDeep(
	"unknown keywords pruned, known kept",
	one({ name: "a", inputSchema: { type: "object", properties: {}, $schema: "x", title: "t", description: "d" } }).parameters,
	{ type: "object", properties: {}, description: "d" },
);
checkDeep("missing type defaults to object", one({ name: "a", inputSchema: { properties: { x: { type: "string" } } } }).parameters, {
	properties: { x: { type: "string" } },
	type: "object",
});
checkDeep(
	"anyOf prefers the string branch",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { anyOf: [{ type: "number" }, { type: "string", description: "s" }] } } } }).parameters.properties.v,
	{ type: "string", description: "s" },
);
checkDeep(
	"oneOf without a string branch takes the first",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { oneOf: [{ type: "integer" }, { type: "boolean" }] } } } }).parameters.properties.v,
	{ type: "integer" },
);
check("integer-like property name: number → integer", one({ name: "a", inputSchema: { type: "object", properties: { limit: { type: "number" } } } }).parameters.properties.limit.type, "integer");
check("…also *_id", one({ name: "a", inputSchema: { type: "object", properties: { user_id: { type: "number" } } } }).parameters.properties.user_id.type, "integer");
check("non-integer-like number stays number", one({ name: "a", inputSchema: { type: "object", properties: { ratio: { type: "number" } } } }).parameters.properties.ratio.type, "number");
checkDeep("required filtered to strings", one({ name: "a", inputSchema: { type: "object", properties: {}, required: ["x", 1, null] } }).parameters.required, ["x"]);
checkDeep("non-array required → []", one({ name: "a", inputSchema: { type: "object", properties: {}, required: "x" } }).parameters.required, []);
check("non-boolean additionalProperties removed", "additionalProperties" in one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } } }).parameters, false);
check("boolean additionalProperties kept", one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: false } }).parameters.additionalProperties, false);
checkDeep("array items: tuple → first item", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array", items: [{ type: "number" }, { type: "string" }] } } } }).parameters.properties.l.items, { type: "number" });
checkDeep("array items: object sanitized", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array", items: { type: "object", properties: { n: { type: "number" } }, nope: 1 } } } } }).parameters.properties.l.items, { type: "object", properties: { n: { type: "number" } } });
checkDeep("array items: missing → string", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array" } } } }).parameters.properties.l.items, { type: "string" });
checkDeep("nested objects sanitized recursively", one({ name: "a", inputSchema: { type: "object", properties: { o: { type: "object", properties: { count: { type: "number" }, junk: { type: "string", weird: 1 } } } } } }).parameters.properties.o, {
	type: "object",
	properties: { count: { type: "integer" }, junk: { type: "string" } },
});

// --- skips (already covered in unit_tool_limit; one representative here) ---
const skipped = silent(() => buildToolPayload([{ name: "ok" }, { name: "" }, null, { name: 7 }], false));
check("unusable entries skipped, usable kept", skipped.tools.length, 1);
summary("unit_tool_payload");
