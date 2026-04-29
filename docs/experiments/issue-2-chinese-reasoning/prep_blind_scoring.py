"""Prepare blind quality scoring sample.

Reads the experiment jsonl, takes a stratified random sample (n_per_condition
trials per condition), sanitizes (strips condition / reasoning_content / rep
metadata), shuffles deterministically by trial_index, and writes a markdown
file showing only the user prompt + model's answer.

The scorer reads that markdown, fills in scores 0-3 for each trial, and saves
to scores_blind.json (keyed by the anonymous trial_index).

Then run analyze_blind_scores.py to join scores back with conditions.

Usage:
    python prep_blind_scoring.py <jsonl-path> [--per-condition N]
"""
import json
import sys
import random
from pathlib import Path
from collections import defaultdict


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a: True for a in sys.argv[1:] if a.startswith("--")}
    if len(args) < 1:
        print("Usage: python prep_blind_scoring.py <jsonl-path> [--per-condition N]")
        sys.exit(1)
    jsonl_path = Path(args[0])
    n_per_cond = int(args[1]) if len(args) > 1 else 10

    with jsonl_path.open(encoding="utf-8") as f:
        trials = [json.loads(l) for l in f if l.strip()]

    ok_trials = [t for t in trials if t["ok"]]
    print(f"Loaded {len(trials)} trials, {len(ok_trials)} OK")

    # Stratified sample: n_per_cond per condition.
    # Within each condition, balance across prompts (so quality is judged
    # across the full prompt distribution, not just one task type).
    by_cond_prompt = defaultdict(list)
    for t in ok_trials:
        by_cond_prompt[(t["condition"], t["prompt_id"])].append(t)

    rng = random.Random(42)
    sampled = []
    for cond in sorted({t["condition"] for t in ok_trials}):
        prompts = sorted({t["prompt_id"] for t in ok_trials})
        per_prompt = max(1, n_per_cond // len(prompts))  # 2 if n=10 and 5 prompts
        leftover = n_per_cond - per_prompt * len(prompts)
        for pid in prompts:
            cell = by_cond_prompt.get((cond, pid), [])
            sample = rng.sample(cell, min(per_prompt, len(cell)))
            sampled.extend(sample)
        # If n_per_cond doesn't divide evenly, add leftover from any cells
        if leftover > 0:
            extras = [t for t in ok_trials if t["condition"] == cond and t not in sampled]
            sampled.extend(rng.sample(extras, min(leftover, len(extras))))

    # Anonymize and shuffle
    anonymized = []
    for i, t in enumerate(sampled):
        # Look up the original prompt content from the trials data — the trial
        # itself doesn't carry the prompt text, only prompt_id. We need to
        # reconstruct from the experiment script. For now, find the user
        # message by re-reading from a sister source. Simplest: include the
        # prompt content from a fresh lookup by prompt_id.
        anonymized.append({
            "trial_index": i,  # anonymous index, not original rep
            "prompt_id": t["prompt_id"],  # keep this so we can show the question
            "model_answer": t.get("content", ""),
            "_source_key": f"{t['prompt_id']}__{t['condition']}__{t['rep']}",  # for joining later
        })
    rng.shuffle(anonymized)
    # After shuffle, re-number by position
    for new_i, item in enumerate(anonymized):
        item["trial_index"] = new_i

    # Write the blind file (with prompt_id but NO condition, NO rep, NO reasoning)
    blind_dir = jsonl_path.parent
    blind_path = blind_dir / "blind_scoring_sample.md"
    key_path = blind_dir / "blind_scoring_key.json"

    # Need the prompt content. Re-read the experiment script to extract it.
    script_path = blind_dir.parent / "issue-2-chinese-reasoning" / "experiment_chinese_reasoning.mjs"
    if not script_path.exists():
        script_path = jsonl_path.parent.parent / "experiment_chinese_reasoning.mjs"
    prompts_lookup = {}
    if script_path.exists():
        # Crude extraction: find PROMPTS = [ ... ];
        text = script_path.read_text(encoding="utf-8")
        # Just walk objects with id: "pX_..."
        import re
        # Match { id: "pX_...", ..., content: "...", }, with content possibly multiline
        pattern = re.compile(r'\{\s*id:\s*"(p\d_[a-z_]+)"[^}]*?content:\s*"((?:[^"\\]|\\.)*)"', re.S)
        for m in pattern.finditer(text):
            pid = m.group(1)
            raw = m.group(2)
            # Unescape \n \\ etc
            unescaped = raw.encode().decode("unicode_escape")
            prompts_lookup[pid] = unescaped

    md_lines = [
        "# Blind quality scoring sample\n",
        f"\nSampled {len(anonymized)} trials ({n_per_cond} per condition × balanced across prompts), shuffled deterministically.\n",
        "\n## Rubric\n",
        "- **0** = wrong (incorrect logic, broken code, factual error)\n",
        "- **1** = correct but missing a key point or confusing\n",
        "- **2** = correct and complete\n",
        "- **3** = correct, complete, AND clear reasoning / good explanation\n",
        "\n## Trials\n",
    ]
    for item in anonymized:
        pid = item["prompt_id"]
        prompt_text = prompts_lookup.get(pid, "(prompt content not extracted)")
        md_lines.append(f"\n### Trial {item['trial_index']}  (task: {pid.split('_', 1)[1] if '_' in pid else pid})\n")
        md_lines.append(f"\n**User question**:\n\n```\n{prompt_text}\n```\n")
        md_lines.append(f"\n**Model's answer**:\n\n{item['model_answer']}\n")
        md_lines.append(f"\n**Score**: _\n")
        md_lines.append("\n---\n")
    blind_path.write_text("".join(md_lines), encoding="utf-8")

    # Save the key (mapping trial_index → source_key) for later joining
    key_data = {item["trial_index"]: item["_source_key"] for item in anonymized}
    key_path.write_text(json.dumps(key_data, indent=2), encoding="utf-8")

    print(f"\nBlind sample written to: {blind_path}")
    print(f"Key (trial_index → condition mapping) saved to: {key_path}")
    print(f"\nNext: read {blind_path.name}, score each trial 0-3, save to scores_blind.json")
    print(f"Then run: python analyze_blind_scores.py <jsonl> scores_blind.json")


if __name__ == "__main__":
    main()
