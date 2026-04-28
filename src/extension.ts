import * as vscode from "vscode";
import { DeepSeekV4ChatModelProvider } from "./provider";

const EXT_ID = "deepseek-community.deepseek-v4-vscode-chat";
const SECRET_KEY = "deepseekv4.apiKey";
const MANAGE_COMMAND = "deepseekv4.manage";
const SHOW_LOG_COMMAND = "deepseekv4.showLog";
const REFRESH_BALANCE_COMMAND = "deepseekv4.refreshBalance";
const CLEAR_SESSION_COMMAND = "deepseekv4.clearSession";
const SHOW_CACHE_STATS_COMMAND = "deepseekv4.showCacheStats";
const VENDOR = "deepseek-v4";
const WELCOME_SHOWN_KEY = "deepseekv4.welcomeShown";
// publisher.name#walkthroughId — must match package.json's `publisher` and
// the `id` under `contributes.walkthroughs`.
const WALKTHROUGH_ID = "Laurent00TT.deepseek-v4-vscode-chat#deepseekv4GettingStarted";

const VALIDATE_URL = "https://api.deepseek.com/v1/models";

/**
 * Probe the DeepSeek API to confirm an API key is accepted before persisting it.
 * Returns null on success, or a short human-readable reason string on failure.
 */
async function validateApiKey(apiKey: string, userAgent: string): Promise<string | null> {
	try {
		const res = await fetch(VALIDATE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": userAgent },
		});
		if (res.ok) {
			return null;
		}
		if (res.status === 401) {
			return "Invalid API key (401 Unauthorized)";
		}
		if (res.status === 402) {
			return "Insufficient balance (402)";
		}
		if (res.status === 429) {
			return "Rate limited (429) — try again in a moment";
		}
		return `Unexpected ${res.status} ${res.statusText}`;
	} catch (e) {
		return `Network error: ${e instanceof Error ? e.message : String(e)}`;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const ext = vscode.extensions.getExtension(EXT_ID);
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `deepseek-v4-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("DeepSeek V4");
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`[boot] ext=${extVersion} vscode=${vscodeVersion}`);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = SHOW_LOG_COMMAND;
	context.subscriptions.push(statusBar);

	const provider = new DeepSeekV4ChatModelProvider(
		context.secrets,
		ua,
		outputChannel,
		context.globalState,
		statusBar,
	);
	vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);
	context.subscriptions.push({ dispose: () => provider.dispose() });

	context.subscriptions.push(
		vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => outputChannel.show()),
		vscode.commands.registerCommand(REFRESH_BALANCE_COMMAND, () => provider.refreshBalance()),
		vscode.commands.registerCommand(CLEAR_SESSION_COMMAND, () => provider.clearSession()),
		vscode.commands.registerCommand(SHOW_CACHE_STATS_COMMAND, () => {
			const stats = provider.getCacheStats();
			const hitPct = (stats.hitRate * 100).toFixed(1);
			const totalKB = (stats.totalBytes / 1024).toFixed(1);
			const largestKB = (stats.largestEntryBytes / 1024).toFixed(1);
			const maxObsKB = (stats.maxObservedEntryBytes / 1024).toFixed(1);
			const warnKB = (stats.entrySizeWarnBytes / 1024).toFixed(0);
			const totalWarnMB = (stats.totalBytesWarn / 1024 / 1024).toFixed(0);
			const totalMaxMB = (stats.totalBytesMax / 1024 / 1024).toFixed(0);
			const usagePct = stats.totalBytesMax > 0 ? ((stats.totalBytes / stats.totalBytesMax) * 100).toFixed(1) : "0";
			const msg = [
				`**DeepSeek V4 Reasoning Cache Stats**`,
				``,
				`| Metric | Value |`,
				`|--------|-------|`,
				`| Entries | ${stats.entryCount} / ${stats.maxEntries} |`,
				`| Total size | ${totalKB} KB (${usagePct}% of ${totalMaxMB} MB max) |`,
				`| Size warn / max | ${totalWarnMB} MB / ${totalMaxMB} MB |`,
				`| Largest entry | ${largestKB} KB (fp: \`${stats.largestEntryFp.slice(0, 16)}…\`) |`,
				`| Max observed | ${maxObsKB} KB (fp: \`${stats.maxObservedEntryFp.slice(0, 16)}…\`) |`,
				`| Entry warn | ${warnKB} KB |`,
				`| Sets / Gets | ${stats.totalSets} / ${stats.totalGets} |`,
				`| Hits / Misses | ${stats.totalHits} / ${stats.totalMisses} |`,
				`| Hit rate | ${hitPct}% |`,
				`| Evictions | ${stats.totalEvictions} |`,
			].join("\n");
			outputChannel.appendLine("");
			outputChannel.appendLine(msg);
			outputChannel.show();

			// Also show a brief summary notification
			const summary = `Reasoning cache: ${stats.entryCount} entries, ${totalKB} KB, ${hitPct}% hit rate`;
			if (stats.totalMisses > 0 && stats.hitRate < 0.5) {
				vscode.window.showWarningMessage(
					`${summary} — low hit rate may cause 400 errors in multi-turn conversations. Try starting a new chat.`,
				);
			} else {
				vscode.window.showInformationMessage(summary);
			}
		}),
		vscode.commands.registerCommand(MANAGE_COMMAND, async () => {
			const existing = await context.secrets.get(SECRET_KEY);
			const apiKey = await vscode.window.showInputBox({
				title: "DeepSeek API Key",
				prompt: existing ? "Update your DeepSeek API key" : "Enter your DeepSeek API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return;
			}
			const trimmed = apiKey.trim();
			if (!trimmed) {
				await context.secrets.delete(SECRET_KEY);
				vscode.window.showInformationMessage("DeepSeek API key cleared.");
				return;
			}

			const validating = vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "Validating DeepSeek API key…" },
				async () => validateApiKey(trimmed, ua),
			);
			const failureReason = await validating;

			if (failureReason !== null) {
				const choice = await vscode.window.showWarningMessage(
					`API key validation failed: ${failureReason}`,
					{ modal: false },
					"Save anyway",
					"Cancel",
				);
				if (choice !== "Save anyway") {
					return;
				}
			}

			await context.secrets.store(SECRET_KEY, trimmed);
			vscode.window.showInformationMessage(
				failureReason === null
					? "DeepSeek API key validated and saved."
					: "DeepSeek API key saved (without successful validation).",
			);
		}),
	);

	// First-run UX: open the walkthrough if the user hasn't seen it AND
	// hasn't already configured a key. Fire-and-forget so activation isn't
	// blocked on the welcome flow; failures (e.g. unknown walkthrough id
	// during dev) just log and don't break the extension.
	void showWelcomeIfNeeded(context, outputChannel);
}

async function showWelcomeIfNeeded(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): Promise<void> {
	try {
		if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
			return;
		}
		const existingKey = await context.secrets.get(SECRET_KEY);
		if (existingKey) {
			// Returning user with a configured key — don't shove a walkthrough
			// at them, just remember we don't need to show it again.
			await context.globalState.update(WELCOME_SHOWN_KEY, true);
			return;
		}
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			WALKTHROUGH_ID,
			false,
		);
		await context.globalState.update(WELCOME_SHOWN_KEY, true);
	} catch (e) {
		output.appendLine(`[welcome] failed to open walkthrough: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function deactivate() {}
