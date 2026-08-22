# DeepSeek V4 for Copilot Chat

Use DeepSeek V4 (Pro / Flash / Flash Vision) as a native model in VS Code Copilot Chat — extended thinking, agent-mode tool calling, image input, and your real DeepSeek bill in the status bar.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Architecture (contributor docs)](./ARCHITECTURE.md)

## Quick start

You need VS Code 1.106+, the **GitHub Copilot Chat** extension signed in (this extension only adds models to its picker), and a DeepSeek account with API balance.

1. Install **DeepSeek V4 for Copilot Chat** from the VS Code Marketplace.
2. Command Palette → `Manage DeepSeek V4 Provider` → paste your [DeepSeek API key](https://platform.deepseek.com/api_keys).
3. In Copilot Chat, open the model picker and choose a DeepSeek V4 variant. If none are listed, use the picker's **Manage Models…** entry and enable DeepSeek V4.

## Models

| Picker entry | API model | Thinking | Images | Input budget | Output budget |
| ------ | ------ | :---: | :---: | ------ | ------ |
| DeepSeek V4 Pro (thinking) | `deepseek-v4-pro` | ✓ | — | 640K | 384K |
| DeepSeek V4 Pro | `deepseek-v4-pro` | — | — | 960K | 64K |
| DeepSeek V4 Flash (thinking) | `deepseek-v4-flash` | ✓ | — | 640K | 384K |
| DeepSeek V4 Flash | `deepseek-v4-flash` | — | — | 960K | 64K |
| DeepSeek V4 Flash Vision (thinking) | `deepseek-v4-flash-vision-exp` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash Vision | `deepseek-v4-flash-vision-exp` | — | ✓ | 960K | 64K |

**(thinking)** variants reason in a hidden chain of thought before answering — slower and more tokens, but stronger on hard and agentic tasks; the plain variants answer directly. All variants share DeepSeek V4's 1M-token context (input + output); thinking variants reserve 384K for output so long reasoning chains are never truncated.

## What you get

- Extended thinking with selectable depth (`high` / `max`), and the reasoning chain carried across multi-turn agent loops
- Agent-mode tool calling across long multi-turn loops — tool results and the model's own reasoning are carried from turn to turn
- Native image input on the Vision variants
- Live account balance in the status bar (CNY / USD auto-detected); the hover adds session spend and DeepSeek's peak / off-peak pricing windows in local time, with the current one marked
- Context-window usage in Copilot Chat's native indicator (needs VS Code 1.120+)
- Actionable error messages (400 / 401 / 402 / 422 / 429) and automatic retry on transient failures
- A first-run walkthrough; without a key the picker entries show a warning instead of disappearing

## Images (Vision variants)

Pick a **Flash Vision** variant and attach images in Copilot Chat; thinking and tool calling work exactly as on Flash.

- Formats: JPEG, PNG, GIF, WebP. Anything else — and any image sent to a text-only variant — is dropped, never paraphrased by another model.
- Limits: 48 MiB per request (base64 counts) and 32 MiB per image, both checked locally before sending.
- Cost: up to 384 tokens per image, billed at Flash prices.
- `-exp` is experimental on DeepSeek's side ([release note, 2026-08-21](https://api-docs.deepseek.com/news/news260821/)); expect rough edges.

## Why a native provider?

Two things a generic OpenAI-compatible bridge cannot do for DeepSeek V4:

- **Reasoning round-trip.** DeepSeek's thinking mode expects each prior assistant turn's `reasoning_content` back on the next request — a hard 400 without it until a 2026-08-22 live check found the server lenient (the docs still define the rule) — and VS Code's chat history has no field for it. This extension caches it locally and re-attaches it on every request, so the model keeps its own chain of thought across agent turns and every request stays byte-identical to what DeepSeek already cached, keeping the discounted cache-hit input price.
- **Real cost, not estimates.** Balance and session spend come from DeepSeek's `/user/balance`; cache-hit / miss tokens come from the real `usage` data.

## Commands

| Command | Description |
| ------ | ------ |
| `Manage DeepSeek V4 Provider` | Set or update your API key |
| `Refresh DeepSeek V4 Balance` | Fetch the latest account balance |
| `Show DeepSeek V4 Log` | Open the runtime log channel |
| `Show DeepSeek V4 Reasoning Cache Stats` | Reasoning-cache diagnostics |
| `Clear DeepSeek V4 Reasoning Cache` | Purge cached `reasoning_content` (e.g. before sharing a log) |
| `Clear DeepSeek V4 Session Counter` | Reset the session spend display |
| `Compact Copilot Chat` | Run Copilot Chat's `/compact` when context is near the cap |

## Settings

| Setting | Values | Default | Description |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `high` \| `max` | `max` | Reasoning depth for the `(thinking)` variants; ignored by the others. `high` is faster with shorter chains. Applies to the next message. |
| `deepseekv4.logRawReasoning` | `boolean` | `false` | Stream raw `reasoning_content` to the log (only useful when debugging cache breakdowns). May capture private code — keep **off** when sharing logs. |

## Billing & the Copilot premium-request quota

Every request goes to `api.deepseek.com` with **your** key and bills your prepaid DeepSeek balance (pay-as-you-go — see [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)), never your Copilot quota.

One exception comes from Copilot Chat itself: in **agent mode** it can spawn **sub-agents** (the `agent` / `runSubagent` tool — notably the Explore Agent) on a Copilot-hosted model regardless of the model you picked, and those calls *do* consume premium requests. This affects every bring-your-own-key (BYOK) provider ([community#197840](https://github.com/orgs/community/discussions/197840), [#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16)). To avoid it:

1. In agent mode, open the tools picker (the **Configure Tools** icon in the chat input) and **uncheck `agent` / `runSubagent`** — most reliable.
2. Or set `github.copilot.chat.exploreAgent.model` to a DeepSeek V4 model.
3. Or use Ask mode for turns that don't need tools.

## FAQ

**`The reasoning_content in the thinking mode must be passed back to the API` (400).**
Not seen since a 2026-08-22 live check (the API accepted every history shape without reasoning), but the docs still define the rule. If it appears, some assistant turn has no cached reasoning (pre-extension history, a cleared cache, or eviction in a very long session): start a new chat; *Show DeepSeek V4 Reasoning Cache Stats* diagnoses.

**"prompt cache hit rate dropped" warning.**
Your conversation's cached prefix on DeepSeek's side broke, so further turns bill at the full (cache-miss) input price instead of the discounted cache-hit price. The extension cannot tell why — a turn cancelled or failed mid-stream, eviction in a very long session, or an editor restart are all possible. *Start New Chat* cuts losses; *Show Cache Stats* diagnoses. Background: [#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19).

**Copilot's context indicator shows 0 / 0%.**
Update to VS Code **1.120+** — earlier hosts don't display usage for extension-provided models ([#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18), [microsoft/vscode#315394](https://github.com/microsoft/vscode/issues/315394)).

**My image attachment is ignored.**
Only the Flash Vision variants send images. Check the format and the 48 MiB / 32 MiB limits above.

**No OpenRouter / custom base URL?**
Deliberate ([#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4)): OpenRouter reshapes DeepSeek's thinking protocol (`reasoning_details` instead of `reasoning_content`, a different thinking switch, no cache-hit accounting) — exactly what this extension depends on. For OpenRouter use a dedicated provider such as [ostash/openrouter-chat-provider](https://github.com/ostash/openrouter-chat-provider).

## Privacy

- **No telemetry.** The only network peer is `api.deepseek.com`; images go only there.
- Your API key lives in VS Code **SecretStorage** (OS keychain), never in settings files.
- The reasoning cache is stored on disk (it survives VS Code restarts) and can hold fragments of your code and prompts; *Clear DeepSeek V4 Reasoning Cache* purges it, and `deepseekv4.logRawReasoning` is off by default.

## License

MIT. See [LICENSE](./LICENSE). Forked from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat); the protocol layer was rewritten for DeepSeek V4.
