// Pins the frozen model catalog (CONTRIBUTING red line #2): picker ids, API
// model names, thinking/vision flags and token budgets. Renaming an id
// orphans every user's picker selection; changing a budget changes the
// pre-flight overflow guard and the host's context planning.
//
//     npm test
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { MODEL_VARIANTS, findVariant } from "../out/model_catalog.js";

const EXPECTED = [
	["deepseek-v4-pro::thinking", "DeepSeek V4 Pro (thinking)", "deepseek-v4-pro", true, false, 655360, 393216],
	["deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek-v4-pro", false, false, 983040, 65536],
	["deepseek-v4-flash::thinking", "DeepSeek V4 Flash (thinking)", "deepseek-v4-flash", true, false, 655360, 393216],
	["deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek-v4-flash", false, false, 983040, 65536],
	["deepseek-v4-flash-vision-exp::thinking", "DeepSeek V4 Flash Vision (thinking)", "deepseek-v4-flash-vision-exp", true, true, 655360, 393216],
	["deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision", "deepseek-v4-flash-vision-exp", false, true, 983040, 65536],
];

check("exactly six variants", MODEL_VARIANTS.length, 6);
checkDeep(
	"variant order and frozen fields",
	MODEL_VARIANTS.map((v) => [v.id, v.displayName, v.apiModel, v.thinking, v.vision === true, v.maxInputTokens, v.maxOutputTokens]),
	EXPECTED,
);
check("ids are unique", new Set(MODEL_VARIANTS.map((v) => v.id)).size, 6);
check("first entry is the strongest (host default)", MODEL_VARIANTS[0].id, "deepseek-v4-pro::thinking");
for (const v of MODEL_VARIANTS) {
	check(`${v.id}: tooltip is non-empty copy`, typeof v.tooltip === "string" && v.tooltip.length > 0, true);
	check(`${v.id}: input + output = 1M`, v.maxInputTokens + v.maxOutputTokens, 1048576);
	check(`${v.id}: thinking ⇒ 384K output`, v.thinking ? v.maxOutputTokens : 393216, 393216);
}
check("findVariant hit", findVariant("deepseek-v4-flash")?.displayName, "DeepSeek V4 Flash");
check("findVariant miss", findVariant("deepseek-v4-turbo"), undefined);
check("thinking ids carry the ::thinking suffix", MODEL_VARIANTS.every((v) => v.thinking === v.id.endsWith("::thinking")), true);
summary("unit_model_catalog");
