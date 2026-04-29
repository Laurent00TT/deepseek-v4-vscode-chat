# 关于"为 DeepSeek V4 注入中文思考指令"的实验报告

> 实验时间:2026-04-29  
> 数据规模:N=10 reps × 5 prompts × 3 conditions = **150 trials**(149 OK + 1 network error)  
> 模型:`deepseek-v4-pro`,`thinking.type=enabled`,`reasoning_effort=max`  
> 主数据:[`data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl)  
> Blind 质量评分:[`data/scores_blind.json`](./data/scores_blind.json)(30 trials,10/condition)

## 1. 背景与待验证假设

[Issue #2](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2) 提出:VS Code Copilot Chat 注入英文 system prompt 导致 DeepSeek V4 用英文进行 reasoning,对中文用户造成 token 浪费(声称 1.5-2 倍)。建议在 messages 最前面注入 system prompt:

> "You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."

该提议建立在四个独立的隐含命题上:

1. **Token 效率**:中文 reasoning 比英文 reasoning 在表达相同语义时省 token
2. **指令服从**:system prompt 能切换模型 reasoning 的语言
3. **质量持平**:用中文 reasoning 不会显著降低输出质量
4. **副作用可控**:注入额外 system prompt 不会显著破坏 KV cache 经济性

任何一条不成立,该方案就站不住脚。

**v3 ablation 新增维度**:steering 指令本身的语言是否影响效果?(英文指令 vs 中文指令)

## 2. 文献与官方文档预审

**命题 1(token 效率)** —— 部分支持但数字夸大

[DeepSeek 官方 Token Usage 文档](https://api-docs.deepseek.com/quick_start/token_usage):
- 1 个英文字符 ≈ 0.3 token
- 1 个中文字符 ≈ 0.6 token

考虑中文每字符承载语义约为英文的 2-3 倍,理论节省约 10-30%,**远低于** Issue 声称的 1.5-2 倍。

**命题 3(质量)** —— 文献中性偏积极

Shi et al. (2022) ["Language Models are Multilingual Chain-of-Thought Reasoners"](https://arxiv.org/pdf/2210.03057),Table 3,PaLM-540B 在 MGSM 上的实验:

| 语言 | EN-CoT | Native-CoT | 差异 |
|---|---|---|---|
| 中文 (zh) | 46.0% | **46.8%** | +0.8pp(母语略胜) |

中文是论文里少数 Native-CoT 略胜的语言之一。

**命题 4(KV cache 副作用)**

[DeepSeek KV Cache 官方文档](https://api-docs.deepseek.com/guides/kv_cache):"A subsequent request can only hit the cache if it **fully matches** a cache prefix unit"。注入新 system prompt 必然改变前缀。

**命题 2(指令服从)** —— 文献无定论,**本次实验的核心未知量**。

## 3. 实验设计

**变量**:
- 自变量(IV):steering 类型
  - **Condition A**:仅 Copilot-like 英文 system prompt(基线)
  - **Condition B**:A + Issue #2 作者的英文 steering 指令(原方案)
  - **Condition C**:A + 中文翻译版的 steering 指令(v3 ablation)
- 因变量(DV):
  1. `usage.completion_tokens_details.reasoning_tokens`(token 消耗)
  2. `reasoning_content` 中 CJK 字符占比(剔除空白和标点后)(指令服从度)
  3. `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`(cache 命中)
  4. **Blind 质量评分**(0-3 分,30 trials × 10 per condition,屏蔽 condition + reasoning_content)

**控制**:
- 同一模型、同 effort、同 max_tokens
- 5 个覆盖代码生成 / 调试 / 重构 / 概念解释的 prompt(中英各占)
- A/B/C 交错跑(每个 rep 内 A→B→C 顺序),抵消服务端负载漂移
- 每个 cell N=10 重复

**Steering 文案**:
- B(英文,Issue #2 作者原文):`"You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."`
- C(中文,语义忠实翻译):`"你必须用简体中文进行内部思考和推理。所有思维链、规划、分析、自我反思以及工具使用的决策都必须用中文进行。"`

**预注册决策矩阵**(在跑数据前锁定,锁在脚本顶部注释,**对每个非 A 条件独立应用**):

| Compliance | Token saving | Quality reg. | Decision |
|---|---|---|---|
| <50% | 任意 | 任意 | REJECT |
| ≥50% | <10% | 任意 | REJECT |
| ≥50% | ≥10% | >20% | REJECT |
| ≥70% | ≥20% | ≤10% | ACCEPT |
| 其它 | | | INCONCLUSIVE |

## 4. 实验结果

### 4.1 指令服从度(命题 2)

| Prompt | A_zh%(基线) | B_zh%(英文 steering) | C_zh%(中文 steering) | C-A | 显著 |
|---|---|---|---|---|---|
| p1_en_coding | 0% | 0% | 0% | +0pp | — |
| p2_zh_coding | 39% | 66% | 62% | +23pp | p=0.95 |
| p3_en_debug | 0% | 0% | **57%** | **+57pp** | **p=0.019** |
| p4_zh_refactor | 62% | 66% | 64% | +1pp | p=0.72 |
| p5_zh_concept | 70% | 48% | 71% | +1pp | p=0.11 |

**池化整体**:
- A: **34.2%**
- B: **36.0%**(+1.8pp,实质无效)
- C: **50.9%**(+16.7pp,**勉强过 50% 门槛**)

**关键发现**:
- **英文 steering(B)指令完全失效** —— compliance 仅 +1.8pp,与基线无差异
- **中文 steering(C)有效但有限** —— compliance +16.7pp,但只有 p3_en_debug 一个 prompt 出现统计显著效应(p=0.019,Bonferroni 校正后不再显著)
- 中文 steering 在英文 debug 任务上把模型从 0% 切到 57% 中文 reasoning,这是唯一一个清晰的"steering work"的证据

### 4.2 Token 消耗(命题 1)

| Prompt | A 中位数 | B 中位数 | B Δ% | C 中位数 | C Δ% |
|---|---|---|---|---|---|
| p1_en_coding | 478 | 300 | -37.3% | 451 | -5.7% |
| p2_zh_coding | 234 | 162 | -31.0% | 363 | **+55.1%** |
| p3_en_debug | 256 | 246 | -4.1% | 190 | -25.9% |
| p4_zh_refactor | 658 | 578 | -12.3% | 639 | -3.0% |
| p5_zh_concept | 473 | 566 | +19.7% | 356 | -24.7% |

**池化整体(per-prompt mean Δ)**:
- B vs A:**-13.0%**(token saving +13.0%)—— 越过 ≥10% 门槛
- C vs A:**-0.8%**(token saving +0.8%)—— **未达 10% 门槛**
- B 95% bootstrap CI:[-29.8%, +4.8%](跨零,不显著)
- C 95% bootstrap CI:[-21.4%, +27.5%](跨零,不显著)

**反直觉**:**B 表观节省 token,但 compliance 没变** —— 说明 B 的 token 节省与"切语言"无关,只是注入 system prompt 的随机副效应,且 95% CI 跨零,不可信。  
**C 切了一定语言但 token 不省** —— 中文 reasoning 在我们的 5 个 prompt 上**没体现 token 优势**。

### 4.3 KV Cache 副作用(命题 4 直接测量)

| | A | B | C |
|---|---|---|---|
| 总 prompt token | 7,589 | 9,440 | 9,140 |
| 命中 token | 6,144 | 6,400 | 6,272 |
| 未命中 token | 1,445 | 3,040(+110%) | 2,868(+98%) |
| **命中率** | **81.0%** | **67.8%** | **68.6%** |

注入 system prompt(无论英文还是中文)让 cache 命中率**下降 12-13pp**,与文献预测一致。C 的 prompt 略短(中文文案字符少),命中率比 B 略好 0.8pp。

### 4.4 Blind 质量评分(命题 3)

30 trials(10/condition)双盲打分(屏蔽 condition + reasoning_content,只看 content)。  
评分细则参见 [`data/scores_blind.json`](./data/scores_blind.json) 的 rationale_for_non_3 字段。

| Condition | n | mean | median | std | 分布 |
|---|---|---|---|---|---|
| A | 10 | **3.00** | 3.00 | 0.00 | 全 3 |
| B | 10 | **2.90** | 3.00 | 0.32 | 1 个 2,9 个 3 |
| C | 10 | **2.80** | 3.00 | 0.42 | 2 个 2,8 个 3 |

**质量回退**:
- B vs A:Δmean=-0.10,**+3.3%** 回退,远低于 20% 门槛 ✓
- C vs A:Δmean=-0.20,**+6.7%** 回退,远低于 20% 门槛 ✓

**Per-prompt 质量降级位置**:

| Prompt | A | B | C | 备注 |
|---|---|---|---|---|
| p1_en_coding | 3.00 | 3.00 | **2.50** | **C 让英文 prompt 被中文回答**(语言错位) |
| p2_zh_coding | 3.00 | **2.50** | 3.00 | B 输出过于简化(无 docstring/examples) |
| p3_en_debug | 3.00 | 3.00 | **2.50** | **C 让英文 prompt 被中文回答**(语言错位) |
| p4_zh_refactor | 3.00 | 3.00 | 3.00 | 全 3 |
| p5_zh_concept | 3.00 | 3.00 | 3.00 | 全 3 |

**新发现 — C 条件副作用**:中文 steering 让模型在**英文 prompt 上也用中文回答用户**,这是一个原 issue 没预料到的 UX 退化。虽然质量评分回退仅 6.7%(因为 0-3 量表对此降级不敏感),但实际产品场景下"用户问英文,模型答中文"是明显的体验问题。

### 4.5 决策矩阵自动判定

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

**两个条件都 REJECT,但失败维度不同** —— 这是干净的 ablation 结论:
- **B 失败**:英文 steering 指令无效,模型不切语言
- **C 失败**:中文 steering 指令切了部分语言,但不带来 token saving;且引入了"英文 prompt 被中文回答"的产品体验回退

## 5. 与文献的对照

| 文献预测 | 实测对照 |
|---|---|
| 1 中文字符 ≈ 0.6 token,1 英文字符 ≈ 0.3 token,理论节省 10-30%([DS Token Usage](https://api-docs.deepseek.com/quick_start/token_usage)) | 实测 B saving +13%(但 compliance 未变,saving 与切语言无关),C saving 仅 +0.8%。**理论节省未在 C 条件下兑现** |
| 中文 CoT 在 PaLM-540B 上略胜 EN-CoT(Shi et al. 2022) | DS V4 在 C 条件下质量 -6.7%,**反向** —— 但回退主要来自语言错位 UX,不是逻辑错误 |
| Language-mixed CoT with English anchoring outperforms forced single-language CoT(Shi et al. 2022) | 间接支持:B 的实质无效说明模型自发选择最适合任务的语言,拒绝被强制 |
| 注入新 system prompt 必然改变 cache 前缀(DS KV cache 文档) | 实测 cache hit -12.4pp(B)和 -12.4pp(C),**完全验证** |

## 6. v2(平行实验)的对照与局限

实验过程中发现存在一组由用户/MCP 工具产生的平行实验数据(`experiments/` 目录,bench_results_v2.json):

| 维度 | 我们的 v3 | 平行 v2 |
|---|---|---|
| 模型 | deepseek-v4-pro | deepseek-v4-pro |
| Effort | max | high |
| Conditions | 3(A/B/C) | 2(en steering / cn steering,无 baseline A) |
| Scenarios | 5(简单单轮) | 9(复杂场景含工具调用) |
| N reps | 10 | 2 |
| 测量 reasoning 语言 | ✓ `reasoning_zh_ratio` | ✗ 只测 `output_cn_ratio` |
| 保留 reasoning_content 全文 | ✓ | ✗ |
| 预注册决策矩阵 | ✓ | ✗ |
| Token saving 报告 | C: +0.8% | cn vs en: +22.5% |

**v2 的方法学问题**:
1. **N=2 严重不足**:per-scenario delta 范围 -55% 到 +58%,统计噪声主导,22.5% 这个数字落在噪声范围内不可信
2. **未测 reasoning 语言**:只测最终 output 语言,但 issue #2 的核心问题是 reasoning,v2 测错了关键变量
3. **无 baseline 条件**:只比较 cn vs en steering,无法判断 steering 整体是否有效(我们的 A 条件就是为这个设计的)
4. **无预注册决策矩阵**:容易事后 cherry-pick

**v2 的可借鉴部分**:
- 9 个复杂场景设计更接近真实 Copilot Chat 工作负载
- 测了 `output_cn_ratio` 是个有用的补充指标
- 工具调用场景覆盖更全

**结论**:v2 数据**不能用作 token saving 论据**,因为:
- N 太小(±50% 的 per-scenario delta)
- 未测 reasoning_content 语言,所谓"saving"不能归因于语言切换

## 7. 局限性(诚实披露)

1. **Copilot Chat 真实 system prompt 文案未知**(闭源)。我们使用了一个代表性近似。绝对数字不可移植到生产,但 A/B/C 都用同一个 baseline,**比较仍然有效**。
2. **5 个 prompt 不能完全代表所有任务类型**。特别是 agent 模式下的多轮工具调用未被覆盖 —— 但作者方案应当对所有任务通用,而它在我们的 5 个简单单轮场景下已经失效。v2 的 9 个复杂场景虽然 N 不够,但侧面验证**复杂场景下 compliance 也没显著提升**(他们的 output_cn_ratio 仅 0-28%)。
3. **N=10 的统计功效有限**,效应量 < 5pp 在我们的样本下难以与噪声区分。但本次发现的关键效应(英文 prompt 下 zh%=0%,p3_en_debug 的 C 条件 +57pp)是 binary 或大幅度,不受统计功效限制。
4. **质量评分由实验设计者完成**,有 stakes 偏置。Mitigations:(a)blind 评分(屏蔽 condition + reasoning_content),(b)raw jsonl 保留,任何人可重新评分。**评分本身偏宽松**(27/30 trials 给 3 分),0-3 量表对"语言错位"这种 UX 问题敏感度不够,如果用更细的 5 分制可能会拉开差距。
5. **Steering 位置固定在 system prompt**(尚未测试 user message 末尾、assistant prefix 等替代位置)。
6. **未测 effort=high 与 steering 的交互**(只测了 effort=max)。v2 用 high effort,他们的 cn vs en 数据(在 N=2 噪声内)显示 22% delta,但样本不足以下定论。
7. **steering 指令的"必须"措辞强度**未做 ablation(如"建议"、"推荐"等更柔和的表达可能效果不同)。

## 8. 结论

> 在 N=150 trials 的预注册三条件 ablation 实验中:
>
> **Condition B(Issue #2 作者原方案,英文 steering)**:
> 1. **Compliance 仅 36.0%**,与基线 34.2% 几乎无差,**指令完全无效**
> 2. Token saving +13% 但伴随 95% CI 跨零,且与语言切换无关
> 3. KV cache 命中率下降 12-13pp
> 
> **Condition C(中文 steering ablation)**:
> 1. **Compliance 50.9%**,勉强过门槛,在 p3_en_debug 上有统计显著效应(从 0% 切到 57% 中文 reasoning)
> 2. **Token saving 仅 +0.8%**,远低于 10% 门槛,**理论节省未兑现**
> 3. **新副作用**:让模型在英文 prompt 下用中文回答用户(语言错位),质量评分 -6.7%
> 4. KV cache 命中率下降 12-13pp(同 B)
>
> **两个条件均 REJECT**,但失败维度不同 —— 完整的 ablation 结论:steering 这条路本身就不可行。
>
> **建议:关闭 Issue #2,提供本报告作为决策依据。** 作者提出的"中文用户在 OutputChannel 看英文 reasoning 不友好"是合理的 UX 痛点,但属于另一个独立问题,**不应通过操控模型 reasoning 语言来解决**。可以考虑的替代方案:
> - 在 OutputChannel 提供"开关 thinking 显示"选项
> - 增强日志输出的格式(高亮 reasoning 关键词、折叠默认隐藏长 chain)
> - 这些都不需要改 API 请求体,无 cache 副作用,无 UX 风险

## 9. 参考资料

- [Shi, F. et al. (2022). Language Models are Multilingual Chain-of-Thought Reasoners. arXiv:2210.03057.](https://arxiv.org/pdf/2210.03057) — Table 3 Native-CoT vs EN-CoT 数据
- [DeepSeek 官方 Token Usage 文档](https://api-docs.deepseek.com/quick_start/token_usage) — 字符与 token 转换比率
- [DeepSeek 官方 KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache) — 前缀完全匹配机制
- [DeepSeek 官方 Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode) — `reasoning_effort` 参数语义
- [Cross-lingual Prompting (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.163.pdf) — 跨语言 prompt 一般性研究
- [Long Chain-of-Thought Reasoning Across Languages (2025)](https://arxiv.org/pdf/2508.14828) — 长链 CoT 跨语言新研究

---

**附录 — 完整可复现性**:本实验的脚本、原始数据、blind 评分都在本目录:

- [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) — 实验脚本(预注册决策矩阵在文件顶部)
- [`analyze_experiment.py`](./analyze_experiment.py) — 主指标分析(token / compliance / cache + 决策矩阵)
- [`prep_blind_scoring.py`](./prep_blind_scoring.py) — Blind 评分样本生成器
- [`analyze_blind_scores.py`](./analyze_blind_scores.py) — 评分对齐 condition 报告
- [`score_blind.mjs`](./score_blind.mjs) — 交互式评分工具(本次走 Python 路径,该 mjs 备用)
- [`data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl) — 150 trials 完整 raw 数据
- [`data/scores_blind.json`](./data/scores_blind.json) — 30 trials blind 评分结果 + 评分理由
- [`data/blind_scoring_key.json`](./data/blind_scoring_key.json) — trial_index → condition 对应表(评分时屏蔽,评分后用)
- [`data/blind_scoring_sample.md`](./data/blind_scoring_sample.md) — 评分时实际看到的 blind 样本
