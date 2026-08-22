// activate(): command registration, provider registration, the Manage flow,
// first-run welcome, and the Copilot compact bridge.
import { createRequire } from "node:module";
import { check, checkDeep, checkMatch, summary, until } from "./helpers/check.mjs";
import { shim, OUT, fakeSecrets, fakeMemento, resetFetch, onFetch, jsonResponse, tick } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { activate, deactivate } = require(OUT("extension.js"));

function makeContext({ secrets, globalState } = {}) {
	return {
		subscriptions: [],
		secrets: secrets ?? fakeSecrets({}),
		globalState: globalState ?? fakeMemento(),
		extension: { packageJSON: { version: "9.9.9-test" } },
	};
}
function disposeAll(ctx) {
	for (const d of ctx.subscriptions) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}
}
const EXPECTED_COMMANDS = [
	"deepseekv4.showLog",
	"deepseekv4.refreshBalance",
	"deepseekv4.clearSession",
	"deepseekv4.clearReasoningCache",
	"deepseekv4.showContextWindow",
	"deepseekv4.compactCopilotChat",
	"deepseekv4.showCacheStats",
	"deepseekv4.manage",
];

async function main() {
	// --- registration ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		checkDeep("registers the command set (incl. unexposed showContextWindow)", [...shim.calls.registerCommand].sort(), [...EXPECTED_COMMANDS].sort());
		check("registers the LM provider under the frozen vendor", shim.calls.registerProvider[0]?.vendor, "deepseek-v4");
		check("status bar item created and bound to Show Log", shim.statusBarItems[0]?.command, "deepseekv4.showLog");
		checkMatch("boot line logs versions", shim.outputChannels[0]?.text(), /\[boot\] ext=9\.9\.9-test vscode=1\.106\.0-shim/);
		check("subscriptions collected for deactivate", ctx.subscriptions.length > 5, true);
		check("deactivate is a no-op function", typeof deactivate, "function");
		disposeAll(ctx);
	}
	// --- welcome: no key → walkthrough opened once, flag written ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		const opened = await until(() => shim.calls.executeCommand.some((c) => c.id === "workbench.action.openWalkthrough"));
		const open = shim.calls.executeCommand.find((c) => c.id === "workbench.action.openWalkthrough");
		check("walkthrough opened", opened, true);
		check("…with publisher.name#id", open?.args[0], "Laurent00TT.deepseek-v4-vscode-chat#deepseekv4GettingStarted");
		check("welcomeShown persisted", ctx.globalState.get("deepseekv4.welcomeShown"), true);
		disposeAll(ctx);
	}
	// --- welcome: existing key → no walkthrough, flag still written ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ secrets: fakeSecrets({ "deepseekv4.apiKey": "sk-existing" }) });
		activate(ctx);
		// The flag write is the last step of the returning-user branch, so waiting
		// for it also proves the branch ran to completion before we assert the negative.
		check("welcomeShown persisted anyway", await until(() => ctx.globalState.get("deepseekv4.welcomeShown") === true), true);
		check("no walkthrough for returning users", shim.calls.executeCommand.some((c) => c.id === "workbench.action.openWalkthrough"), false);
		disposeAll(ctx);
	}
	// --- welcome: already shown → nothing ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ globalState: fakeMemento({ "deepseekv4.welcomeShown": true }) });
		activate(ctx);
		// Nothing observable to wait for: the already-shown branch returns at its
		// first (synchronous) globalState.get, so one turn of the microtask/timer
		// queue is all the evidence there is. tick() is the honest fallback here.
		await tick();
		check("already-shown: no walkthrough", shim.calls.executeCommand.some((c) => c.id === "workbench.action.openWalkthrough"), false);
		disposeAll(ctx);
	}
	// --- Manage command ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext({ secrets: fakeSecrets({ "deepseekv4.apiKey": "sk-old" }) });
		activate(ctx);
		const manage = shim.registeredCommands.get("deepseekv4.manage");
		// cancel
		shim.answers.showInputBox = undefined;
		await manage();
		check("cancelled input box leaves the key", await ctx.secrets.get("deepseekv4.apiKey"), "sk-old");
		check("input box pre-fills the existing key", shim.calls.showInputBox.at(-1)?.value, "sk-old");
		// clear
		shim.answers.showInputBox = "   ";
		await manage();
		check("blank input clears the key", await ctx.secrets.get("deepseekv4.apiKey"), undefined);
		checkMatch("…and says so", shim.calls.showInformationMessage.at(-1)?.message, /API key cleared/);
		// validation failure → Cancel
		onFetch((u) => u.endsWith("/v1/models"), () => jsonResponse(401, {}));
		shim.answers.showInputBox = "sk-new";
		shim.answers.showWarningMessage = "Cancel";
		await manage();
		checkMatch("validation failure surfaced", shim.calls.showWarningMessage.at(-1)?.message, /validation failed: Invalid API key \(401/);
		check("…Cancel does not store", await ctx.secrets.get("deepseekv4.apiKey"), undefined);
		// validation failure → Save anyway
		shim.answers.showWarningMessage = "Save anyway";
		await manage();
		check("Save anyway stores the key", await ctx.secrets.get("deepseekv4.apiKey"), "sk-new");
		checkMatch("…with the 'without validation' note", shim.calls.showInformationMessage.at(-1)?.message, /saved \(without successful validation\)/);
		// validation success
		onFetch((u) => u.endsWith("/v1/models"), () => jsonResponse(200, { data: [] }));
		shim.answers.showInputBox = "sk-good";
		await manage();
		check("validated key stored", await ctx.secrets.get("deepseekv4.apiKey"), "sk-good");
		checkMatch("…validated message", shim.calls.showInformationMessage.at(-1)?.message, /validated and saved/);
		check("validation ran inside withProgress", shim.calls.withProgress.length >= 1, true);
		disposeAll(ctx);
	}
	// --- compact bridge ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		const compact = shim.registeredCommands.get("deepseekv4.compactCopilotChat");
		shim.answers.getCommands = [];
		await compact();
		checkMatch("without Copilot Chat: explains the requirement", shim.calls.showInformationMessage.at(-1)?.message, /Copilot Chat is required/);
		shim.answers.getCommands = ["github.copilot.chat.compact"];
		await compact();
		check("with Copilot Chat: forwards to github.copilot.chat.compact", shim.calls.executeCommand.some((c) => c.id === "github.copilot.chat.compact"), true);
		disposeAll(ctx);
	}
	// --- cache stats command renders a table and a summary toast ---
	{
		shim.reset();
		resetFetch();
		const ctx = makeContext();
		activate(ctx);
		await shim.registeredCommands.get("deepseekv4.showCacheStats")();
		checkMatch("stats table logged", shim.outputChannels[0]?.text(), /Reasoning Cache Stats[\s\S]*\| Entries \| 0 \/ 512 \|/);
		checkMatch("summary toast", shim.calls.showInformationMessage.at(-1)?.message, /Reasoning cache: 0 entries/);
		disposeAll(ctx);
	}
	summary("adapter_extension_activate");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
