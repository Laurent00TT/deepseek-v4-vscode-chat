# Issue #2: injecting a Chinese-reasoning instruction into DeepSeek V4

> Status: **closed (REJECT)**  
> Linked: [Issue #2 — Feature Request](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2)  
> Experiment date: 2026-04-29  
> Decision: do not implement. Full justification in [REPORT.md](./REPORT.md).

## TL;DR

We ran a pre-registered three-condition ablation (**150 trials**) plus **30 trials of blind quality scoring** to test the issue author's proposal and a natural variant:

- **Condition A** — no steering (baseline)
- **Condition B** — English-language system-prompt steering (issue author's verbatim proposal) → **REJECT** (compliance 36.0% < 50%; instruction effectively ignored)
- **Condition C** — Chinese-language system-prompt steering (our ablation) → **REJECT** (token saving +0.8% < 10% threshold; also introduced a "model answers English prompt in Chinese" UX regression)

**Both conditions REJECT, but along different failure modes.** Quality regression for B was +3.3% and for C was +6.7%, both far below the 20% threshold — quality is *not* the reject reason for either.

Full data and reasoning in [REPORT.md](./REPORT.md).

## Files

| File | Purpose |
|---|---|
| [`REPORT.md`](./REPORT.md) | Full report (background, methodology, data, literature cross-checks, conclusion) |
| [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) | Experiment runner; **pre-registered decision matrix at the top of the file** |
| [`analyze_experiment.py`](./analyze_experiment.py) | Primary analysis: token / compliance / cache + decision-matrix application |
| [`prep_blind_scoring.py`](./prep_blind_scoring.py) | Generates a blind scoring sample (stratified, deterministic shuffle, condition hidden) |
| [`analyze_blind_scores.py`](./analyze_blind_scores.py) | Joins blind scores back to conditions and reports the regression |
| [`score_blind.mjs`](./score_blind.mjs) | Interactive scoring helper (alternative path; this run used the Python pipeline above) |
| [`data/*.jsonl`](./data) | Raw experiment data (one trial per line, full reasoning_content + content + usage) |
| [`data/scores_blind.json`](./data/scores_blind.json) | 30-trial blind scores plus rationales for non-3 scores |
| [`data/blind_scoring_key.json`](./data/blind_scoring_key.json) | trial_index → condition mapping (hidden during scoring) |
| [`data/blind_scoring_sample.md`](./data/blind_scoring_sample.md) | The actual blinded sample shown to the scorer |
| [`parallel-bench/`](./parallel-bench/) | Independent third-party parallel benchmark preserved for audit, with its own README documenting methodological gaps |

## Data files

| File | Description |
|---|---|
| `data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl` | **v3 primary**: N=10 × 5 prompts × 3 conditions = **150 trials** (149 OK + 1 network error) |
| `data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl` | v1 earlier data: N=10 × 5 prompts × 2 conditions = 100 trials (no condition C) |
| `data/experiment_chinese_reasoning_2026-04-29T06-34-43_quick.jsonl` | v3 smoke test (N=2; verifies the 3-condition script) |
| `data/experiment_chinese_reasoning_2026-04-29T06-18-01_quick.jsonl` | v3 smoke (all 401, API key revoked mid-run; preserved as audit) |
| `data/experiment_chinese_reasoning_2026-04-29T04-33-13_quick.jsonl` | v1 smoke (N=2, original two-condition design) |
| `data/experiment_chinese_reasoning_2026-04-29T04-22-23_quick.jsonl` | v1 smoke (all 401, earlier API-key revocation) |

## Reproducing the experiment

```bash
# 1. Run the full experiment (needs DEEPSEEK_API_KEY; ~70 min for 150 trials)
DEEPSEEK_API_KEY=sk-... node docs/experiments/issue-2-chinese-reasoning/experiment_chinese_reasoning.mjs

# 2. Primary analysis (token / compliance / cache + decision matrix)
python docs/experiments/issue-2-chinese-reasoning/analyze_experiment.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>

# 3. Blind quality scoring (Python pipeline — used in this run)
python docs/experiments/issue-2-chinese-reasoning/prep_blind_scoring.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>
# scorer reads data/blind_scoring_sample.md, writes scores into data/scores_blind.json
python docs/experiments/issue-2-chinese-reasoning/analyze_blind_scores.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>

# 4. (Alternative) interactive scoring helper
node docs/experiments/issue-2-chinese-reasoning/score_blind.mjs \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>
```

## Methodology highlights

1. **Pre-registered decision matrix** — accept/reject criteria locked in code before any data was collected, eliminating post-hoc cherry-picking.
2. **A/B/C interleaved** — within each rep, conditions are run in fixed A→B→C order so that server-side load drift over time is spread evenly across conditions, not asymmetrically biasing one condition.
3. **Single-variable principle** — A, B, and C share an identical Copilot-like baseline system prompt; the only difference is whether (and in which language) a steering instruction is prepended.
4. **Full raw data preserved** — the jsonl includes the full `reasoning_content` text, allowing any metric to be recomputed independently.
5. **Blind quality scoring isolated in its own tool** — the scorer never sees the condition label or the reasoning_content, only the user prompt and the model's final answer.
6. **Literature preflight** — official DeepSeek docs and academic literature were consulted *before* running the experiment to identify the principal unknowns and avoid duplicating prior knowledge.

## Suggested directions for future work

The v3 experiment now covers:
- ✅ Chinese-language steering instruction (Condition C)
- ✅ Blind quality scoring with rationales

Areas not covered, valuable for future investigation:
- **Steering placement other than system prompt** (user-message end, assistant prefix, etc.)
- **Multi-turn agent loops with tool calls** — the current set is single-turn
- **Other model variants** — only `deepseek-v4-pro` was tested, not Flash
- **Effort × steering factorial** — only `effort=max` was tested; the parallel v2 used `effort=high`, suggesting effort may interact with steering, but v2's N=2 cannot resolve this
- **Larger and more realistic prompt set** — the parallel v2's 9 complex scenarios (architecture, security, DB migration) are a useful template

## On the "exploratory" label

This is a **small-scale exploratory study**, not a fully-engineered benchmark. It was sized to answer one specific issue with enough rigour to support a decision (`REJECT`), and the data and methodology are sufficient for that purpose. **It should not be cited as a general claim** that "Chinese reasoning steering is impossible on DeepSeek V4" — the prompt set is small, several dimensions are unexplored, and the negative result only refutes *this specific instruction at this specific position with this specific effort setting on this specific model variant*.
