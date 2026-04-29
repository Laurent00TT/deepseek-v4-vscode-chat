// Blind quality scoring helper for experiment_chinese_reasoning.mjs.
//
// Reads the jsonl produced by the experiment, shuffles trials, hides the
// `condition` and `reasoning_content` fields, and prompts the scorer to rate
// each `content` (the model's final answer) on a 0-3 scale:
//
//   0 = answer is wrong (incorrect logic, broken code, factual error)
//   1 = answer is technically correct but misses a key point or is confusing
//   2 = answer is correct and complete
//   3 = correct, complete, AND demonstrates clear reasoning / good explanation
//
// Scores are saved to a sibling file with `.scores.json` suffix. Re-running
// resumes from where you stopped (skips already-scored trial IDs).
//
// Usage:
//   node test/score_blind.mjs <path-to-jsonl>
//
// To analyze scores against conditions afterwards, run:
//   node test/score_blind.mjs <path-to-jsonl> --analyze

import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const jsonlPath = args.find((a) => !a.startsWith("--"));
const ANALYZE = args.includes("--analyze");

if (!jsonlPath) {
	console.error("Usage: node test/score_blind.mjs <path-to-jsonl> [--analyze]");
	process.exit(1);
}

const scoresPath = jsonlPath.replace(/\.jsonl$/, ".scores.json");

async function loadJsonl(p) {
	const text = await fs.readFile(p, "utf8");
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

async function loadScores(p) {
	try {
		return JSON.parse(await fs.readFile(p, "utf8"));
	} catch {
		return {};
	}
}

async function saveScores(p, scores) {
	await fs.writeFile(p, JSON.stringify(scores, null, 2));
}

function trialKey(t) {
	return `${t.prompt_id}__${t.condition}__${t.rep}`;
}

function shuffle(arr, seed = 42) {
	// Deterministic shuffle so re-runs show trials in the same order.
	const a = [...arr];
	let s = seed;
	const rng = () => {
		s = (s * 16807) % 2147483647;
		return s / 2147483647;
	};
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

if (ANALYZE) {
	// Post-hoc analysis: align scores with conditions and report.
	const trials = await loadJsonl(jsonlPath);
	const scores = await loadScores(scoresPath);
	const byCondition = { A: [], B: [] };
	const byPromptCondition = {};
	let scored = 0, total = 0;
	for (const t of trials) {
		if (!t.ok) continue;
		total++;
		const k = trialKey(t);
		if (scores[k] === undefined) continue;
		scored++;
		byCondition[t.condition].push(scores[k]);
		const pk = `${t.prompt_id}__${t.condition}`;
		(byPromptCondition[pk] ||= []).push(scores[k]);
	}
	console.log(`Scored ${scored}/${total} trials.\n`);
	if (scored === 0) {
		console.log("No scores yet. Run without --analyze first to score blind.");
		process.exit(0);
	}

	const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
	const median = (xs) => {
		if (xs.length === 0) return 0;
		const sorted = [...xs].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	};

	console.log("=== Quality scores by condition ===");
	console.log(`A (baseline)      : n=${byCondition.A.length}, mean=${mean(byCondition.A).toFixed(2)}, median=${median(byCondition.A).toFixed(2)}`);
	console.log(`B (Chinese-steer) : n=${byCondition.B.length}, mean=${mean(byCondition.B).toFixed(2)}, median=${median(byCondition.B).toFixed(2)}`);
	const meanDelta = mean(byCondition.B) - mean(byCondition.A);
	const medDelta = median(byCondition.B) - median(byCondition.A);
	console.log(`Δ (B - A)          : Δmean=${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(2)}, Δmedian=${medDelta >= 0 ? "+" : ""}${medDelta.toFixed(2)}`);
	const meanA = mean(byCondition.A);
	const regressionPct = meanA > 0 ? (-meanDelta / meanA) * 100 : 0;
	console.log(`Quality regression : ${regressionPct >= 0 ? "+" : ""}${regressionPct.toFixed(1)}% (positive = B is worse)`);

	console.log("\n=== Per-prompt × condition ===");
	console.log("prompt_id           | A_mean | A_med | B_mean | B_med | Δmean");
	console.log("--------------------+--------+-------+--------+-------+-------");
	const promptIds = [...new Set(trials.map((t) => t.prompt_id))];
	for (const pid of promptIds) {
		const aScores = byPromptCondition[`${pid}__A`] || [];
		const bScores = byPromptCondition[`${pid}__B`] || [];
		if (aScores.length === 0 && bScores.length === 0) continue;
		const am = mean(aScores), amed = median(aScores), bm = mean(bScores), bmed = median(bScores);
		const d = bm - am;
		console.log(
			`${pid.padEnd(20)}| ${am.toFixed(2).padStart(6)} | ${amed.toFixed(2).padStart(5)} | ${bm.toFixed(2).padStart(6)} | ${bmed.toFixed(2).padStart(5)} | ${(d >= 0 ? "+" : "") + d.toFixed(2)}`,
		);
	}
	process.exit(0);
}

// ─── BLIND SCORING LOOP ──────────────────────────────────────────────────────

const trials = await loadJsonl(jsonlPath);
const scores = await loadScores(scoresPath);

// Filter to OK trials, shuffle deterministically, blind out condition.
const okTrials = trials.filter((t) => t.ok);
const shuffled = shuffle(okTrials);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log(`Total trials to score: ${shuffled.length}`);
console.log(`Already scored      : ${Object.keys(scores).length}`);
console.log("");
console.log("Scoring scale:");
console.log("  0 = wrong (incorrect logic, broken code, factual error)");
console.log("  1 = correct but missing a key point or confusing");
console.log("  2 = correct and complete");
console.log("  3 = correct, complete, AND clear reasoning / good explanation");
console.log("  s = skip this one for now");
console.log("  q = quit (progress is saved)");
console.log("");

let i = 0;
for (const t of shuffled) {
	i++;
	const k = trialKey(t);
	if (scores[k] !== undefined) continue; // already scored

	console.log("─".repeat(70));
	console.log(`[${i}/${shuffled.length}] trial id (blinded): ${shuffled.indexOf(t)}`);
	console.log(`prompt: ${t.prompt_id} (${t.prompt_lang}, ${t.prompt_task})`);
	console.log("");
	console.log("--- Final answer (blind to condition) ---");
	console.log(t.content || "(empty)");
	console.log("");

	const ans = (await ask("Score [0/1/2/3/s/q]: ")).trim();
	if (ans === "q") break;
	if (ans === "s") continue;
	const n = parseInt(ans, 10);
	if (![0, 1, 2, 3].includes(n)) {
		console.log(`Invalid input "${ans}", skipping.`);
		continue;
	}
	scores[k] = n;
	await saveScores(scoresPath, scores);
}

rl.close();
console.log(`\nSaved ${Object.keys(scores).length} scores to ${scoresPath}`);
console.log(`Run with --analyze to see results aligned with conditions.`);
