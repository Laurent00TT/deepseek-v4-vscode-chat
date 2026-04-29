// Pre-registered experiment for issue #2: does injecting a "think in Chinese"
// system prompt actually steer DS V4's reasoning_content language, save tokens,
// and not regress quality?
//
// PRE-REGISTERED DECISION MATRIX (locked before running, do NOT modify after).
// Applied INDEPENDENTLY to each non-baseline condition vs A:
//
//   Compliance       Token saving    Quality reg.   Decision
//   ─────────────    ────────────    ───────────    ────────────────────
//   <50% Chinese     any             any            REJECT (instruction ignored)
//   ≥50% Chinese     <10%            any            REJECT (no tangible benefit)
//   ≥50% Chinese     ≥10%            >20%           REJECT (quality loss)
//   ≥70% Chinese     ≥20%            ≤10%           ACCEPT (implement opt-in)
//   anything else                                   INCONCLUSIVE (close with report)
//
// Definitions (X = the condition being evaluated, e.g. B or C):
//   - "Compliance"  := mean ratio of Chinese characters in reasoning_content
//                     across the 50 condition-X trials (5 prompts × 10 reps).
//   - "Token saving" := (mean_A_reasoning_tokens - mean_X_reasoning_tokens)
//                       / mean_A_reasoning_tokens, averaged across prompts.
//   - "Quality reg." := mean drop in 0-3 quality score from A to X, scored
//                       MANUALLY after the run, blind to condition.
//
// CONDITIONS:
//   - A: baseline, only Copilot-like English system prompt
//   - B: A + English-language Chinese-steering prompt prepended (issue #2 verbatim)
//   - C: A + Chinese-language Chinese-steering prompt prepended (v3 ablation:
//        does the LANGUAGE of the steering instruction matter?)
//
// What this experiment does NOT control for:
//   - The exact text of Copilot Chat's real system prompt is closed-source;
//     we use a representative approximation. A different real prompt may
//     change the absolute numbers but should not flip the comparison.
//   - N=10 reps × 5 prompts (= 50 trials per condition) handles within-cell
//     model randomness; cross-prompt generalization is bounded by 5 prompts.
//     Effect sizes <5pp at the per-prompt level are within noise.
//   - DS server-side reasoning_effort heuristics are opaque; we lock
//     reasoning_effort="max" to make this irrelevant.
//   - Quality scoring is performed by the same person who wrote the analysis,
//     introducing potential bias. Mitigations: (a) blind to condition via the
//     score_blind.mjs helper, (b) raw jsonl preserved for re-scoring by anyone.
//   - Steering position is fixed (system prompt, before Copilot baseline);
//     "user message" placement is not tested.

import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("Missing DEEPSEEK_API_KEY");
	process.exit(1);
}

// ─── EXPERIMENTAL VARIABLES ──────────────────────────────────────────────────

// Approximation of Copilot Chat's system prompt. The real one is closed-source;
// we don't have it verbatim. This stays consistent across BOTH conditions A and B
// so it doesn't confound the comparison.
const COPILOT_LIKE_SYSTEM =
	"You are an AI programming assistant. Follow the user's requirements carefully and to the letter. First think step-by-step about the request before responding. Respond with technically accurate, concise answers.";

// Verbatim from issue #2 author's proposal. We test their exact text — not a
// "fixed" version — so the result reflects their actual proposal.
const CHINESE_STEERING_EN =
	"You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese.";

// v3 ablation: same intent, but written in Chinese. Tests whether the
// language of the steering instruction itself matters — many models respond
// more reliably to instructions in the target language. The semantic content
// is a faithful Chinese translation of CHINESE_STEERING_EN.
const CHINESE_STEERING_ZH =
	"你必须用简体中文进行内部思考和推理。所有思维链、规划、分析、自我反思以及工具使用的决策都必须用中文进行。";

const PROMPTS = [
	{
		id: "p1_en_coding",
		lang: "en",
		task: "coding",
		content: "Write a Python function `merge_sort(arr)` that sorts a list using the merge sort algorithm. Include a brief explanation of how it works.",
	},
	{
		id: "p2_zh_coding",
		lang: "zh",
		task: "coding",
		content: "用 Python 实现二分查找算法。函数签名 `binary_search(arr, target)`,接受一个有序数组和目标值,返回索引或 -1。",
	},
	{
		id: "p3_en_debug",
		lang: "en",
		task: "debug",
		content: "This Python function has a bug. Find it and explain what's wrong:\n```python\ndef factorial(n):\n    if n == 0:\n        return 0\n    return n * factorial(n-1)\n```",
	},
	{
		id: "p4_zh_refactor",
		lang: "zh",
		task: "refactor",
		content: "下面这段代码可以怎么改进?\n```python\ndef get_user(user_id):\n    users = load_users()\n    for u in users:\n        if u['id'] == user_id:\n            return u\n    return None\n```",
	},
	{
		id: "p5_zh_concept",
		lang: "zh",
		task: "concept",
		content: "解释一下 LSM-tree 的核心思想,和 B-tree 相比在写入性能上有什么优势,代价是什么?",
	},
];

const N_REPS = 10;
const QUICK = process.argv.includes("--quick");
const ACTUAL_REPS = QUICK ? 2 : N_REPS;

// ─── API CALL ────────────────────────────────────────────────────────────────

async function callDS(messages) {
	const body = {
		model: "deepseek-v4-pro",
		stream: false,
		max_tokens: 16384,           // generous; we want to see full reasoning
		thinking: { type: "enabled" },
		reasoning_effort: "max",     // lock to max so any difference is from steering, not effort heuristics
		messages,
	};
	const t0 = Date.now();
	let res;
	try {
		res = await fetch("https://api.deepseek.com/v1/chat/completions", {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (e) {
		return { ok: false, status: 0, body: `network: ${e.message}`, elapsed: Date.now() - t0 };
	}
	const elapsed = Date.now() - t0;
	if (!res.ok) {
		const text = await res.text();
		return { ok: false, status: res.status, body: text.slice(0, 500), elapsed };
	}
	const data = await res.json();
	const choice = data.choices?.[0]?.message;
	return {
		ok: true,
		elapsed,
		reasoning_content: choice?.reasoning_content ?? "",
		content: choice?.content ?? "",
		usage: data.usage ?? {},
		finish_reason: data.choices?.[0]?.finish_reason,
	};
}

// ─── METRICS ─────────────────────────────────────────────────────────────────

/** Ratio of CJK Unified Ideographs (basic block) over total characters.
 *  Excludes whitespace and punctuation from the denominator to avoid penalizing
 *  Chinese text that happens to contain English code identifiers. */
function chineseCharRatio(text) {
	if (!text) return 0;
	// Strip whitespace and ASCII punctuation; count what remains.
	const meaningful = [...text].filter((ch) => !/[\s\p{P}]/u.test(ch));
	if (meaningful.length === 0) return 0;
	const chinese = meaningful.filter((ch) => /[一-龥]/.test(ch)).length;
	return chinese / meaningful.length;
}

// ─── ONE TRIAL ───────────────────────────────────────────────────────────────

async function runOne(prompt, condition, rep) {
	const messages = [];
	// Condition A = no steering (baseline)
	// Condition B = English-language steering instruction (issue #2 author's verbatim proposal)
	// Condition C = Chinese-language steering instruction (v3 ablation)
	if (condition === "B") {
		messages.push({ role: "system", content: CHINESE_STEERING_EN });
	} else if (condition === "C") {
		messages.push({ role: "system", content: CHINESE_STEERING_ZH });
	}
	messages.push({ role: "system", content: COPILOT_LIKE_SYSTEM });
	messages.push({ role: "user", content: prompt.content });

	const result = await callDS(messages);

	const reasoning = result.reasoning_content || "";
	const content = result.content || "";
	const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

	return {
		prompt_id: prompt.id,
		prompt_lang: prompt.lang,
		prompt_task: prompt.task,
		condition,
		rep,
		ok: result.ok,
		status: result.ok ? 200 : result.status,
		error_body: result.ok ? null : result.body,
		finish_reason: result.finish_reason ?? null,
		elapsed_ms: result.elapsed,
		reasoning_chars: reasoning.length,
		reasoning_zh_ratio: chineseCharRatio(reasoning),
		reasoning_tokens: reasoningTokens,
		prompt_tokens: result.usage?.prompt_tokens ?? 0,
		completion_tokens: result.usage?.completion_tokens ?? 0,
		cache_hit_tokens: result.usage?.prompt_cache_hit_tokens ?? 0,
		cache_miss_tokens: result.usage?.prompt_cache_miss_tokens ?? 0,
		content_zh_ratio: chineseCharRatio(content),
		// Save raw text for human quality scoring (post-hoc, blind).
		reasoning_content: reasoning,
		content,
	};
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function main() {
	const results = [];
	const CONDITIONS = ["A", "B", "C"];
	const totalCalls = PROMPTS.length * CONDITIONS.length * ACTUAL_REPS;
	let i = 0;

	console.log(`Running experiment: ${PROMPTS.length} prompts × ${CONDITIONS.length} conditions × ${ACTUAL_REPS} reps = ${totalCalls} calls`);
	console.log(`Conditions: A=baseline, B=English steering (issue #2 verbatim), C=Chinese steering (v3 ablation)`);
	console.log(`Mode: ${QUICK ? "QUICK (smoke test)" : "FULL"}`);
	console.log("");

	for (const prompt of PROMPTS) {
		// Interleave A/B/C reps for each prompt to spread temporal effects
		// (e.g., DS server load drift) evenly across conditions.
		for (let rep = 1; rep <= ACTUAL_REPS; rep++) {
			for (const condition of CONDITIONS) {
				i++;
				process.stdout.write(`[${i.toString().padStart(3)}/${totalCalls}] ${prompt.id.padEnd(18)} cond=${condition} rep=${rep} ... `);
				const result = await runOne(prompt, condition, rep);
				results.push(result);
				if (result.ok) {
					console.log(
						`reasoning=${result.reasoning_tokens.toString().padStart(5)}t  zh=${(result.reasoning_zh_ratio * 100).toFixed(0).padStart(3)}%  ${result.elapsed_ms}ms`,
					);
				} else {
					console.log(`FAILED status=${result.status} ${result.error_body?.slice(0, 100)}`);
				}
				// Small delay to be kind to the API; not strictly required.
				await new Promise((r) => setTimeout(r, 800));
			}
		}
	}

	// ─── SAVE RAW DATA ──────────────────────────────────────────────────────

	const outDir = path.join(import.meta.dirname ?? "test", "data");
	await fs.mkdir(outDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outFile = path.join(outDir, `experiment_chinese_reasoning_${ts}${QUICK ? "_quick" : ""}.jsonl`);
	await fs.writeFile(outFile, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
	console.log(`\nRaw data saved to: ${outFile}\n`);

	// ─── SUMMARY STATS ──────────────────────────────────────────────────────

	function median(arr) {
		if (arr.length === 0) return 0;
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	}
	function quantile(arr, q) {
		if (arr.length === 0) return 0;
		const sorted = [...arr].sort((a, b) => a - b);
		const pos = (sorted.length - 1) * q;
		const base = Math.floor(pos);
		const rest = pos - base;
		return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
	}

	const rows = [];
	rows.push("=== Per-prompt summary (median over reps, OK trials only) ===\n");
	rows.push("prompt_id           | A_med  | B_med  |   Δmed%  | dir | A_zh%  | B_zh%  | A_pt | B_pt");
	rows.push("--------------------+--------+--------+----------+-----+--------+--------+------+-----");
	const perPromptDeltas = [];
	let directionAgreement = 0;
	for (const prompt of PROMPTS) {
		const a = results.filter((r) => r.prompt_id === prompt.id && r.condition === "A" && r.ok);
		const b = results.filter((r) => r.prompt_id === prompt.id && r.condition === "B" && r.ok);
		if (a.length === 0 || b.length === 0) {
			rows.push(`${prompt.id.padEnd(20)}| (incomplete data)`);
			continue;
		}
		const aTokens = a.map((r) => r.reasoning_tokens);
		const bTokens = b.map((r) => r.reasoning_tokens);
		const medA = median(aTokens);
		const medB = median(bTokens);
		const delta = medA > 0 ? ((medB - medA) / medA) * 100 : 0;
		perPromptDeltas.push(delta);
		if (delta < 0) directionAgreement++; // B saved tokens for this prompt
		const dir = delta < -10 ? "B<<" : delta < 0 ? "B<" : delta < 10 ? "≈" : "B>";
		const zhA = (a.reduce((s, r) => s + r.reasoning_zh_ratio, 0) / a.length) * 100;
		const zhB = (b.reduce((s, r) => s + r.reasoning_zh_ratio, 0) / b.length) * 100;
		const ptA = median(a.map((r) => r.prompt_tokens));
		const ptB = median(b.map((r) => r.prompt_tokens));
		rows.push(
			`${prompt.id.padEnd(20)}| ${medA.toFixed(0).padStart(6)} | ${medB.toFixed(0).padStart(6)} | ${(delta >= 0 ? "+" : "") + delta.toFixed(1) + "%"} | ${dir.padStart(3)} | ${zhA.toFixed(0).padStart(5)}% | ${zhB.toFixed(0).padStart(5)}% | ${ptA.toFixed(0).padStart(4)} | ${ptB.toFixed(0).padStart(4)}`,
		);
	}

	// ─── PER-CELL VARIANCE TABLE ────────────────────────────────────────────

	rows.push("");
	rows.push("=== Per-cell variance (reasoning_tokens, IQR = 25th-75th percentile) ===\n");
	rows.push("prompt_id           | cond | n  | min   | p25   | med   | p75   | max   | mean");
	rows.push("--------------------+------+----+-------+-------+-------+-------+-------+------");
	for (const prompt of PROMPTS) {
		for (const condition of ["A", "B"]) {
			const cell = results.filter((r) => r.prompt_id === prompt.id && r.condition === condition && r.ok);
			if (cell.length === 0) continue;
			const tokens = cell.map((r) => r.reasoning_tokens);
			const sorted = [...tokens].sort((a, b) => a - b);
			const mean = tokens.reduce((s, x) => s + x, 0) / tokens.length;
			rows.push(
				`${prompt.id.padEnd(20)}| ${condition.padEnd(5)}| ${cell.length.toString().padStart(2)} | ${sorted[0].toString().padStart(5)} | ${quantile(tokens, 0.25).toFixed(0).padStart(5)} | ${median(tokens).toFixed(0).padStart(5)} | ${quantile(tokens, 0.75).toFixed(0).padStart(5)} | ${sorted[sorted.length - 1].toString().padStart(5)} | ${mean.toFixed(0).padStart(5)}`,
			);
		}
	}

	// ─── OVERALL ─────────────────────────────────────────────────────────────

	const overallMedianDelta = median(perPromptDeltas);
	const overallMeanDelta = perPromptDeltas.reduce((s, x) => s + x, 0) / Math.max(1, perPromptDeltas.length);
	const allATokens = results.filter((r) => r.condition === "A" && r.ok).map((r) => r.reasoning_tokens);
	const allBTokens = results.filter((r) => r.condition === "B" && r.ok).map((r) => r.reasoning_tokens);
	const allAZh = results.filter((r) => r.condition === "A" && r.ok).map((r) => r.reasoning_zh_ratio);
	const allBZh = results.filter((r) => r.condition === "B" && r.ok).map((r) => r.reasoning_zh_ratio);
	rows.push("");
	rows.push("=== Overall ===");
	rows.push(`  All A trials  : n=${allATokens.length}, median reasoning_tokens=${median(allATokens).toFixed(0)}, median zh%=${(median(allAZh) * 100).toFixed(0)}%`);
	rows.push(`  All B trials  : n=${allBTokens.length}, median reasoning_tokens=${median(allBTokens).toFixed(0)}, median zh%=${(median(allBZh) * 100).toFixed(0)}%`);
	rows.push(`  Per-prompt Δ% : median=${(overallMedianDelta >= 0 ? "+" : "") + overallMedianDelta.toFixed(1)}%, mean=${(overallMeanDelta >= 0 ? "+" : "") + overallMeanDelta.toFixed(1)}%`);
	rows.push(`  Direction     : ${directionAgreement}/${perPromptDeltas.length} prompts had B<A on reasoning_tokens (sign test for token reduction)`);

	const summary = rows.join("\n");
	console.log(summary);
	console.log("");
	console.log("Notes:");
	console.log("  - Δmed% = (median_B - median_A) / median_A × 100. Negative means B (steered) used FEWER tokens.");
	console.log("  - 'dir' column: B<< = >10% reduction, B< = any reduction, ≈ = ±10%, B> = increase.");
	console.log("  - zh% = ratio of CJK characters in reasoning_content (whitespace/punctuation excluded).");
	console.log("  - p25/p75 columns show within-cell variance — if these overlap heavily across A/B,");
	console.log("    the difference is likely noise even if the medians look different.");
	console.log("");
	console.log("Quality scoring (NOT in this script — manual post-hoc):");
	console.log("  Run: node test/score_blind.mjs <jsonl-file>");
	console.log("  This shows `content` field shuffled and blind to condition. Score 0-3.");
	console.log("");
	console.log("Decision: apply pre-registered matrix at the top of this file.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
