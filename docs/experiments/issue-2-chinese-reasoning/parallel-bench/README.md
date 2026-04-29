# Parallel benchmark (v2) — audit trail

This folder preserves an independently-produced benchmark that ran in
parallel with the main experiment in this directory. It was not authored
by the main experiment owner, but appeared on disk during the same time
window. It is preserved here as an audit trail, not as evidence of record.

The main experiment (see [`../REPORT.md`](../REPORT.md)) treats this v2
benchmark as **complementary in scenario design but methodologically too
weak to draw token-saving conclusions from**. Section 6 of the main report
documents the specific methodological gaps.

## Files

| File | Description |
|---|---|
| `reasoning_lang_bench.py` | First version of the parallel benchmark script (v4-flash, effort=high) |
| `reasoning_lang_bench_v2.py` | Second version (v4-pro, effort=high, 9 scenarios, no tools, N=2) |
| `bench_results.json` | Results from v1 |
| `bench_results_v2.json` | Results from v2 |

## Methodology gaps (relative to the main experiment)

The main report ([`../REPORT.md`](../REPORT.md), section 6) documents these
in detail; summarised here for quick reference:

1. **N=2 per cell** — within-scenario variance ranges from −55% to +58%
   per-prompt delta, so the reported aggregate "+22.5% Chinese token
   saving" sits well inside the noise floor.
2. **Did not preserve `reasoning_content`** — only `output_cn_ratio` was
   captured, which measures the *output* language rather than the
   *reasoning* language that issue #2 is concerned with.
3. **No baseline condition without steering** — only compares Chinese-
   steering vs English-steering. Without an A condition, you cannot tell
   whether either steering instruction has any effect at all relative to
   the natural model behaviour.
4. **No pre-registered decision matrix** — accept/reject criteria are not
   locked before data collection, so the analysis space is open to
   post-hoc cherry-picking.

## What is genuinely useful here

- **Scenario design**: 9 realistic scenarios (architecture design, security
  audit, database migration, etc.) provide better external validity than
  the main experiment's 5 simpler prompts. Future redesigns of this kind
  of experiment should borrow these scenarios.
- **`output_cn_ratio` metric**: a useful complementary measurement that
  tracks what the user actually sees, not just internal reasoning.
- **`effort=high` data point**: the main experiment uses `effort=max`; v2's
  `effort=high` provides a sketch of the alternate effort regime, even if
  the sketch is statistically too thin to act on.
