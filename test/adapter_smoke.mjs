// Proves the preload chain: out/utils.js requires "vscode" and must receive
// the shim; convertTools with no tools returns {} (pure path through the adapter).
import { check, summary } from "./helpers/check.mjs";
import { vscode, shim, OUT } from "./helpers/fakes.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const utils = require(OUT("utils.js"));

check("shim is the module the adapter sees", vscode.__shim === shim, true);
check("LanguageModelTextPart comes from the shim", new vscode.LanguageModelTextPart("x").value, "x");
check("convertTools without tools → {}", JSON.stringify(utils.convertTools({})), "{}");
check("LanguageModelThinkingPart absent by default", vscode.LanguageModelThinkingPart, undefined);
shim.installThinkingPart();
check("installThinkingPart exposes the ctor", typeof vscode.LanguageModelThinkingPart, "function");
shim.removeThinkingPart();
check("removeThinkingPart hides it again", vscode.LanguageModelThinkingPart, undefined);
summary("adapter_smoke");
