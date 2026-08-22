# DeepSeek V4 for Copilot Chat

Native DeepSeek V4 (Pro / Flash / Flash Vision) provider for VS Code Copilot Chat — with full extended-thinking support, agent-mode tool calling, native multimodal image input, and built-in cost tracking.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## Features

- Six model variants in the Copilot model picker: **Pro (thinking)**, **Pro**, **Flash (thinking)**, **Flash**, **Flash Vision (thinking)**, **Flash Vision**
- Native image input on the Vision variants (`deepseek-v4-flash-vision-exp`) — attach screenshots/images in Copilot Chat and DeepSeek sees the actual pixels, no proxy model in between
- Extended thinking with configurable effort (`high` / `max`, see [Settings](#settings)) and full reasoning chain preserved across multi-turn agent loops
- Agent-mode tool calling that does not break on the second turn
- Status bar with live account balance and session spend (auto-detects CNY / USD)
- Peak/off-peak billing hint in the status-bar hover — tells you which side of DeepSeek's V4 time-of-day pricing window the clock is on, and when it next flips (local time)
- Per-conversation context-window usage fed into Copilot Chat's **native** context indicator — it follows the focused chat (small auxiliary requests like chat-title generation are filtered out so they don't skew it)
- Background balance refresh after each chat (debounced, silent)
- Persistent reasoning cache (survives VS Code restarts)
- Actionable error notifications for 400 (reasoning) / 401 / 402 / 422 / 429, plus mid-stream `insufficient_system_resource` truncation handling
- Retry on transient failures (5xx, 429, network jitter)
- Adaptive token estimator (EMA-calibrated chars/token from real `usage` data)
- First-run walkthrough and a "key required" warning state in the picker so the model entries are always discoverable

## Native vision, no proxy

DeepSeek shipped its first multimodal model on 2026-08-21 —
[`deepseek-v4-flash-vision-exp`](https://api-docs.deepseek.com/news/news260821/),
an experimental Vision variant of V4 Flash — and this provider supports it
natively. Pick a **Flash Vision** variant in the model picker and attach
images in Copilot Chat: they are sent to DeepSeek as base64 `data:` URLs in
the API's multimodal content blocks, so the model sees the actual pixels.

What earlier versions of this README promised still holds: we never route
your images through a "vision proxy" (a different multimodal model that
describes the picture to DeepSeek). On the Vision variants DeepSeek sees
the image itself; on the text-only variants image attachments are dropped
with a warning in the log — never silently paraphrased by another model.

Vision notes:

- Supported formats: JPEG, PNG, GIF, WebP (DeepSeek sniffs the real format
  from the bytes; unsupported attachments are dropped with a log warning
  rather than failing the whole request).
- Each image is billed at up to 384 tokens, at the same price as Flash.
- The API caps request bodies at 48 MiB (base64 counts toward it); the
  extension pre-checks this and tells you to attach fewer/smaller images
  instead of surfacing an opaque server error.
- Extended thinking, agent-mode tool calling, and the reasoning-cache
  round-trip all work on the Vision variants exactly as on Flash.
- The model is experimental (`-exp`) on DeepSeek's side; expect the
  occasional rough edge until they promote it to stable.

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
| `Clear DeepSeek V4 Reasoning Cache` | Purge cached `reasoning_content` (e.g. before sharing a bug log, or after switching projects) |
| `Clear DeepSeek V4 Session Counter` | Reset the session spend display |
| `DeepSeek V4: Compact Copilot Chat` | Bridge to Copilot Chat's `/compact` flow when context is near the cap (no-op with a hint if Copilot Chat is not installed) |

## Settings

| Setting | Values | Default | Description |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `high` \| `max` | `max` | Reasoning depth for `(thinking)` model variants. `high` is faster with shorter reasoning chains; `max` is the deepest setting. No effect on non-thinking variants. Picked up at request time. |
| `deepseekv4.logRawReasoning` | `boolean` | `false` | Stream the raw `reasoning_content` to the OutputChannel. Useful for debugging prompt-cache breakdowns but may capture private code/paths/intermediate state — keep **off** when sharing logs in bug reports. |

## License

MIT. See [LICENSE](./LICENSE). Forked from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat); the protocol layer was rewritten for DeepSeek V4.
