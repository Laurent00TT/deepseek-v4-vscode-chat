# DeepSeek V4 for Copilot Chat

> 🌐 本文是英文 [README](./README.md) 的中文版，**以英文版为准**；本页只覆盖使用向导内容，协议细节见英文 [ARCHITECTURE](./ARCHITECTURE.md)。同步时间：2026-08-22（v0.4 系列）。发现两版不一致欢迎提 issue。

VS Code Copilot Chat 的 DeepSeek V4（Pro / Flash / Flash Vision）原生模型提供方 —— 完整支持扩展思考（extended thinking）、Agent 模式工具调用、原生多模态图片输入与内置成本追踪。

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md) · [更新日志](./CHANGELOG.md) · [架构文档（英文）](./ARCHITECTURE.md)

## 功能

- 模型选择器中的六个变体：**Pro (thinking)**、**Pro**、**Flash (thinking)**、**Flash**、**Flash Vision (thinking)**、**Flash Vision**
- Vision 变体（`deepseek-v4-flash-vision-exp`）原生图片输入 —— 在 Copilot Chat 里附加截图/图片，DeepSeek 看到的是真实像素，中间没有任何代理模型
- 扩展思考支持可配置深度（`high` / `max`），推理链在多轮 Agent 循环中完整保留
- Agent 模式工具调用不会在第二轮报错中断
- 状态栏实时显示账户余额与本次会话花费（自动识别 CNY / USD）
- 状态栏悬浮面板显示 DeepSeek 分时计费窗口（高峰/非高峰两段均按本地时间列出，并标记当前所处的一段）
- 每会话上下文用量接入 Copilot Chat **原生**上下文指示器（chat 标题生成等辅助请求已被过滤，不会干扰指示器）
- 每轮对话后台静默刷新余额（防抖）
- 持久化推理缓存（VS Code 重启后仍在）
- 可操作的错误提示：400（reasoning）/ 401 / 402 / 422 / 429，以及流中途 `insufficient_system_resource` 截断处理
- 瞬时故障自动重试（5xx、429、网络抖动），尊重服务器的 `Retry-After`
- 自适应 token 估算器（用真实 `usage` 数据做 EMA 校准）
- 首次安装引导页；未配置密钥时模型条目带警告标识，始终可发现

## 模型

| 选择器条目 | API 模型 | 思考 | 图片 | 输入预算 | 输出预算 |
| ------ | ------ | :---: | :---: | ------ | ------ |
| DeepSeek V4 Pro (thinking) | `deepseek-v4-pro` | ✓ | — | 640K | 384K |
| DeepSeek V4 Pro | `deepseek-v4-pro` | — | — | 960K | 64K |
| DeepSeek V4 Flash (thinking) | `deepseek-v4-flash` | ✓ | — | 640K | 384K |
| DeepSeek V4 Flash | `deepseek-v4-flash` | — | — | 960K | 64K |
| DeepSeek V4 Flash Vision (thinking) | `deepseek-v4-flash-vision-exp` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash Vision | `deepseek-v4-flash-vision-exp` | — | ✓ | 960K | 64K |

所有变体共享 DeepSeek V4 的 1M 总上下文窗口（输入 + 输出）；thinking 变体预留全部 384K 输出预算，确保 max 深度的推理链不被静默截断。

## 原生视觉，不走代理

DeepSeek 于 2026-08-21 发布了首个多模态模型
[`deepseek-v4-flash-vision-exp`](https://api-docs.deepseek.com/news/news260821/)（V4 Flash 的实验性 Vision 变体），本扩展原生支持：在模型选择器中选择 **Flash Vision** 变体并附加图片，图片以 base64 `data:` URL 的形式放进 API 的多模态 content 块发送，模型看到的是真实像素。

我们从不把你的图片交给"视觉代理"（即先让另一个多模态模型描述图片再喂给 DeepSeek）。Vision 变体上 DeepSeek 直接看图；纯文本变体上图片附件会被丢弃并在日志中警告 —— 绝不会被其他模型转述。

注意事项：

- 支持格式：JPEG、PNG、GIF、WebP（不支持的附件会被丢弃并记录警告，不会让整个请求失败）
- 每张图片最多按 384 tokens 计费，价格与 Flash 相同
- API 请求体上限 48 MiB（base64 计入）；扩展会本地预检并提示"减少或缩小图片"，而不是抛出一个看不懂的服务端错误
- 扩展思考、Agent 工具调用、推理缓存往返在 Vision 变体上与 Flash 完全一致
- 模型带 `-exp` 后缀，DeepSeek 侧仍属实验性，偶有毛边属正常

## 本扩展独特解决的问题

通用 OpenAI 兼容桥接器在转发给 DeepSeek 时会丢掉 `reasoning_content` 字段，导致任何启用工具的 thinking 对话在第二轮硬性 400：

```text
The reasoning_content in the thinking mode must be passed back to the API.
```

本扩展是原生 VS Code Language Model Provider —— 拦截每个请求，从本地缓存恢复先前的 `reasoning_content`，并重新挂载到历史中的每个 assistant 轮（不只是调用过工具的轮——`tools` 存在时 DeepSeek 实际要求的是全部轮）。结果：Agent 循环、多轮重构、长思考会话端到端可用。

## 快速开始

1. 从 VS Code Marketplace 安装 **DeepSeek V4 for Copilot Chat**。
2. 命令面板运行 `Manage DeepSeek V4 Provider`，粘贴你的 [DeepSeek API 密钥](https://platform.deepseek.com/api_keys)。
3. 打开 Copilot Chat，在模型选择器中选一个 DeepSeek V4 变体，开聊。

## 命令

| 命令 | 说明 |
| ------ | ------ |
| `Manage DeepSeek V4 Provider` | 设置或更新 API 密钥 |
| `Refresh DeepSeek V4 Balance` | 拉取最新账户余额 |
| `Show DeepSeek V4 Log` | 打开运行日志频道 |
| `Show DeepSeek V4 Reasoning Cache Stats` | 推理缓存诊断 |
| `Clear DeepSeek V4 Reasoning Cache` | 清空缓存的 `reasoning_content`（如分享日志前、切换项目后） |
| `Clear DeepSeek V4 Session Counter` | 重置会话花费显示 |
| `DeepSeek V4: Compact Copilot Chat` | 上下文接近上限时桥接到 Copilot Chat 的 `/compact` 流程（未装 Copilot Chat 则提示并跳过） |

## 设置

| 设置项 | 取值 | 默认 | 说明 |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `high` \| `max` | `max` | `(thinking)` 变体的推理深度。`high` 更快、推理链更短；`max` 最深。对非 thinking 变体无效。请求时读取。 |
| `deepseekv4.logRawReasoning` | `boolean` | `false` | 把原始 `reasoning_content` 流式写入日志频道。调试 prompt-cache 击穿时有用，但可能捕获私有代码/路径/中间状态 —— 提 bug 附日志时请保持**关闭**。 |

## 计费与 Copilot 高级请求配额

本扩展发出的所有请求都只到 `api.deepseek.com`，用**你的** DeepSeek 密钥认证，只从你的 DeepSeek 余额扣费。它从不调用 GitHub/Copilot 端点，没有任何代码路径会消耗你的 Copilot 配额。

但注意：**Agent 模式**下，Copilot Chat 宿主自身可能启动后台**子代理**（`agent` / `runSubagent` 工具，典型如 Explore Agent），它们默认跑在 Copilot 托管模型上（无视你选的模型），这部分**会**消耗 Copilot 高级请求。这是影响所有 BYOK 提供方的平台行为（上游追踪 [community#197840](https://github.com/orgs/community/discussions/197840)，本仓库 [#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16)）。规避方式：

1. Agent 模式下打开工具选择器（Configure Tools），**取消勾选 `agent` / `runSubagent` 工具**（最可靠）
2. 或把 Explore Agent 指到你的模型：`github.copilot.chat.exploreAgent.model` → 某个 DeepSeek V4 模型
3. 或不需要工具调用的轮次改用 Ask 模式

## 常见问题

**报错 `The reasoning_content in the thinking mode must be passed back to the API`（400）。**
DeepSeek thinking 模式要求把先前 assistant 轮的推理链传回。本扩展从本地缓存恢复它；报这个错说明会话中某一轮在缓存里没有条目（安装扩展前的历史、缓存被清空、超长会话中被淘汰）。恢复方式：新开会话。诊断：*Show DeepSeek V4 Reasoning Cache Stats*。

**弹出警告 "prompt cache hit rate dropped"。**
你这个会话在 DeepSeek 服务端的缓存前缀断了（常见于某轮被取消/失败、编辑器重启之后），后续轮次将按更贵的 cache-miss 输入价计费。弹窗里的 *Start New Chat* 止损，*Show Cache Stats* 诊断。背景见 [#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19)。

**Copilot 上下文窗口指示器显示 0 / 0%。**
把 VS Code 升级到 **1.120 或更新**。扩展一直在上报用量，但宿主侧为扩展提供的模型显示用量的代码 VS Code 1.120 才发布（[#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18)、[microsoft/vscode#315394](https://github.com/microsoft/vscode/issues/315394)）。

**我附加的图片好像被忽略了。**
只有 **Flash Vision** 变体会发送图片 —— 纯文本变体会丢弃图片并在日志中警告（绝不代理转述）。另外检查格式（JPEG/PNG/GIF/WebP）和请求总大小（DeepSeek 请求体上限 48 MiB，base64 计入）。

**为什么不支持 OpenRouter / 自定义 base URL？**
有意为之 —— 详见 [#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4) 的讨论。OpenRouter 会把 DeepSeek 的 thinking 协议归一化成另一套形状（`reasoning_details` 而非 `reasoning_content`、不同的 thinking 开启参数、没有缓存命中计数），恰好破坏本扩展存在的意义。OpenRouter 上的 DeepSeek 接入应由独立的 provider 承担（例如 #4 提问者自建的 [ostash/openrouter-chat-provider](https://github.com/ostash/openrouter-chat-provider)）。

## 隐私

- **零遥测。** 扩展不向任何人上报数据；唯一的网络对端是 `api.deepseek.com`。
- API 密钥存放在 VS Code **SecretStorage**（系统钥匙串），不落设置文件。
- 持久化推理缓存可能包含你的代码与提示词片段；*Clear DeepSeek V4 Reasoning Cache* 可一键清空（如分享日志前、切换项目后）；`deepseekv4.logRawReasoning` 默认关闭，推理内容不会未经同意进入日志。
- 图片附件作为请求的一部分直达 DeepSeek，绝不经过任何第三方模型。

## 许可

MIT，见 [LICENSE](./LICENSE)。Fork 自 [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat)，协议层为 DeepSeek V4 重写。
