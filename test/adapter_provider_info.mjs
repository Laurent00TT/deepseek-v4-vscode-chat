// Picker entries, token counting, and the secret-change reaction.
import { check, checkDeep, summary, until } from "./helpers/check.mjs";
import { vscode, shim, makeProvider, fakeSecrets, cancellation, userText } from "./helpers/fakes.mjs";

const IDS = ["deepseek-v4-pro::thinking", "deepseek-v4-pro", "deepseek-v4-flash::thinking", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp::thinking", "deepseek-v4-flash-vision-exp"];

async function main() {
	// --- with a key ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation().token);
		checkDeep("six entries in catalog order", infos.map((i) => i.id), IDS);
		check("family frozen", infos.every((i) => i.family === "deepseek-v4"), true);
		check("version frozen", infos.every((i) => i.version === "1.0.0"), true);
		check("toolCalling on all", infos.every((i) => i.capabilities.toolCalling === true), true);
		checkDeep("imageInput only on vision", infos.filter((i) => i.capabilities.imageInput).map((i) => i.id), ["deepseek-v4-flash-vision-exp::thinking", "deepseek-v4-flash-vision-exp"]);
		check("no warning icon with a key", infos.every((i) => i.statusIcon === undefined && i.detail === undefined), true);
		check("tooltip is the variant copy", infos[0].tooltip, "DeepSeek V4 Pro — strongest, extended thinking");
		check("budgets propagate", infos[0].maxInputTokens === 655360 && infos[0].maxOutputTokens === 393216, true);
		check("isUserSelectable", infos.every((i) => i.isUserSelectable === true), true);
		provider.dispose();
	}
	// --- without a key ---
	{
		shim.reset();
		const { provider } = makeProvider({ secrets: fakeSecrets({}) });
		const infos = await provider.prepareLanguageModelChatInformation({ silent: true }, cancellation().token);
		check("still six entries (discoverable)", infos.length, 6);
		check("warning icon", infos.every((i) => i.statusIcon instanceof vscode.ThemeIcon && i.statusIcon.id === "warning"), true);
		check("detail points at the Manage command", infos.every((i) => /Manage DeepSeek V4 Provider/.test(i.detail)), true);
		check("no input box during silent discovery", shim.calls.showInputBox.length, 0);
		provider.dispose();
	}
	// --- provideTokenCount ---
	{
		shim.reset();
		const { provider } = makeProvider();
		check("string: ceil(len / 3.0)", await provider.provideTokenCount({}, "abcdefg", cancellation().token), 3);
		const msg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("abcdefghi"), new vscode.LanguageModelDataPart(new Uint8Array(10), "image/png")] };
		check("message: text estimate + 384 per image", await provider.provideTokenCount({}, msg, cancellation().token), 3 + 384);
		provider.dispose();
	}
	// --- secret change → picker refresh + session reset + silent balance refresh ---
	{
		shim.reset();
		const { provider, secrets } = makeProvider();
		let fired = 0;
		provider.onDidChangeLanguageModelChatInformation(() => fired++);
		provider._sessionRequestCount = 5;
		secrets._emit("deepseekv4.apiKey");
		check("onDidChange fired", await until(() => fired === 1), true);
		check("session counter reset", provider._sessionRequestCount, 0);
		check("context usage cleared", provider.contextUsage.getSnapshot(), undefined);
		secrets._emit("some.other.key");
		check("unrelated secrets are ignored", fired, 1);
		provider.dispose();
	}
	summary("adapter_provider_info");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
