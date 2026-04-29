# 关于"为 DeepSeek V4 注入中文思考指令"的实验报告

> 实验时间:2026-04-29  
> 数据样本:N=10 reps × 5 prompts × 2 conditions = 100 trials  
> 模型:`deepseek-v4-pro`,`thinking.type=enabled`,`reasoning_effort=max`  
> 原始数据:[`data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl)

## 1. 背景与待验证假设

[Issue #2](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2) 提出:VS Code Copilot Chat 注入英文 system prompt,导致 DeepSeek V4 用英文进行 reasoning,对中文用户造成 token 浪费(声称 1.5-2 倍)。建议在 messages 最前面注入 system prompt:

> "You MUST think and reason internally in Simplified Chinese (简体中文). Conduct all chain-of-thought, planning, analysis, self-reflection, and tool-use decisions in Chinese."

该提议建立在四个独立的隐含命题上:

1. **Token 效率**:中文 reasoning 比英文 reasoning 在表达相同语义时省 token
2. **指令服从**:system prompt 能切换模型 reasoning 的语言
3. **质量持平**:用中文 reasoning 不会显著降低输出质量
4. **副作用可控**:注入额外 system prompt 不会显著破坏 KV cache 经济性

任何一条不成立,该方案就站不住脚。

## 2. 文献与官方文档预审

**命题 1(token 效率)** —— 部分支持但数字夸大

[DeepSeek 官方 Token Usage 文档](https://api-docs.deepseek.com/quick_start/token_usage) 给出:
- 1 个英文字符 ≈ 0.3 token
- 1 个中文字符 ≈ 0.6 token

考虑中文每字符承载语义约为英文的 2-3 倍,理论节省约 10-30%,**远低于** Issue 声称的 1.5-2 倍。

**命题 3(质量)** —— 文献中性偏积极

Shi et al. (2022) ["Language Models are Multilingual Chain-of-Thought Reasoners"](https://arxiv.org/pdf/2210.03057),Table 3,PaLM-540B 在 MGSM 上的实验:

| 语言 | EN-CoT | Native-CoT | 差异 |
|---|---|---|---|
| 中文 (zh) | 46.0% | **46.8%** | +0.8pp(母语略胜) |

论文整体结论:"Reasoning in English (EN-CoT) consistently achieves competitive or better performance than reasoning in the native language",但**中文是反例之一**,母语 CoT 在 PaLM-540B 上略优。

**命题 4(KV cache 副作用)**

[DeepSeek KV Cache 官方文档](https://api-docs.deepseek.com/guides/kv_cache):"A subsequent request can only hit the cache if it **fully matches** a cache prefix unit"。注入新 system prompt 必然改变前缀,**首次必 miss**,稳定后才可能恢复命中。

**命题 2(指令服从)** —— 文献无定论,**唯一需要实验回答的命题**。

## 3. 实验设计

**变量**:
- 自变量(IV):是否注入 Issue #2 作者提出的 system prompt(原文照搬,未修改)
  - Condition A:仅模拟 Copilot Chat 风格的英文 system prompt(基线)
  - Condition B:在 A 之前再加一条 Chinese-steering system prompt
- 因变量(DV):
  1. `usage.completion_tokens_details.reasoning_tokens`(token 消耗)
  2. `reasoning_content` 中 CJK 字符占比(剔除空白和标点后)(指令服从度)
  3. `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`(cache 命中)

**控制**:
- 同一模型、同 effort、同 max_tokens
- 5 个覆盖代码生成 / 调试 / 重构 / 概念解释的 prompt(中英各占)
- A/B 交错跑(每个 rep 内先 A 后 B),抵消服务端负载漂移
- 每个 cell N=10 重复

**预注册决策矩阵**(在跑数据前锁定,锁在脚本顶部注释):

| Compliance | Token saving | Quality reg. | Decision |
|---|---|---|---|
| <50% | 任意 | 任意 | REJECT |
| ≥50% | <10% | 任意 | REJECT |
| ≥50% | ≥10% | >20% | REJECT |
| ≥70% | ≥20% | ≤10% | ACCEPT |
| 其它 | | | INCONCLUSIVE |

## 4. 实验结果

### 4.1 指令服从度(命题 2 直接测量)

| Prompt | A_zh%(基线) | B_zh%(注入后) | Δ | Wilcoxon p |
|---|---|---|---|---|
| p1_en_coding | 0% | **0%** | +0pp | 0.575 |
| p2_zh_coding | 48% | 60% | +12pp | 0.386 |
| p3_en_debug | 0% | **0%** | +0pp | 0.476 |
| p4_zh_refactor | 71% | 65% | **−6pp** | 0.575 |
| p5_zh_concept | 68% | 49% | **−19pp** | 0.445 |

**池化整体 B compliance:34.8%**。

**关键观察**:
- 英文 prompt 下,模型 reasoning **100% 是英文**,注入"You MUST think in Chinese"完全被忽略
- 中文 prompt 下,基线本就 48-71% 中文 reasoning;注入指令后,3/5 中文 prompt 反而**降低**了中文比例
- **所有 5 个 prompt 的 Wilcoxon p 值均 > 0.38**,无任何统计显著的语言切换效应

### 4.2 Token 消耗(命题 1 直接测量)

| Prompt | A 中位数 | B 中位数 | Δ% | 方向 |
|---|---|---|---|---|
| p1_en_coding | 350 | 419 | **+19.9%** | B 多用 |
| p2_zh_coding | 256 | 322 | **+26.2%** | B 多用 |
| p3_en_debug | 250 | 234 | −6.0% | B 略少 |
| p4_zh_refactor | 564 | 498 | −11.6% | B 较少 |
| p5_zh_concept | 470 | 430 | −8.5% | B 略少 |

**整体**:
- 每 prompt 中位数 Δ% 的均值:**+4.0%**(B 反而比 A 多用 4% token)
- Bootstrap 95% CI:**[−9.3%, +18.0%]**(跨零,无显著效果)
- 方向一致性:仅 3/5 prompt 出现 B<A,**完全不达 ≥10% saving 门槛**

### 4.3 KV Cache 副作用(命题 4 直接测量)

| | A(基线) | B(注入后) |
|---|---|---|
| 总 prompt token | 7,740 | 9,440(+22%) |
| 命中 token | 6,016 | 6,400 |
| 未命中 token | 1,724 | **3,040(+76%)** |
| **命中率** | **77.7%** | **67.8%** |

注入操作让命中率**下降了 9.9 个百分点**,未命中 token 数翻了 76%。

### 4.4 决策矩阵自动判定

```
Overall B compliance (mean zh%): 34.8%
→ REJECT: instruction ignored (compliance < 50%)
```

第一关 compliance 即不达标,后续条件不再检查。

## 5. 与文献的对照

| 文献预测 | 实测对照 |
|---|---|
| 1 个英文字符 ≈ 0.3 token,1 个中文字符 ≈ 0.6 token —— 预期中文 reasoning 节省 10-30% token([DS 官方文档](https://api-docs.deepseek.com/quick_start/token_usage)) | 实测 B 反而**多用 4%** token。原因:模型在英文 prompt 下根本没切到中文 reasoning |
| 中文 CoT 在 PaLM-540B 的 MGSM 上略胜 EN-CoT 0.8pp(Shi et al. 2022) | 我们没测到这个,因为指令根本没让模型切到中文 reasoning |
| Language-mixed CoT with English anchoring outperforms forced single-language CoT(Shi et al. 2022) | 间接支持:模型自发选择英/中混合,拒绝被强制单语 |
| 注入新 system prompt 必然改变 cache 前缀(DS 官方 KV cache 文档) | 实测命中率 −9.9pp,未命中 token +76%,**完全验证** |

## 6. 局限性(诚实披露)

1. **Copilot Chat 真实 system prompt 文案未知**(闭源)。我们使用了一个代表性近似。绝对数字不可移植到生产,但 A/B 的相对差异在两个 condition 下使用相同 baseline,**比较仍然有效**。
2. **5 个 prompt 不能完全代表所有任务类型**。特别是 agent 模式下的多轮工具调用未被覆盖 —— 但作者的方案应当对所有任务通用,而它在我们的 5 个简单单轮场景下已经失效。
3. **N=10 的统计功效有限**,效应量 < 5pp 在我们的样本下难以与噪声区分。但本次发现的关键效应(英文 prompt 下 zh%=0%)是 binary,不受统计功效限制。
4. **未做质量评分**(命题 3)。原计划在通过命题 1+2 后再进行 blind quality scoring,但因为 1+2 已经决定性 reject,该步骤未执行。如果未来有人重启该方向,需要补做。
5. **没有测试中文写就的 system prompt 是否更有效**(作者用的是英文写的指令)。该变体超出本次 scope,但是值得未来探索的方向 —— **不影响本次对作者原方案的拒绝判定**。
6. **未测"指令放在 user message 而非 system prompt"等替代位置**。同上。

## 7. 结论

> 在 N=100 trials 的预注册实验中,Issue #2 提出的"注入中文 system prompt 让 DS V4 用中文 reasoning"方案**未通过任何一项验收标准**:
>
> 1. **指令服从度仅 34.8%**(预设门槛 ≥50%),其中英文 prompt 下完全无效(0% → 0%),中文 prompt 下无积极效果或反而降低
> 2. **Token 节省 −4%**(预设门槛 ≥10%),实际反而多用,95% CI [−9.3%, +18.0%] 跨零
> 3. **KV cache 命中率下降 9.9pp**,未命中 token +76%,与文献预测一致
>
> 文献(Shi et al. 2022)和官方文档([DS Token Usage](https://api-docs.deepseek.com/quick_start/token_usage)、[KV Cache](https://api-docs.deepseek.com/guides/kv_cache))在背景预审阶段已经提示该方案的可疑点,实验数据进一步从经验上证伪。
>
> **建议:关闭 Issue #2,提供本报告作为决策依据。** 作者提出的 Output Channel 中文阅读体验是合理的 UX 痛点,但属于另一个独立问题,不应通过操控模型 reasoning 语言来解决。

## 8. 参考资料

- [Shi, F. et al. (2022). Language Models are Multilingual Chain-of-Thought Reasoners. arXiv:2210.03057.](https://arxiv.org/pdf/2210.03057) — Table 3 Native-CoT vs EN-CoT 数据
- [DeepSeek 官方 Token Usage 文档](https://api-docs.deepseek.com/quick_start/token_usage) — 字符与 token 转换比率
- [DeepSeek 官方 KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache) — 前缀完全匹配机制
- [DeepSeek 官方 Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode) — `reasoning_effort` 参数语义
- [Cross-lingual Prompting (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.163.pdf) — 跨语言 prompt 一般性研究
- [Long Chain-of-Thought Reasoning Across Languages (2025)](https://arxiv.org/pdf/2508.14828) — 长链 CoT 跨语言新研究

---

**附录**:本实验完全可复现。脚本与原始数据均在本目录:

- [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) — 实验脚本(预注册决策矩阵在文件顶部)
- [`analyze_experiment.py`](./analyze_experiment.py) — 分析脚本
- [`score_blind.mjs`](./score_blind.mjs) — Blind 质量评分工具(本次未用)
- [`data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl`](./data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl) — 100 trials 完整原始数据
