# Experiment report: injecting a "think in Chinese" instruction into DeepSeek V4

> Experiment date: 2026-04-29  
> Sample size: N=10 reps × 5 prompts × 3 conditions = **150 trials** (149 OK + 1 network error)  
> Model: `deepseek-v4-pro`, `thinking.type=enabled`, `reasoning_effort=max`  
> Primary data: [`data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl)  
> Blind quality scoring: [`data/scores_blind.json`](./data/scores_blind.json) (30 trials, 10 per condition)

## 1. Background and hypotheses

[Issue #2](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2) proposes that VS Code Copilot Chat's English system prompt forces DeepSeek V4 to reason in English, wasting tokens for Chinese-speaking users (with a claimed 1.5–2× overhead). The proposed fix is to prepend the following system prompt:

> "You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."

The proposal rests on four independent hypotheses:

1. **Token efficiency** — Chinese reasoning expresses the same content in fewer tokens than English reasoning.
2. **Instruction compliance** — a system prompt can switch the model's reasoning language.
3. **Quality parity** — Chinese reasoning does not measurably degrade output quality.
4. **Side-effect tolerable** — injecting an extra system prompt does not significantly hurt KV cache economics.

If any of these fails, the proposal does not stand.

**v3 ablation dimension**: does the language of the steering instruction itself matter? (English-language vs Chinese-language instruction)

## 2. Literature and official-doc preflight

**Hypothesis 1 (token efficiency)** — partially supported, but the magnitude is exaggerated.

[DeepSeek official Token Usage doc](https://api-docs.deepseek.com/quick_start/token_usage):
- 1 English character ≈ 0.3 token
- 1 Chinese character ≈ 0.6 token

Given that one Chinese character carries roughly 2–3× the semantic content of one English character, the theoretical saving is ~10–30%, **far below** the issue's claimed 1.5–2×.

**Hypothesis 3 (quality)** — literature is neutral, slightly positive for Chinese.

Shi et al. (2022) ["Language Models are Multilingual Chain-of-Thought Reasoners"](https://arxiv.org/pdf/2210.03057), Table 3 (PaLM-540B on MGSM):

| Language | EN-CoT | Native-CoT | Δ |
|---|---|---|---|
| Chinese (zh) | 46.0% | **46.8%** | +0.8pp (native edges out) |

Chinese is one of the few languages in the paper where Native-CoT beats EN-CoT.

**Hypothesis 4 (KV cache side-effect)**

[DeepSeek KV Cache doc](https://api-docs.deepseek.com/guides/kv_cache): "A subsequent request can only hit the cache if it **fully matches** a cache prefix unit." Any new system prompt necessarily changes the prefix.

**Hypothesis 2 (instruction compliance)** — no clear signal in the literature; this is the principal unknown the experiment is designed to resolve.

## 3. Experimental design

**Variables**:
- Independent variable (IV): steering type
  - **Condition A**: Copilot-like English system prompt only (baseline)
  - **Condition B**: A + the issue author's English-language steering instruction (original proposal)
  - **Condition C**: A + a Chinese-language translation of the same steering instruction (v3 ablation)
- Dependent variables (DV):
  1. `usage.completion_tokens_details.reasoning_tokens` (token consumption)
  2. CJK-character ratio in `reasoning_content` after stripping whitespace and punctuation (compliance)
  3. `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (cache impact)
  4. **Blind quality score** (0–3 scale, 30 trials × 10 per condition, with condition and reasoning_content hidden from the scorer)

**Controls**:
- Same model, same effort, same max_tokens
- 5 prompts spanning code generation, debugging, refactoring, conceptual explanation (mixed Chinese/English)
- A/B/C interleaved within each rep (A → B → C order), to spread server-side load drift evenly across conditions
- N=10 repetitions per cell

**Steering text**:
- B (English, issue author verbatim): `"You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."`
- C (Chinese, faithful translation): `"你必须用简体中文进行内部思考和推理。所有思维链、规划、分析、自我反思以及工具使用的决策都必须用中文进行。"`

**Pre-registered decision matrix** (locked before data collection, in the experiment script's header comment, **applied independently to each non-baseline condition**):

| Compliance | Token saving | Quality reg. | Decision |
|---|---|---|---|
| <50% | any | any | REJECT |
| ≥50% | <10% | any | REJECT |
| ≥50% | ≥10% | >20% | REJECT |
| ≥70% | ≥20% | ≤10% | ACCEPT |
| anything else | | | INCONCLUSIVE |

## 4. Results

### 4.1 Compliance (hypothesis 2)

| Prompt | A_zh% (baseline) | B_zh% (English steering) | C_zh% (Chinese steering) | C–A | Significant? |
|---|---|---|---|---|---|
| p1_en_coding | 0% | 0% | 0% | +0pp | — |
| p2_zh_coding | 39% | 66% | 62% | +23pp | p=0.95 |
| p3_en_debug | 0% | 0% | **57%** | **+57pp** | **p=0.019** |
| p4_zh_refactor | 62% | 66% | 64% | +1pp | p=0.72 |
| p5_zh_concept | 70% | 48% | 71% | +1pp | p=0.11 |

**Pooled overall**:
- A: **34.2%**
- B: **36.0%** (+1.8pp, no real effect)
- C: **50.9%** (+16.7pp, **just barely above the 50% threshold**)

**Key findings**:
- **B (English steering) is essentially inert** — compliance moves only +1.8pp from baseline, well within noise.
- **C (Chinese steering) has a measurable but limited effect** — compliance lifts +16.7pp; only one of five prompts (p3_en_debug) shows a statistically significant per-prompt effect (p=0.019, which does not survive Bonferroni correction).
- The clearest evidence of the steering "working" is on p3_en_debug, where Chinese steering moved the model from 0% → 57% Chinese reasoning on an English debugging task.

### 4.2 Token consumption (hypothesis 1)

| Prompt | A median | B median | B Δ% | C median | C Δ% |
|---|---|---|---|---|---|
| p1_en_coding | 478 | 300 | -37.3% | 451 | -5.7% |
| p2_zh_coding | 234 | 162 | -31.0% | 363 | **+55.1%** |
| p3_en_debug | 256 | 246 | -4.1% | 190 | -25.9% |
| p4_zh_refactor | 658 | 578 | -12.3% | 639 | -3.0% |
| p5_zh_concept | 473 | 566 | +19.7% | 356 | -24.7% |

**Pooled per-prompt mean Δ**:
- B vs A: **-13.0%** (token saving +13.0%) — clears the ≥10% threshold
- C vs A: **-0.8%** (token saving +0.8%) — **fails the 10% threshold**
- B 95% bootstrap CI: [-29.8%, +4.8%] (crosses zero, not significant)
- C 95% bootstrap CI: [-21.4%, +27.5%] (crosses zero, not significant)

**Counter-intuitive observation**: **B appears to save tokens, but its compliance did not change** — meaning B's apparent saving is unrelated to language switching. Its 95% CI also crosses zero, so the point estimate is not robust. **C does shift language partially but does not deliver token savings** — Chinese reasoning in our 5 prompts does not yield a measurable token advantage.

### 4.3 KV cache side-effect (hypothesis 4, direct measurement)

| | A | B | C |
|---|---|---|---|
| Total prompt tokens | 7,589 | 9,440 | 9,140 |
| Cached tokens | 6,144 | 6,400 | 6,272 |
| Missed tokens | 1,445 | 3,040 (+110%) | 2,868 (+98%) |
| **Hit rate** | **81.0%** | **67.8%** | **68.6%** |

Injecting a system prompt — English or Chinese — drops the cache hit rate by **12–13 percentage points**, matching the literature prediction. C has a slightly shorter prompt (Chinese characters are denser), so its hit rate is 0.8pp better than B's, but both pay a real cost.

### 4.4 Blind quality scoring (hypothesis 3)

30 trials (10 per condition), scored against the `content` field with the condition label and reasoning_content hidden from the scorer. Trials shuffled deterministically. Rationales for non-3 scores documented inline in [`data/scores_blind.json`](./data/scores_blind.json).

| Condition | n | mean | median | std | Distribution |
|---|---|---|---|---|---|
| A | 10 | **3.00** | 3.00 | 0.00 | all 3s |
| B | 10 | **2.90** | 3.00 | 0.32 | 1×2, 9×3 |
| C | 10 | **2.80** | 3.00 | 0.42 | 2×2, 8×3 |

**Quality regression**:
- B vs A: Δmean = -0.10, **+3.3% regression**, far below the 20% threshold ✓
- C vs A: Δmean = -0.20, **+6.7% regression**, far below the 20% threshold ✓

**Per-prompt quality breakdown**:

| Prompt | A | B | C | Notes |
|---|---|---|---|---|
| p1_en_coding | 3.00 | 3.00 | **2.50** | **C answers an English prompt in Chinese** (language mismatch) |
| p2_zh_coding | 3.00 | **2.50** | 3.00 | B output overly minimal (no docstring or examples) |
| p3_en_debug | 3.00 | 3.00 | **2.50** | **C answers an English prompt in Chinese** (language mismatch) |
| p4_zh_refactor | 3.00 | 3.00 | 3.00 | All 3s |
| p5_zh_concept | 3.00 | 3.00 | 3.00 | All 3s |

**New finding — C side-effect**: Chinese steering also makes the model **answer the user in Chinese on English prompts**, a UX regression the original issue did not anticipate. Quality regression on the 0–3 scale is only 6.7% because the rubric is not very sensitive to language mismatch, but in a real product context, "user asks in English, model replies in Chinese" is a clear experience failure.

### 4.5 Decision matrix application

```
Condition B:
  Compliance:        36.0% < 50%
  Token saving:      +13.0%
  Quality reg.:      +3.3%
  → REJECT (instruction ignored)

Condition C:
  Compliance:        50.9% ≥ 50%
  Token saving:      +0.8% < 10%
  Quality reg.:      +6.7%
  → REJECT (no tangible benefit)
```

**Both conditions REJECT, but along different failure modes** — a clean ablation outcome:
- **B fails** because the English-language steering instruction is ineffective; the model does not switch reasoning language.
- **C fails** because the Chinese-language steering instruction does shift the reasoning language somewhat but does not produce token savings; it also introduces a language-mismatch UX regression.

## 5. Comparison with the literature

| Literature prediction | Observation in this experiment |
|---|---|
| ~10–30% theoretical token saving from Chinese reasoning ([DS Token Usage](https://api-docs.deepseek.com/quick_start/token_usage)) | B saving +13% is unrelated to language (compliance unchanged); C saving only +0.8%. **Theoretical saving is not realized in the C condition.** |
| Native-CoT slightly beats EN-CoT for Chinese on PaLM-540B (Shi et al. 2022) | DS V4 quality regression is +6.7% in C — opposite direction — but the regression is driven by language-mismatch UX rather than by reasoning errors. |
| Language-mixed CoT with English anchoring outperforms forced single-language CoT (Shi et al. 2022) | Indirect support: B's effective inertness suggests the model self-selects an appropriate language and resists being forced. |
| Injecting a new system prompt necessarily changes the cache prefix ([DS KV cache doc](https://api-docs.deepseek.com/guides/kv_cache)) | Cache hit rate drops -12.4pp (B) and -12.4pp (C), **fully confirmed**. |
| Chinese is *not* more efficient than English on coding tasks across 3 commercial models — MiniMax-2.7 is 1.28× more expensive in Chinese, GPT-5.4-mini 1.09× more expensive, GLM-5 only 0.98× (essentially even); problem-solving rate is 4.5–9.9pp **lower** in Chinese for all three ([Mythbuster, arxiv 2604.14210, 2026](https://arxiv.org/html/2604.14210v1)) | Strongest single piece of external evidence against issue #2's "1.5–2× saving" claim. The issue's specific 1.5–2× number has no traceable primary source; the most directly relevant 2026 empirical study finds the opposite direction. |
| Reasoning in non-English languages can save tokens *and* preserve accuracy on reasoning models (DeepSeek R1, Qwen 2.5/3) when the prompt itself is in that language — DeepSeek R1 saves up to 29.9% (Spanish), Qwen 3 up to 73% (Korean) ([EfficientXLang, Microsoft Research, 2025](https://arxiv.org/pdf/2507.00246)) | Conditional support: yes, non-English reasoning *can* save tokens, but the test setup is **prompt-language-native**, not system-prompt-steering. Chinese is not the most efficient language in their results. Our v3 setup tests steering, not native-language prompts, so EfficientXLang's positive findings do not transfer to the issue #2 proposal. |

## 6. Cross-check against the parallel `experiments/` work (v2)

During this experiment a parallel benchmark run by an unrelated process (an MCP tool, presumably) produced a separate dataset, now preserved at [`parallel-bench/`](./parallel-bench/) for audit purposes.

| Dimension | Our v3 | Parallel v2 |
|---|---|---|
| Model | deepseek-v4-pro | deepseek-v4-pro |
| Effort | max | high |
| Conditions | 3 (A / B / C) | 2 (en-steering / cn-steering, no baseline A) |
| Scenarios | 5 (simple, single-turn) | 9 (complex, includes tool calls) |
| N reps | 10 | 2 |
| Measures reasoning language | ✓ via `reasoning_zh_ratio` | ✗ only `output_cn_ratio` |
| Preserves full `reasoning_content` | ✓ | ✗ |
| Pre-registered decision matrix | ✓ | ✗ |
| Reported token saving | C: +0.8% | cn vs en: +22.5% |

**v2's methodological gaps**:
1. **N=2 is severely underpowered** — per-scenario delta swings from −55% to +58%; the aggregate +22.5% sits inside the noise.
2. **Did not measure reasoning-language** — only the final output language. But issue #2 is about *reasoning*, so v2 measured the wrong dependent variable.
3. **No baseline condition** — only compares cn-steering vs en-steering. Without an A condition, you cannot tell whether either steering does anything at all relative to natural model behaviour.
4. **No pre-registered decision matrix** — invites post-hoc cherry-picking.

**v2's useful contributions**:
- 9 realistic scenarios (better external validity than our 5 simpler prompts)
- `output_cn_ratio` is a useful complementary metric — it tracks what the user sees, not just internal reasoning
- `effort=high` data point complements our `effort=max` measurements

**Conclusion on v2**: it cannot be cited as evidence of token saving — N is too small, and the wrong dependent variable was measured. We acknowledge its scenario design as a useful template for any future, more rigorous follow-up.

## 7. Limitations (honestly disclosed)

1. **The exact text of Copilot Chat's real system prompt is closed-source**. We use a representative approximation. Absolute numbers are not portable to production, but the A/B/C comparison uses the same baseline in all three conditions, so the relative comparison remains valid.
2. **5 prompts cannot fully represent every task type**. Multi-turn agent tool-use scenarios are not covered. The author's proposal is meant to be universally applicable, however, and it already fails in our 5 simpler single-turn scenarios. The parallel v2 work, despite its statistical weakness, does provide indirect evidence on more complex scenarios — its `output_cn_ratio` of only 0–28% suggests the steering does not strongly comply on those scenarios either.
3. **N=10 has limited statistical power**. Effect sizes below 5pp at the per-prompt level are difficult to distinguish from noise. The headline findings, however, are either binary (zh%=0% on English prompts under A and B) or large (p3_en_debug C condition: +57pp), so they are not power-bound.
4. **Quality scoring was performed by the experimenter**, who has stakes. Mitigations: (a) condition and reasoning_content were hidden from the scorer; (b) the raw jsonl is preserved so anyone can re-score independently. The 0–3 scale was generous (27/30 trials scored 3), and it is not very sensitive to language-mismatch UX issues; a finer 5-point scale might widen the gap between conditions.
5. **Steering position is fixed at the system prompt** (no test of user-message-end placement, assistant-prefix placement, etc.).
6. **Effort × steering interaction was not factorial**. We tested `effort=max` only; v2 used `effort=high`, but the data is too thin to support a clean comparison.
7. **The "MUST" wording of the instruction was not ablated** (a softer "please prefer" framing might behave differently).

## 8. Conclusion

> Across N=150 pre-registered three-condition trials:
>
> **Condition B (issue #2 author's original proposal, English-language steering)**:
> 1. **Compliance is 36.0%**, statistically indistinguishable from the 34.2% baseline — **the instruction is effectively ignored**.
> 2. Token saving point estimate is +13%, but the 95% CI crosses zero, and the saving is decoupled from language switching.
> 3. KV cache hit rate drops by 12–13 percentage points.
>
> **Condition C (Chinese-language-steering ablation)**:
> 1. **Compliance is 50.9%** — barely above the threshold; the only statistically significant per-prompt effect is on p3_en_debug, where Chinese reasoning rises from 0% to 57%.
> 2. **Token saving is only +0.8%**, well below the 10% threshold; the theoretical Chinese-density advantage does not materialise.
> 3. **A new side-effect**: the model also answers English-language prompts in Chinese, a real product UX regression. Quality regression on the 0–3 scale is +6.7%.
> 4. KV cache hit rate also drops 12–13pp.
>
> **Both conditions REJECT, along different failure modes.** Combined with the parallel v2 work, this provides converging evidence that the steering approach is not viable.
>
> **Recommendation: close issue #2 with this report as the supporting decision document.** The author's underlying UX concern — that Chinese-speaking users find English reasoning chains hard to read in the OutputChannel — is real and worth addressing, but **not via runtime manipulation of the model's reasoning language**. Better alternatives:
> - Add a setting that hides or collapses thinking output in the OutputChannel
> - Improve log formatting (highlight key terms, fold long chains by default)
> - Provide an optional "translate reasoning to Chinese for display only" pass that runs locally on the cached `reasoning_content` (post-hoc, no API impact)
>
> All three options preserve token efficiency, leave the API request body unchanged, avoid cache penalties, and avoid the language-mismatch side-effect.

## 9. References

- [Shi, F. et al. (2022). Language Models are Multilingual Chain-of-Thought Reasoners. arXiv:2210.03057.](https://arxiv.org/pdf/2210.03057) — Table 3 Native-CoT vs EN-CoT data
- [Mythbuster: Chinese Language Is Not More Efficient Than English in Vibe Coding (arxiv 2604.14210, 2026)](https://arxiv.org/html/2604.14210v1) — empirical refutation of the "Chinese is cheaper" claim across 3 commercial models, including problem-solving rate comparison
- [EfficientXLang: Towards Improving Token Efficiency Through Cross-Lingual Reasoning (Microsoft Research, 2025)](https://arxiv.org/pdf/2507.00246) — conditional positive finding: non-English reasoning can save tokens on reasoning models when the prompt itself is in that language (not when steered via system prompt)
- [DeepSeek Token Usage doc (official)](https://api-docs.deepseek.com/quick_start/token_usage) — character-to-token conversion ratios
- [DeepSeek KV Cache doc (official)](https://api-docs.deepseek.com/guides/kv_cache) — full-prefix-match cache mechanism
- [DeepSeek Thinking Mode doc (official)](https://api-docs.deepseek.com/guides/thinking_mode) — `reasoning_effort` parameter semantics
- [Cross-lingual Prompting (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.163.pdf) — broader cross-lingual prompting study
- [Long Chain-of-Thought Reasoning Across Languages (2025)](https://arxiv.org/pdf/2508.14828) — recent work on long-chain CoT across languages

---

**Appendix — full reproducibility**: scripts, raw data, and blind scoring artifacts are all in this directory:

- [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) — experiment runner; pre-registered decision matrix at the top of the file
- [`analyze_experiment.py`](./analyze_experiment.py) — primary analysis (token / compliance / cache + decision-matrix application)
- [`prep_blind_scoring.py`](./prep_blind_scoring.py) — generates a blind scoring sample file
- [`analyze_blind_scores.py`](./analyze_blind_scores.py) — joins blind scores back to conditions
- [`score_blind.mjs`](./score_blind.mjs) — interactive scoring helper (alternative path; this run used the Python pipeline)
- [`data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl) — full 150-trial raw data
- [`data/scores_blind.json`](./data/scores_blind.json) — 30-trial blind scores plus rationales
- [`data/blind_scoring_key.json`](./data/blind_scoring_key.json) — trial_index → condition mapping (hidden during scoring; revealed during analysis)
- [`data/blind_scoring_sample.md`](./data/blind_scoring_sample.md) — the actual blinded sample shown to the scorer
- [`parallel-bench/`](./parallel-bench/) — preserved third-party parallel benchmark, with its own README documenting its methodological gaps
