// Pins the package.json contract and the persisted identifiers baked into
// the compiled output: vendor, command ids/titles, settings, engines,
// walkthrough id, SecretStorage/globalState keys. These are user-visible or
// user-persisted; renaming any of them breaks picker selections, keybindings
// or stored state on upgrade (CONTRIBUTING red line #2).
//
//     npm test
import { readFileSync } from "node:fs";
import { check, checkDeep, summary } from "./helpers/check.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionJs = readFileSync(new URL("../out/extension.js", import.meta.url), "utf8");
const providerJs = readFileSync(new URL("../out/provider.js", import.meta.url), "utf8");

// --- identity ---
check("name", pkg.name, "deepseek-v4-vscode-chat");
check("publisher", pkg.publisher, "Laurent00TT");
check("engines.vscode floor", pkg.engines.vscode, "^1.106.0");
check("main entry", pkg.main, "./out/extension.js");
check("zero runtime dependencies", Object.keys(pkg.dependencies ?? {}).length, 0);

// --- provider contribution ---
const providers = pkg.contributes.languageModelChatProviders;
check("one LM provider contributed", providers.length, 1);
check("vendor is frozen", providers[0].vendor, "deepseek-v4");
check("management command", providers[0].managementCommand, "deepseekv4.manage");
check("provider registers the same vendor in code", extensionJs.includes('"deepseek-v4"'), true);

// --- commands ---
checkDeep(
	"contributed commands (id → title)",
	pkg.contributes.commands.map((c) => [c.command, c.title]),
	[
		["deepseekv4.manage", "Manage DeepSeek V4 Provider"],
		["deepseekv4.showLog", "Show DeepSeek V4 Log"],
		["deepseekv4.refreshBalance", "Refresh DeepSeek V4 Balance"],
		["deepseekv4.clearSession", "Clear DeepSeek V4 Session Counter"],
		["deepseekv4.showCacheStats", "Show DeepSeek V4 Reasoning Cache Stats"],
		["deepseekv4.clearReasoningCache", "Clear DeepSeek V4 Reasoning Cache"],
		["deepseekv4.compactCopilotChat", "Compact Copilot Chat"],
	],
);
check("no command carries a category (palette shows the bare title)", pkg.contributes.commands.every((c) => c.category === undefined), true);
for (const id of [...pkg.contributes.commands.map((c) => c.command), "deepseekv4.showContextWindow"]) {
	check(`extension.js registers ${id}`, extensionJs.includes(`"${id}"`), true);
}

// --- settings ---
const props = pkg.contributes.configuration.properties;
checkDeep("settings keys", Object.keys(props).sort(), ["deepseekv4.logRawReasoning", "deepseekv4.reasoningEffort"]);
checkDeep("reasoningEffort enum", props["deepseekv4.reasoningEffort"].enum, ["high", "max"]);
check("reasoningEffort default", props["deepseekv4.reasoningEffort"].default, "max");
check("logRawReasoning type", props["deepseekv4.logRawReasoning"].type, "boolean");
check("logRawReasoning default", props["deepseekv4.logRawReasoning"].default, false);

// --- persisted keys baked into the compiled output ---
check("SecretStorage key", extensionJs.includes('"deepseekv4.apiKey"') && providerJs.includes('"deepseekv4.apiKey"'), true);
check("globalState key: reasoning cache", providerJs.includes('"deepseekv4.reasoningCache"'), true);
check("globalState key: welcome shown", extensionJs.includes('"deepseekv4.welcomeShown"'), true);

// --- walkthrough ---
const wt = pkg.contributes.walkthroughs[0];
check("walkthrough id", wt.id, "deepseekv4GettingStarted");
check("extension.js opens publisher.name#id", extensionJs.includes(`"${pkg.publisher}.${pkg.name}#${wt.id}"`), true);
checkDeep("walkthrough steps", wt.steps.map((s) => s.id), ["setApiKey", "pickModel", "tuneReasoningEffort"]);

// --- packaging hygiene ---
const vscodeignore = readFileSync(new URL("../.vscodeignore", import.meta.url), "utf8");
for (const line of ["src/**", "test/**", ".claude/**", ".superpowers/**", ".c8rc.json", ".git-blame-ignore-revs", "**/*.map"]) {
	check(`.vscodeignore excludes ${line}`, vscodeignore.split(/\r?\n/).includes(line), true);
}
summary("unit_manifest");
