# Issue #2:为 DeepSeek V4 注入中文 reasoning 指令

> 状态:**已关闭(REJECT)**  
> 关联:[Issue #2 - Feature Request](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2)  
> 实验日期:2026-04-29  
> 决策:不实现该 feature。详细论证见 [REPORT.md](./REPORT.md)

## 一句话概述

我们用 **N=150 trials** 的预注册实验(三条件 ablation)+ **30 trials blind 质量评分**验证作者方案及其变体:
- **Condition A**(无 steering,基线)
- **Condition B**(英文 system prompt steering,作者原方案)→ **REJECT**(compliance 36.0% < 50%,指令无效)
- **Condition C**(中文 system prompt steering,我们补充的 ablation)→ **REJECT**(token saving +0.8% < 10%,且引入"英文 prompt 被中文回答"的 UX 副作用)

**两个条件均 REJECT,但失败维度不同**。质量评分 A=3.00 / B=2.90 / C=2.80(0-3 量表),回退均 < 10%,远低于 20% 门槛,质量不是 reject 原因。

详细数据与决策见 [REPORT.md](./REPORT.md)。

## 文件结构

| 文件 | 用途 |
|---|---|
| [`REPORT.md`](./REPORT.md) | 完整中文报告(背景、方法、数据、文献对照、结论) |
| [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) | 实验脚本(产生原始数据);**预注册决策矩阵在文件顶部注释** |
| [`analyze_experiment.py`](./analyze_experiment.py) | 主指标分析(token / compliance / cache + 决策矩阵) |
| [`prep_blind_scoring.py`](./prep_blind_scoring.py) | Blind 评分样本生成器(stratified sample + 屏蔽 condition) |
| [`analyze_blind_scores.py`](./analyze_blind_scores.py) | 评分对齐 condition 后的质量回退报告 |
| [`score_blind.mjs`](./score_blind.mjs) | 交互式评分工具(本次走 Python 路径,该 mjs 备用) |
| [`data/*.jsonl`](./data) | 原始数据(每行一个 trial,含完整 reasoning_content + content + usage) |
| [`data/scores_blind.json`](./data/scores_blind.json) | 30 trials blind 评分结果 + 评分理由 |
| [`data/blind_scoring_key.json`](./data/blind_scoring_key.json) | trial_index → condition 对应表 |
| [`data/blind_scoring_sample.md`](./data/blind_scoring_sample.md) | 评分时实际看到的 blind 样本 |

## 数据文件

| 文件 | 说明 |
|---|---|
| `data/experiment_chinese_reasoning_2026-04-29T07-51-18.jsonl` | **v3 主数据**:N=10 × 5 prompts × 3 conditions = **150 trials**(149 OK + 1 net err) |
| `data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl` | v1 早期数据:N=10 × 5 prompts × 2 conditions = 100 trials(无 condition C) |
| `data/experiment_chinese_reasoning_2026-04-29T06-34-43_quick.jsonl` | v3 smoke(N=2,3 条件脚本验证) |
| `data/experiment_chinese_reasoning_2026-04-29T06-18-01_quick.jsonl` | v3 smoke 全 401(API key 失效) |
| `data/experiment_chinese_reasoning_2026-04-29T04-33-13_quick.jsonl` | v1 smoke 通过(N=2,初版双条件) |
| `data/experiment_chinese_reasoning_2026-04-29T04-22-23_quick.jsonl` | v1 smoke 全 401(更早一次 key 失效) |

## 复现命令

```bash
# 1. 跑完整实验(需要 DEEPSEEK_API_KEY,~70 分钟 / 150 trials)
DEEPSEEK_API_KEY=sk-... node docs/experiments/issue-2-chinese-reasoning/experiment_chinese_reasoning.mjs

# 2. 主指标分析(token / compliance / cache + 决策矩阵)
python docs/experiments/issue-2-chinese-reasoning/analyze_experiment.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>

# 3. Blind 质量评分(可选,用 Python 路径)
python docs/experiments/issue-2-chinese-reasoning/prep_blind_scoring.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>
# 评分者读 data/blind_scoring_sample.md,把分数写到 data/scores_blind.json
python docs/experiments/issue-2-chinese-reasoning/analyze_blind_scores.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>

# 4. (备选) 交互式评分工具
node docs/experiments/issue-2-chinese-reasoning/score_blind.mjs \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>
```

## 这次探索的方法学要点

1. **预注册决策矩阵** —— 跑数据前锁死接受/拒绝条件,避免事后 rationalize
2. **A/B 交错跑** —— 每个 rep 内 A→B 顺序,抵消 DS 服务端负载随时间的漂移
3. **唯一变量原则** —— A 和 B 唯一差异是注入 system prompt;baseline 系统提示完全相同
4. **保留完整 raw 数据** —— jsonl 含 reasoning_content 全文,任何指标可重新计算
5. **Blind 质量评分独立工具** —— 评分时屏蔽 condition 标签和 reasoning_content,避免污染
6. **客观文献预审** —— 跑实验前先查文献和官方文档,避免重复造轮子,定位真正的未知量

## 给未来扩展实验的建议

本次 v3 已经覆盖:
- ✅ 中文写就的 Chinese-steering prompt(Condition C)
- ✅ Blind 质量评分(score_blind.mjs)

仍未覆盖、值得未来探索的方向:

- **测试把指令放在 user message 里**(本次三个条件都在 system prompt 位置)
- **覆盖 agent 多轮工具调用场景**(本次只覆盖单轮简单任务)
- **测试不同 model variant**(本次只测 deepseek-v4-pro,未测 flash)
- **测试不同 effort**(本次只测 max,v2 测了 high,值得正式做 effort × steering 因子)
- **更大的 prompt 集**(本次 5 个偏简单,可借鉴 v2 的 9 个复杂场景重做)

## 关于"探索"标签

本次属于**小规模试探性研究**,不是完整工程化的 benchmark。目的是回答一个具体的 issue,数据规模和统计严谨度足够支撑该 issue 的决策,但**不应当**被引用为"中文 reasoning 在 DeepSeek V4 上一定无效"的通用结论 —— 我们的 prompt 集小、变量未穷举,负面结果只能拒绝**这个具体方案**。
