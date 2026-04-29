# Issue #2:为 DeepSeek V4 注入中文 reasoning 指令

> 状态:**已关闭(REJECT)**  
> 关联:[Issue #2 - Feature Request](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/2)  
> 实验日期:2026-04-29  
> 决策:不实现该 feature。详细论证见 [REPORT.md](./REPORT.md)

## 一句话概述

我们用 N=100 trials 的预注册实验验证作者方案,**所有三项关键指标均不达标**:
- 指令服从度 34.8%(门槛 ≥50%)
- Token saving −4%(门槛 ≥10%)
- KV cache 命中率额外下降 9.9pp

## 文件结构

| 文件 | 用途 |
|---|---|
| [`REPORT.md`](./REPORT.md) | 完整中文报告(背景、方法、数据、文献对照、结论) |
| [`experiment_chinese_reasoning.mjs`](./experiment_chinese_reasoning.mjs) | 实验脚本(产生原始数据);**预注册决策矩阵在文件顶部注释** |
| [`analyze_experiment.py`](./analyze_experiment.py) | 分析脚本(从 jsonl 算 summary + Wilcoxon p + bootstrap CI) |
| [`score_blind.mjs`](./score_blind.mjs) | Blind 质量评分工具(本次未用,因为决策已在 compliance 这一关被 reject) |
| [`data/*.jsonl`](./data) | 原始数据(每行一个 trial,含完整 reasoning_content + content + usage) |

## 数据文件

| 文件 | 说明 |
|---|---|
| `data/experiment_chinese_reasoning_2026-04-29T05-23-43.jsonl` | **主数据**:full run, N=10 reps × 5 prompts × 2 conditions = 100 trials |
| `data/experiment_chinese_reasoning_2026-04-29T04-33-13_quick.jsonl` | Smoke test 通过版(N=2,验证脚本工作正常) |
| `data/experiment_chinese_reasoning_2026-04-29T04-22-23_quick.jsonl` | Smoke test 全 401 版(API key 失效那次,保留作审计 trail) |

## 复现命令

```bash
# 1. 跑完整实验(需要 DEEPSEEK_API_KEY,~50 分钟,~¥3-5 成本)
DEEPSEEK_API_KEY=sk-... node docs/experiments/issue-2-chinese-reasoning/experiment_chinese_reasoning.mjs

# 2. 分析数据
python docs/experiments/issue-2-chinese-reasoning/analyze_experiment.py \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>

# 3. (可选)blind 质量评分
node docs/experiments/issue-2-chinese-reasoning/score_blind.mjs \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file>
node docs/experiments/issue-2-chinese-reasoning/score_blind.mjs \
    docs/experiments/issue-2-chinese-reasoning/data/<jsonl-file> --analyze
```

## 这次探索的方法学要点

1. **预注册决策矩阵** —— 跑数据前锁死接受/拒绝条件,避免事后 rationalize
2. **A/B 交错跑** —— 每个 rep 内 A→B 顺序,抵消 DS 服务端负载随时间的漂移
3. **唯一变量原则** —— A 和 B 唯一差异是注入 system prompt;baseline 系统提示完全相同
4. **保留完整 raw 数据** —— jsonl 含 reasoning_content 全文,任何指标可重新计算
5. **Blind 质量评分独立工具** —— 评分时屏蔽 condition 标签和 reasoning_content,避免污染
6. **客观文献预审** —— 跑实验前先查文献和官方文档,避免重复造轮子,定位真正的未知量

## 给未来扩展实验的建议

如果未来有人想重启这个方向,以下是本次未做但有价值的扩展:

- **测试中文写就的 Chinese-steering prompt**(本次照搬作者英文版)
- **测试把指令放在 user message 里**(本次只测 system prompt 位置)
- **覆盖 agent 多轮工具调用场景**(本次只覆盖单轮简单任务)
- **测试不同 model variant**(本次只测 deepseek-v4-pro,未测 flash)
- **更大的 N**(本次 N=10,统计功效仅够检测 ≥10pp 的效应)
- **加入 quality 评分**(本次因 compliance 已 reject,未做 blind scoring;若要做完整评估,需要补)

## 关于"探索"标签

本次属于**小规模试探性研究**,不是完整工程化的 benchmark。目的是回答一个具体的 issue,数据规模和统计严谨度足够支撑该 issue 的决策,但**不应当**被引用为"中文 reasoning 在 DeepSeek V4 上一定无效"的通用结论 —— 我们的 prompt 集小、变量未穷举,负面结果只能拒绝**这个具体方案**。
