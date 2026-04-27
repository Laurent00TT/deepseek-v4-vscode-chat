# DeepSeek V4 for Copilot Chat

Native DeepSeek V4 (Pro / Flash) provider for VS Code Copilot Chat — with full extended-thinking support, agent-mode tool calling, and built-in cost tracking.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## Features

- Four model variants in the Copilot model picker: **Pro (thinking)**, **Pro**, **Flash (thinking)**, **Flash**
- Extended thinking at max effort, with the full reasoning chain preserved across multi-turn agent loops
- Agent-mode tool calling that does not break on the second turn
- Status bar with live account balance and session spend (auto-detects CNY / USD)
- Background balance refresh after each chat (debounced, silent)
- Persistent reasoning cache (survives VS Code restarts)
- Actionable error notifications for 401 / 402 / 422 / 429
- Retry on transient failures (5xx, 429, network jitter)

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

## License

MIT. See [LICENSE](./LICENSE). Forked from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat); the protocol layer was rewritten for DeepSeek V4.
