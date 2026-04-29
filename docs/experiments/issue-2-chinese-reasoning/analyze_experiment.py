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

    # ─── Per-prompt × condition: reasoning_tokens ───────────────────────────
    print("=" * 90)
    print("Reasoning tokens per (prompt × condition)")
    print("=" * 90)
    print(f"{'prompt_id':<22} {'cond':<5} {'n':>3} {'min':>5} {'p25':>5} {'med':>5} {'p75':>5} {'max':>5} {'mean':>6} {'std':>5}")
    print("-" * 90)
    for pid in prompt_ids:
        for cond in ("A", "B"):
            xs = [t["reasoning_tokens"] for t in by_pc[(pid, cond)]]
            if not xs:
                continue
            s = sorted(xs)
            mean = sum(xs) / len(xs)
            sd = statistics.stdev(xs) if len(xs) > 1 else 0
            print(f"{pid:<22} {cond:<5} {len(xs):>3} {s[0]:>5} {quantile(xs, 0.25):>5.0f} {median(xs):>5.0f} {quantile(xs, 0.75):>5.0f} {s[-1]:>5} {mean:>6.0f} {sd:>5.0f}")

    # ─── Per-prompt: A vs B comparison ──────────────────────────────────────
    print()
    print("=" * 90)
    print("A vs B comparison (paired by rep)")
    print("=" * 90)
    print(f"{'prompt_id':<22} {'A_med':>6} {'B_med':>6} {'Δmed%':>8} {'A_zh%':>7} {'B_zh%':>7} {'Δzh':>6}  Wilcoxon (p)")
    print("-" * 90)
    per_prompt_token_deltas = []
    per_prompt_compliance_deltas = []
    direction_b_lower = 0
    for pid in prompt_ids:
        a = sorted(by_pc[(pid, "A")], key=lambda t: t["rep"])
        b = sorted(by_pc[(pid, "B")], key=lambda t: t["rep"])
        a_tok = [t["reasoning_tokens"] for t in a]
        b_tok = [t["reasoning_tokens"] for t in b]
        a_zh = [t["reasoning_zh_ratio"] for t in a]
        b_zh = [t["reasoning_zh_ratio"] for t in b]
        med_a = median(a_tok)
        med_b = median(b_tok)
        delta = (med_b - med_a) / med_a * 100 if med_a > 0 else 0
        per_prompt_token_deltas.append(delta)
        if delta < 0:
            direction_b_lower += 1
        zh_a = sum(a_zh) / len(a_zh) * 100
        zh_b = sum(b_zh) / len(b_zh) * 100
        per_prompt_compliance_deltas.append(zh_b - zh_a)
        n = min(len(a_tok), len(b_tok))
        if n >= 6:
            _, p = wilcoxon_signed_rank(a_tok[:n], b_tok[:n])
            p_str = f"p={p:.3f}" if p is not None else "n/a"
        else:
            p_str = "n<6"
        print(f"{pid:<22} {med_a:>6.0f} {med_b:>6.0f} {delta:>+7.1f}% {zh_a:>6.0f}% {zh_b:>6.0f}% {(zh_b - zh_a):>+5.0f}pp  {p_str}")
    print("-" * 90)
    overall_med_delta = median(per_prompt_token_deltas)
    overall_mean_delta = sum(per_prompt_token_deltas) / len(per_prompt_token_deltas)
    print(f"{'OVERALL':<22}                  Δmed={overall_med_delta:+.1f}%  Δmean={overall_mean_delta:+.1f}%  direction(B<A)={direction_b_lower}/{len(prompt_ids)}")

    # ─── Compliance distribution ─────────────────────────────────────────────
    print()
    print("=" * 90)
    print("Compliance distribution: fraction of trials where reasoning_zh_ratio crosses threshold")
    print("=" * 90)
    a_all = [t for t in ok_trials if t["condition"] == "A"]
    b_all = [t for t in ok_trials if t["condition"] == "B"]
    print(f"{'threshold':<12} {'A frac':>10} {'B frac':>10}")
    for thr in (0.10, 0.30, 0.50, 0.70, 0.90):
        a_frac = sum(1 for t in a_all if t["reasoning_zh_ratio"] >= thr) / len(a_all)
        b_frac = sum(1 for t in b_all if t["reasoning_zh_ratio"] >= thr) / len(b_all)
        print(f"≥ {thr:<10.2f} {a_frac * 100:>9.0f}% {b_frac * 100:>9.0f}%")

    # ─── Overall stats ───────────────────────────────────────────────────────
    print()
    print("=" * 90)
    print("Overall pooled statistics")
    print("=" * 90)
    a_tok_all = [t["reasoning_tokens"] for t in a_all]
    b_tok_all = [t["reasoning_tokens"] for t in b_all]
    a_zh_all = [t["reasoning_zh_ratio"] for t in a_all]
    b_zh_all = [t["reasoning_zh_ratio"] for t in b_all]
    print(f"  A: n={len(a_tok_all)}  reasoning_tokens median={median(a_tok_all):.0f}  mean={sum(a_tok_all)/len(a_tok_all):.0f}  zh%={sum(a_zh_all)/len(a_zh_all)*100:.1f}%")
    print(f"  B: n={len(b_tok_all)}  reasoning_tokens median={median(b_tok_all):.0f}  mean={sum(b_tok_all)/len(b_tok_all):.0f}  zh%={sum(b_zh_all)/len(b_zh_all)*100:.1f}%")

    # ─── Bootstrap CI for per-prompt mean delta ──────────────────────────────
    if len(per_prompt_token_deltas) >= 3:
        lo, hi = bootstrap_ci(per_prompt_token_deltas)
        print(f"  Per-prompt mean Δ% bootstrap 95% CI: [{lo:+.1f}%, {hi:+.1f}%]")

    # ─── Cache impact ────────────────────────────────────────────────────────
    print()
    print("=" * 90)
    print("Cache hit/miss tokens (first request typically misses; later requests may hit)")
    print("=" * 90)
    a_hit = sum(t.get("cache_hit_tokens", 0) for t in a_all)
    a_miss = sum(t.get("cache_miss_tokens", 0) for t in a_all)
    b_hit = sum(t.get("cache_hit_tokens", 0) for t in b_all)
    b_miss = sum(t.get("cache_miss_tokens", 0) for t in b_all)
    a_total_pt = a_hit + a_miss
    b_total_pt = b_hit + b_miss
    print(f"  A: total prompt tokens={a_total_pt}  hit={a_hit} ({a_hit/a_total_pt*100 if a_total_pt else 0:.1f}%)  miss={a_miss}")
    print(f"  B: total prompt tokens={b_total_pt}  hit={b_hit} ({b_hit/b_total_pt*100 if b_total_pt else 0:.1f}%)  miss={b_miss}")

    # ─── Apply pre-registered decision matrix ────────────────────────────────
    print()
    print("=" * 90)
    print("Pre-registered decision matrix application")
    print("=" * 90)
    overall_compliance = sum(b_zh_all) / len(b_zh_all) * 100  # mean Chinese ratio in B
    overall_token_saving = -overall_mean_delta  # positive = saved
    print(f"  Overall B compliance (mean zh%): {overall_compliance:.1f}%")
    print(f"  Overall token saving (per-prompt mean Δ negated): {overall_token_saving:+.1f}%")
    print(f"  Quality regression: TBD (manual blind scoring required)")
    print()
    if overall_compliance < 50:
        print(f"  → REJECT: instruction ignored (compliance < 50%)")
    elif overall_token_saving < 10:
        print(f"  → REJECT: no tangible benefit (token saving < 10%)")
    elif overall_compliance >= 70 and overall_token_saving >= 20:
        print(f"  → POTENTIAL ACCEPT: pending quality regression check (must be ≤10%)")
    else:
        print(f"  → INCONCLUSIVE: signals don't cleanly meet ACCEPT or REJECT thresholds")


if __name__ == "__main__":
    main()
