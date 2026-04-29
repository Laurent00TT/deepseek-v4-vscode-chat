"""Analyze experiment_chinese_reasoning.mjs output.

Computes the same summary tables the JS script would print, plus extra rigor:
- Per-cell median + IQR
- Compliance distribution (% of B trials with zh_ratio >= threshold)
- Wilcoxon signed-rank p-value over per-rep paired deltas
- Bootstrap CI for the overall mean delta

Usage:
    python test/analyze_experiment.py <jsonl-path>
"""
import json
import sys
import statistics
from collections import defaultdict


def median(xs):
    return statistics.median(xs) if xs else 0


def quantile(xs, q):
    if not xs:
        return 0
    s = sorted(xs)
    pos = (len(s) - 1) * q
    base = int(pos)
    rest = pos - base
    return s[base] + rest * (s[base + 1] - s[base]) if base + 1 < len(s) else s[base]


def wilcoxon_signed_rank(a, b):
    """Paired non-parametric test: returns (statistic, two-sided p-value approx)."""
    diffs = [bi - ai for ai, bi in zip(a, b) if ai != bi]
    if len(diffs) < 6:
        return None, None  # too small for normal approximation
    n = len(diffs)
    abs_diffs = sorted([(abs(d), 1 if d > 0 else -1) for d in diffs])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j < n - 1 and abs_diffs[j + 1][0] == abs_diffs[i][0]:
            j += 1
        rank = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[k] = rank
        i = j + 1
    w_pos = sum(r for r, (_, s) in zip(ranks, abs_diffs) if s > 0)
    w_neg = sum(r for r, (_, s) in zip(ranks, abs_diffs) if s < 0)
    w = min(w_pos, w_neg)
    mu = n * (n + 1) / 4.0
    sigma = (n * (n + 1) * (2 * n + 1) / 24.0) ** 0.5
    if sigma == 0:
        return w, None
    z = (w - mu) / sigma
    # Two-sided p approx via normal
    import math
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return w, p


def bootstrap_ci(deltas, n_iter=10000, ci=0.95):
    import random
    random.seed(42)
    n = len(deltas)
    means = []
    for _ in range(n_iter):
        sample = [deltas[random.randint(0, n - 1)] for _ in range(n)]
        means.append(sum(sample) / n)
    means.sort()
    lo = means[int((1 - ci) / 2 * n_iter)]
    hi = means[int((1 + ci) / 2 * n_iter)]
    return lo, hi


def main():
    if len(sys.argv) < 2:
        print("Usage: python test/analyze_experiment.py <jsonl-path>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        trials = [json.loads(l) for l in f if l.strip()]

    ok_trials = [t for t in trials if t["ok"]]
    print(f"Loaded {len(trials)} trials, {len(ok_trials)} OK\n")

    # Group by (prompt, condition)
    by_pc = defaultdict(list)
    for t in ok_trials:
        by_pc[(t["prompt_id"], t["condition"])].append(t)

    prompt_ids = sorted({t["prompt_id"] for t in ok_trials})

    conditions = sorted({t["condition"] for t in ok_trials})

    # ─── Per-prompt × condition: reasoning_tokens ───────────────────────────
    print("=" * 100)
    print("Reasoning tokens per (prompt × condition)")
    print("=" * 100)
    print(f"{'prompt_id':<22} {'cond':<5} {'n':>3} {'min':>5} {'p25':>5} {'med':>5} {'p75':>5} {'max':>5} {'mean':>6} {'std':>5}")
    print("-" * 100)
    for pid in prompt_ids:
        for cond in conditions:
            xs = [t["reasoning_tokens"] for t in by_pc[(pid, cond)]]
            if not xs:
                continue
            s = sorted(xs)
            mean = sum(xs) / len(xs)
            sd = statistics.stdev(xs) if len(xs) > 1 else 0
            print(f"{pid:<22} {cond:<5} {len(xs):>3} {s[0]:>5} {quantile(xs, 0.25):>5.0f} {median(xs):>5.0f} {quantile(xs, 0.75):>5.0f} {s[-1]:>5} {mean:>6.0f} {sd:>5.0f}")

    # ─── Pairwise comparisons vs baseline (A) ───────────────────────────────
    # For each non-A condition, compare against A on token count and zh_ratio.
    print()
    print("=" * 100)
    print("Pairwise comparisons against baseline A (paired by rep within prompt)")
    print("=" * 100)
    per_cond_token_deltas = {c: [] for c in conditions if c != "A"}
    per_cond_zh_deltas = {c: [] for c in conditions if c != "A"}
    direction_lower = {c: 0 for c in conditions if c != "A"}
    for cond in conditions:
        if cond == "A":
            continue
        print(f"\n--- Condition {cond} vs A ---")
        print(f"{'prompt_id':<22} {'A_med':>6} {f'{cond}_med':>7} {'Δmed%':>8} {'A_zh%':>7} {f'{cond}_zh%':>8} {'Δzh':>6}  Wilcoxon (p)")
        print("-" * 90)
        for pid in prompt_ids:
            a = sorted(by_pc[(pid, "A")], key=lambda t: t["rep"])
            x = sorted(by_pc[(pid, cond)], key=lambda t: t["rep"])
            if not a or not x:
                continue
            a_tok = [t["reasoning_tokens"] for t in a]
            x_tok = [t["reasoning_tokens"] for t in x]
            a_zh = [t["reasoning_zh_ratio"] for t in a]
            x_zh = [t["reasoning_zh_ratio"] for t in x]
            med_a = median(a_tok)
            med_x = median(x_tok)
            delta = (med_x - med_a) / med_a * 100 if med_a > 0 else 0
            per_cond_token_deltas[cond].append(delta)
            if delta < 0:
                direction_lower[cond] += 1
            zh_a = sum(a_zh) / len(a_zh) * 100
            zh_x = sum(x_zh) / len(x_zh) * 100
            per_cond_zh_deltas[cond].append(zh_x - zh_a)
            n = min(len(a_tok), len(x_tok))
            if n >= 6:
                _, p = wilcoxon_signed_rank(a_tok[:n], x_tok[:n])
                p_str = f"p={p:.3f}" if p is not None else "n/a"
            else:
                p_str = "n<6"
            print(f"{pid:<22} {med_a:>6.0f} {med_x:>7.0f} {delta:>+7.1f}% {zh_a:>6.0f}% {zh_x:>7.0f}% {(zh_x - zh_a):>+5.0f}pp  {p_str}")
        ds = per_cond_token_deltas[cond]
        zhs = per_cond_zh_deltas[cond]
        if ds:
            print("-" * 90)
            print(f"  {cond} OVERALL: Δmed mean={sum(ds)/len(ds):+.1f}%, direction({cond}<A)={direction_lower[cond]}/{len(ds)}, Δzh mean={sum(zhs)/len(zhs):+.1f}pp")

    # ─── Compliance distribution ─────────────────────────────────────────────
    print()
    print("=" * 90)
    print("Compliance distribution: fraction of trials where reasoning_zh_ratio crosses threshold")
    print("=" * 90)
    by_cond_all = {c: [t for t in ok_trials if t["condition"] == c] for c in conditions}
    header = f"{'threshold':<12}" + "".join(f"  {c} frac".rjust(11) for c in conditions)
    print(header)
    for thr in (0.10, 0.30, 0.50, 0.70, 0.90):
        row = f"≥ {thr:<10.2f}"
        for c in conditions:
            xs = by_cond_all[c]
            frac = sum(1 for t in xs if t["reasoning_zh_ratio"] >= thr) / len(xs) * 100 if xs else 0
            row += f"  {frac:>8.0f}%".rjust(11)
        print(row)

    # ─── Overall stats per condition ─────────────────────────────────────────
    print()
    print("=" * 90)
    print("Overall pooled statistics per condition")
    print("=" * 90)
    cond_overall = {}
    for c in conditions:
        toks = [t["reasoning_tokens"] for t in by_cond_all[c]]
        zhs = [t["reasoning_zh_ratio"] for t in by_cond_all[c]]
        cond_overall[c] = {
            "n": len(toks),
            "tok_median": median(toks),
            "tok_mean": sum(toks) / len(toks) if toks else 0,
            "zh_mean_pct": sum(zhs) / len(zhs) * 100 if zhs else 0,
        }
        print(f"  {c}: n={cond_overall[c]['n']}  reasoning_tokens median={cond_overall[c]['tok_median']:.0f}  mean={cond_overall[c]['tok_mean']:.0f}  zh%={cond_overall[c]['zh_mean_pct']:.1f}%")

    # Bootstrap CIs for each non-A condition's mean Δ%
    for c in conditions:
        if c == "A":
            continue
        ds = per_cond_token_deltas.get(c, [])
        if len(ds) >= 3:
            lo, hi = bootstrap_ci(ds)
            print(f"  Per-prompt mean Δ% ({c} vs A) bootstrap 95% CI: [{lo:+.1f}%, {hi:+.1f}%]")

    # ─── Cache impact ────────────────────────────────────────────────────────
    print()
    print("=" * 90)
    print("Cache hit/miss tokens (first request typically misses; stable prefix → hits)")
    print("=" * 90)
    for c in conditions:
        xs = by_cond_all[c]
        hit = sum(t.get("cache_hit_tokens", 0) for t in xs)
        miss = sum(t.get("cache_miss_tokens", 0) for t in xs)
        total = hit + miss
        rate = hit / total * 100 if total else 0
        print(f"  {c}: total prompt tokens={total}  hit={hit} ({rate:.1f}%)  miss={miss}")

    # ─── Apply pre-registered decision matrix to each non-A condition ─────────
    print()
    print("=" * 90)
    print("Pre-registered decision matrix application")
    print("=" * 90)
    for c in conditions:
        if c == "A":
            continue
        compliance = cond_overall[c]["zh_mean_pct"]
        ds = per_cond_token_deltas.get(c, [])
        token_saving = -sum(ds) / len(ds) if ds else 0  # positive = saved
        print(f"\n  Condition {c}:")
        print(f"    Compliance (mean zh%):        {compliance:.1f}%")
        print(f"    Token saving (Δ negated):     {token_saving:+.1f}%")
        print(f"    Quality regression: TBD (manual blind scoring required)")
        if compliance < 50:
            print(f"    → REJECT: instruction ignored (compliance < 50%)")
        elif token_saving < 10:
            print(f"    → REJECT: no tangible benefit (token saving < 10%)")
        elif compliance >= 70 and token_saving >= 20:
            print(f"    → POTENTIAL ACCEPT: pending quality regression check (must be ≤10%)")
        else:
            print(f"    → INCONCLUSIVE: signals don't cleanly meet ACCEPT or REJECT thresholds")

if __name__ == "__main__":
    main()
