"""Join blind quality scores with original trial conditions and report.

Usage:
    python analyze_blind_scores.py <jsonl-path>

Reads:
    <jsonl-path>: original experiment data (with condition labels)
    <jsonl-dir>/blind_scoring_key.json: trial_index → "prompt_id__condition__rep"
    <jsonl-dir>/scores_blind.json: trial_index → 0-3 score

Reports:
    - Per-condition mean / median / stdev / count
    - Per-prompt × condition mean (when sample allows)
    - Quality regression (B vs A, C vs A) for the decision matrix
"""
import json
import sys
import statistics
from pathlib import Path
from collections import defaultdict


def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_blind_scores.py <jsonl-path>")
        sys.exit(1)
    jsonl_path = Path(sys.argv[1])
    data_dir = jsonl_path.parent
    key_path = data_dir / "blind_scoring_key.json"
    scores_path = data_dir / "scores_blind.json"

    if not key_path.exists() or not scores_path.exists():
        print(f"Missing key or scores file in {data_dir}")
        sys.exit(1)

    key = json.loads(key_path.read_text(encoding="utf-8"))
    scores_data = json.loads(scores_path.read_text(encoding="utf-8"))
    scores = scores_data["scores"] if "scores" in scores_data else scores_data

    # key has trial_index (str) → "prompt_id__condition__rep"
    # scores has trial_index (str) → score
    aligned = []  # list of {prompt_id, condition, rep, score}
    for tidx, source_key in key.items():
        if tidx not in scores:
            continue
        parts = source_key.split("__")
        if len(parts) != 3:
            continue
        prompt_id, condition, rep = parts
        aligned.append({
            "prompt_id": prompt_id,
            "condition": condition,
            "rep": int(rep),
            "score": scores[tidx],
            "trial_index": int(tidx),
        })

    if not aligned:
        print("No aligned trials. Check that scores_blind.json has been filled in.")
        sys.exit(1)

    print(f"Scored {len(aligned)} trials\n")

    # ─── Per-condition summary ─────────────────────────────────────────────
    print("=" * 70)
    print("Per-condition quality scores")
    print("=" * 70)
    by_cond = defaultdict(list)
    for a in aligned:
        by_cond[a["condition"]].append(a["score"])
    print(f"{'cond':<6} {'n':>3} {'mean':>6} {'median':>7} {'std':>5} {'min':>4} {'max':>4} {'distribution':>20}")
    for cond in sorted(by_cond):
        xs = by_cond[cond]
        m = sum(xs) / len(xs)
        med = statistics.median(xs)
        sd = statistics.stdev(xs) if len(xs) > 1 else 0
        from collections import Counter
        ctr = Counter(xs)
        dist = " ".join(f"{k}:{ctr.get(k,0)}" for k in sorted([0, 1, 2, 3]))
        print(f"{cond:<6} {len(xs):>3} {m:>6.2f} {med:>7.2f} {sd:>5.2f} {min(xs):>4} {max(xs):>4}   {dist}")

    # ─── Quality regression vs A ───────────────────────────────────────────
    print()
    print("=" * 70)
    print("Quality regression vs baseline A")
    print("=" * 70)
    if "A" not in by_cond:
        print("No A trials, cannot compute regression")
    else:
        a_mean = sum(by_cond["A"]) / len(by_cond["A"])
        for cond in sorted(by_cond):
            if cond == "A":
                continue
            x_mean = sum(by_cond[cond]) / len(by_cond[cond])
            delta = x_mean - a_mean
            regression_pct = -delta / a_mean * 100 if a_mean > 0 else 0
            print(f"  {cond} vs A: Δmean={delta:+.2f} (B-A in 0-3 scale)")
            print(f"    Regression % (positive = X is worse): {regression_pct:+.1f}%")
            print(f"    Decision matrix threshold: regression > 20% triggers REJECT")
            if regression_pct > 20:
                print(f"    → REJECT on quality")
            elif regression_pct > 10:
                print(f"    → BORDERLINE (between 10% and 20%)")
            else:
                print(f"    → quality OK (regression ≤ 10%)")
            print()

    # ─── Per-prompt × condition (cell counts will be small) ────────────────
    print("=" * 70)
    print("Per-prompt × condition (cell sample sizes are small)")
    print("=" * 70)
    by_pc = defaultdict(list)
    for a in aligned:
        by_pc[(a["prompt_id"], a["condition"])].append(a["score"])
    prompts = sorted({a["prompt_id"] for a in aligned})
    print(f"{'prompt_id':<22} " + " ".join(f"  {c}_mean (n)".rjust(12) for c in sorted(by_cond)))
    for pid in prompts:
        row = f"{pid:<22} "
        for c in sorted(by_cond):
            xs = by_pc.get((pid, c), [])
            if xs:
                row += f"  {sum(xs)/len(xs):>6.2f} ({len(xs)})".rjust(13)
            else:
                row += "  -".rjust(13)
        print(row)


if __name__ == "__main__":
    main()
