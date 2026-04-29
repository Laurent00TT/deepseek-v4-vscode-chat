# DeepSeek V4 for Copilot Chat

Native DeepSeek V4 (Pro / Flash) provider for VS Code Copilot Chat — with full extended-thinking support, agent-mode tool calling, and built-in cost tracking.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## Features

- Four model variants in the Copilot model picker: **Pro (thinking)**, **Pro**, **Flash (thinking)**, **Flash**
- Extended thinking with configurable effort (`high` / `max`, see [Settings](#settings)) and full reasoning chain preserved across multi-turn agent loops
- Agent-mode tool calling that does not break on the second turn
- Status bar with live account balance and session spend (auto-detects CNY / USD)
- Background balance refresh after each chat (debounced, silent)
- Persistent reasoning cache (survives VS Code restarts)
- Actionable error notifications for 400 (reasoning) / 401 / 402 / 422 / 429, plus mid-stream `insufficient_system_resource` truncation handling
- Retry on transient failures (5xx, 429, network jitter)
- Adaptive token estimator (EMA-calibrated chars/token from real `usage` data)
- First-run walkthrough and a "key required" warning state in the picker so the model entries are always discoverable

## Text-only, by design

DeepSeek V4 is in preview and only accepts text input. A common workaround
in other extensions is a "vision proxy": when you drop an image into chat,
it gets forwarded to a different multimodal model (GPT-4o, Claude, etc.)
and the resulting description is fed to DeepSeek as if it had seen the
picture.

We deliberately do not do this. The proxy introduces a silent fidelity
gap — DeepSeek answers based on another model's description of the image,
not the image itself. Any hallucination, omission, or bias in the
intermediate description leaks straight into DeepSeek's reply, and the UI
gives the user no signal that the model never actually saw what they
attached.

When DeepSeek itself ships native multimodal support, we will enable it
through this provider. Until then, image attachments are intentionally
unsupported here.

## What this plugin uniquely solves

Generic OAI-compatible bridges drop the `reasoning_content` field when forwarding to DeepSeek, which causes a hard 400 on the second turn of any tools-enabled thinking conversation:

```text
The reasoning_content in the thinking mode must be passed back to the API.
```

This extension is a native VS Code Language Model Provider — it intercepts each request, restores the prior `reasoning_content` from a local cache, and re-attaches it to every assistant turn in history (not just the ones that called a tool, which is what DeepSeek actually requires when `tools` is present). Result: agent loops, multi-turn refactors and long thinking sessions work end-to-end.

## Quick start

1. Install **DeepSeek V4 for Copilot Chat** from the VS Code Marketplace.
2. Run `Manage DeepSeek V4 Provider` from the command palette and paste your [DeepSeek API key](https://platform.deepseek.com/api_keys).
3. Open Copilot Chat, pick a DeepSeek V4 variant from the model picker, start chatting.

## Commands

| Command | Description |
| ------ | ------ |
| `Manage DeepSeek V4 Provider` | Set or update your API key |
| `Refresh DeepSeek V4 Balance` | Fetch the latest account balance |
| `Show DeepSeek V4 Log` | Open the runtime log channel |
| `Show DeepSeek V4 Reasoning Cache Stats` | Diagnostics for the reasoning cache |
| `Clear DeepSeek V4 Session Counter` | Reset the session spend display |

## Settings

| Setting | Values | Default | Description |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `high` \| `max` | `max` | Reasoning depth for `(thinking)` model variants. `high` is faster with shorter reasoning chains; `max` is the deepest setting. No effect on non-thinking variants. Picked up at request time. |

## License

MIT. See [LICENSE](./LICENSE). Forked from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat); the protocol layer was rewritten for DeepSeek V4.
