// Structure of the status-bar hover tooltip.
//
// The tooltip is assembled by appending markdown fragments, several of which
// are conditional. Horizontal rules separate its sections, so a section that
// renders nothing leaves its two neighbouring rules adjacent — a visible
// double line with nothing between it. That is what happened to the cache-hit
// section, which only has content once a turn has reported usage.
//
// The regression-suite design named this file
// (docs/superpowers/specs/2026-08-22-regression-test-suite-design.md) under a
// heading titled "P2 — optional" and it was never written.

import { check, summary } from "./helpers/check.mjs";
import { makeProvider, onFetch, balanceJson, jsonResponse } from "./helpers/fakes.mjs";

/** Every section boundary the tooltip draws, in order. */
const rules = (md) => (md.match(/^---$/gm) ?? []).length;
/** Two rules with only blank lines between them. */
const hasEmptySection = (md) => /^---\s*\n\s*\n?---$/m.test(md.replace(/\r\n/g, "\n"));

const stubBalance = () =>
	onFetch(
		() => true,
		() => jsonResponse(200, balanceJson(42.5))
	);

// `makeProvider` calls `resetFetch()`, so the stub is registered after it.
// The tooltip is rebuilt only by `refreshStatusBar()`, which is private;
// `refreshBalance` is the public path that reaches it. Seed first, refresh
// second, then read.
const seedUsage = (provider, { promptTokens, cacheHitTokens }) =>
	provider.contextUsage.updateFromApi({
		modelId: "deepseek-v4-pro",
		modelDisplayName: "DeepSeek V4 Pro",
		thinking: true,
		maxInputTokens: 655360,
		maxOutputTokens: 393216,
		apiPromptTokens: promptTokens,
		apiCompletionTokens: 100,
		apiCacheHitTokens: cacheHitTokens,
	});

async function main() {
	// --- no key, no balance, no turns: the emptiest tooltip there is ---
	{
		const { provider, statusBar } = makeProvider();
		const md = statusBar.tooltip.value;
		check("renders a header", md.includes("### DeepSeek V4"), true);
		check("offers the balance fetch", md.includes("click to fetch"), true);
		check("no section is drawn empty", hasEmptySection(md), false);
		check("one rule separates balance from settings", rules(md), 1);
		provider.dispose();
	}

	// --- balance fetched, still no turns: the cache section has nothing to say ---
	{
		const { provider, statusBar } = makeProvider();
		stubBalance();
		await provider.refreshBalance(true);
		const md = statusBar.tooltip.value;
		check("shows the balance", md.includes("¥42.50"), true);
		check("no cache row before any turn", md.includes("Cache hit"), false);
		check("still no empty section", hasEmptySection(md), false);
		check("still one rule", rules(md), 1);
		provider.dispose();
	}

	// --- a turn has reported usage: the cache section earns its rules ---
	{
		const { provider, statusBar } = makeProvider();
		stubBalance();
		seedUsage(provider, { promptTokens: 1000, cacheHitTokens: 800 });
		await provider.refreshBalance(true);
		const md = statusBar.tooltip.value;
		check("cache row appears", md.includes("Cache hit (last turn)"), true);
		check("reports the hit rate", md.includes("80.0%"), true);
		check("the section is fenced by two rules", rules(md), 2);
		check("and neither is empty", hasEmptySection(md), false);
		provider.dispose();
	}

	// --- a turn with a 0% hit rate still counts as content ---
	// `apiCacheHitTokens: 0` is a real measurement, not a missing one, and the
	// row says so. Guarding the rule on truthiness rather than presence would
	// drop it.
	{
		const { provider, statusBar } = makeProvider();
		stubBalance();
		seedUsage(provider, { promptTokens: 1000, cacheHitTokens: 0 });
		await provider.refreshBalance(true);
		const md = statusBar.tooltip.value;
		check("0% hit rate still renders a row", md.includes("Cache hit (last turn)"), true);
		check("0% is shown, not hidden", md.includes("0.0%"), true);
		check("no empty section at 0%", hasEmptySection(md), false);
		provider.dispose();
	}

	summary("adapter_status_tooltip");
}

await main();
