# DeepSeek V4 for Copilot Chat

> 🌐 本文是英文 [README](./README.md) 的中文版，**以英文版为准**；协议细节见英文 [ARCHITECTURE](./ARCHITECTURE.md)。同步时间：2026-08-22。发现两版不一致欢迎提 issue。

在 VS Code Copilot Chat 里把 DeepSeek V4（Pro / Flash / Flash Vision）当原生模型用 —— 扩展思考、Agent 模式工具调用、图片输入，以及状态栏里你真实的 DeepSeek 账单。

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md) · [更新日志](./CHANGELOG.md) · [架构文档（贡献者向，英文）](./ARCHITECTURE.md)

## 快速开始

你需要 VS Code 1.106+、已登录的 **GitHub Copilot Chat** 扩展（本扩展只是往它的模型选择器里加模型），以及一个有 API 余额的 DeepSeek 账号。

1. 从 VS Code Marketplace 安装 **DeepSeek V4 for Copilot Chat**。
2. 命令面板 → `Manage DeepSeek V4 Provider` → 粘贴你的 [DeepSeek API 密钥](https://platform.deepseek.com/api_keys)。
3. 在 Copilot Chat 的模型选择器里选一个 DeepSeek V4 变体。如果列表里没有，点选择器里的 **Manage Models…**，启用 DeepSeek V4。

## 模型

| 选择器条目 | API 模型 | 思考 | 图片 | 输入预算 | 输出预算 |
| ------ | ------ | :---: | :---: | ------ | ------ |
| DeepSeek V4 Pro (thinking) | `deepseek-v4-pro` | ✓ | — | 640K | 384K |
| DeepSeek V4 Pro | `deepseek-v4-pro` | — | — | 960K | 64K |
| DeepSeek V4 Flash (thinking) | `deepseek-v4-flash` | ✓ | — | 640K | 384K |
| DeepSeek V4 Flash | `deepseek-v4-flash` | — | — | 960K | 64K |
| DeepSeek V4 Flash Vision (thinking) | `deepseek-v4-flash-vision-exp` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash Vision | `deepseek-v4-flash-vision-exp` | — | ✓ | 960K | 64K |

**(thinking)** 变体会先在隐藏的思维链里推理再作答 —— 更慢、更费 token，但更擅长难题和 Agent 任务；不带后缀的变体直接作答。所有变体共享 DeepSeek V4 的 1M token 上下文（输入 + 输出）；thinking 变体为输出预留 384K，以免长推理链被截断。

## 你能得到什么

- 扩展思考，深度可选（`high` / `max`），推理链跨多轮 Agent 循环保留
- Agent 模式工具调用，长多轮循环照常工作 —— 工具结果和模型自己的推理逐轮带下去
- Vision 变体原生支持图片输入
- 状态栏实时显示账户余额（自动识别 CNY / USD）；悬浮层另有本次会话花费，以及按本地时间列出的 DeepSeek 高峰 / 非高峰计费窗口并标出当前所处的一段
- 上下文窗口用量接入 Copilot Chat 原生指示器（需 VS Code 1.120+）
- 带处理建议的错误提示（400 / 401 / 402 / 422 / 429），临时故障自动重试
- 首次运行演练（Walkthrough）；未设密钥时选择器条目显示警告而不是消失

## 图片（Vision 变体）

选一个 **Flash Vision** 变体，在 Copilot Chat 里附加图片即可；思考和工具调用与 Flash 完全一致。

- 格式：JPEG、PNG、GIF、WebP。其他附件 —— 以及发给纯文本变体的图片 —— 都会被丢弃，绝不会由其他模型转述。
- 限制：每个请求 48 MiB（base64 计入）、单张图片 32 MiB，两者都在发送前本地检查。
- 费用：每张图片最多 384 tokens，按 Flash 价格计费。
- `-exp` 表示 DeepSeek 侧仍是实验性模型（[发布说明，2026-08-21](https://api-docs.deepseek.com/news/news260821/)），偶有毛边属正常。

## 为什么要原生 provider？

通用的 OpenAI 兼容桥接器为 DeepSeek V4 做不到的两件事：

- **推理往返。** DeepSeek thinking 模式期望下一次请求带回每个先前 assistant 轮的 `reasoning_content` —— 不带就硬性 400，直到 2026-08-22 的一次实测发现服务端已放宽（文档仍保留该规则）—— 而 VS Code 的聊天历史没有这个字段。本扩展把它缓存在本地，并在每次请求时重新附加到历史里的 assistant 轮上：模型在 Agent 多轮里保有自己的思维链，每次请求也与 DeepSeek 已缓存的内容字节级一致，从而一直享受更便宜的缓存命中输入价。
- **真实费用，不是估算。** 余额与会话花费来自 DeepSeek 的 `/user/balance`；缓存命中 / 未命中 token 来自真实的 `usage` 数据。

## 命令

| 命令 | 说明 |
| ------ | ------ |
| `Manage DeepSeek V4 Provider` | 设置或更新 API 密钥 |
| `Refresh DeepSeek V4 Balance` | 拉取最新账户余额 |
| `Show DeepSeek V4 Log` | 打开运行日志输出通道 |
| `Show DeepSeek V4 Reasoning Cache Stats` | 推理缓存诊断 |
| `Clear DeepSeek V4 Reasoning Cache` | 清空缓存的 `reasoning_content`（如分享日志前） |
| `Clear DeepSeek V4 Session Counter` | 重置会话花费显示 |
| `Compact Copilot Chat` | 上下文接近上限时运行 Copilot Chat 的 `/compact` |

## 设置

| 设置项 | 取值 | 默认 | 说明 |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `high` \| `max` | `max` | `(thinking)` 变体的推理深度，其他变体忽略。`high` 更快、推理链更短。下一条消息即生效。 |
| `deepseekv4.logRawReasoning` | `boolean` | `false` | 把原始 `reasoning_content` 流式写入日志（只在排查缓存击穿时有用）。可能捕获私有代码 —— 分享日志时请保持**关闭**。 |

## 计费与 Copilot 高级请求配额

每个请求都只发往 `api.deepseek.com`，用**你的**密钥认证，从你预付的 DeepSeek 余额扣费（按量计费，见 [DeepSeek 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)），绝不动你的 Copilot 配额。

唯一的例外来自 Copilot Chat 自身：**Agent 模式**下它可能启动**子代理**（`agent` / `runSubagent` 工具，典型如 Explore Agent），跑在 Copilot 托管模型上（无视你选的模型），这部分**会**消耗高级请求。这影响所有自带密钥（BYOK）的提供方（[community#197840](https://github.com/orgs/community/discussions/197840)、[#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16)）。规避方式：

1. Agent 模式下打开工具选择器（聊天输入框里的 **Configure Tools** 图标），**取消勾选 `agent` / `runSubagent`** —— 最可靠。
2. 或把 `github.copilot.chat.exploreAgent.model` 设为某个 DeepSeek V4 模型。
3. 或不需要工具的轮次改用 Ask 模式。

## 常见问题

**报错 `The reasoning_content in the thinking mode must be passed back to the API`（400）。**
2026-08-22 的一次实测之后没再见过（API 接受了所有不带推理的历史形态），但文档仍保留该规则。若出现，说明某个 assistant 轮在缓存里没有推理内容（安装扩展前的历史、缓存被清空、或超长会话中被淘汰）：新开会话即可；*Show DeepSeek V4 Reasoning Cache Stats* 可诊断。

**弹出警告 "prompt cache hit rate dropped"。**
你这个会话在 DeepSeek 服务端的缓存前缀断了，后续轮次按全价（缓存未命中）输入价计费，而不是更便宜的缓存命中价。扩展无法判断具体原因 —— 某轮中途取消或失败、超长会话中被淘汰、编辑器重启都有可能。点 *Start New Chat* 新开会话即可止损；*Show Cache Stats* 可诊断。背景：[#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19)。

**Copilot 上下文指示器显示 0 / 0%。**
升级到 VS Code **1.120+** —— 更早的宿主不会为扩展提供的模型显示用量（[#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18)、[microsoft/vscode#315394](https://github.com/microsoft/vscode/issues/315394)）。

**我附加的图片被忽略了。**
只有 Flash Vision 变体会发送图片。检查格式和上文的 48 MiB / 32 MiB 限制。

**为什么不支持 OpenRouter / 自定义 base URL？**
有意为之（[#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4)）：OpenRouter 会改写 DeepSeek 的 thinking 协议（`reasoning_details` 而非 `reasoning_content`、不同的 thinking 开关、没有缓存命中计数）—— 恰好是本扩展依赖的东西。要走 OpenRouter，请改用专门的 provider，例如 [ostash/openrouter-chat-provider](https://github.com/ostash/openrouter-chat-provider)。

## 隐私

- **零遥测。** 唯一的网络对端是 `api.deepseek.com`；图片也只发往那里。
- API 密钥存放在 VS Code **SecretStorage**（系统钥匙串），不会写入设置文件。
- 推理缓存存在磁盘上（VS Code 重启后仍在），可能包含你的代码与提示词片段；*Clear DeepSeek V4 Reasoning Cache* 可清空，`deepseekv4.logRawReasoning` 默认关闭。

## 许可

MIT，见 [LICENSE](./LICENSE)。Fork 自 [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat)，协议层为 DeepSeek V4 重写。
