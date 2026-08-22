# DeepSeek V4 for Copilot Chat

Native DeepSeek V4 (Pro / Flash / Flash Vision) provider for VS Code Copilot Chat — with full extended-thinking support, agent-mode tool calling, native multimodal image input, and built-in cost tracking.

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Architecture (contributor docs)](./ARCHITECTURE.md)

## Features

- Six model variants in the Copilot model picker: **Pro (thinking)**, **Pro**, **Flash (thinking)**, **Flash**, **Flash Vision (thinking)**, **Flash Vision**
- Native image input on the Vision variants (`deepseek-v4-flash-vision-exp`) — attach screenshots/images in Copilot Chat and DeepSeek sees the actual pixels, no proxy model in between
- Extended thinking with configurable effort (`high` / `max`, see [Settings](#settings)) and full reasoning chain preserved across multi-turn agent loops
- Agent-mode tool calling that does not break on the second turn
- Status bar with live account balance and session spend (auto-detects CNY / USD)
- Peak/off-peak pricing panel in the status-bar hover — lists both of DeepSeek's V4 time-of-day pricing windows in local time and marks the one the clock is in right now
- Per-conversation context-window usage fed into Copilot Chat's **native** context indicator — it follows the focused chat (small auxiliary requests like chat-title generation are filtered out so they don't skew it)
- Background balance refresh after each chat (debounced, silent)
- Persistent reasoning cache (survives VS Code restarts)
- Actionable error notifications for 400 (reasoning) / 401 / 402 / 422 / 429, plus mid-stream `insufficient_system_resource` truncation handling
- Retry on transient failures (5xx, 429, network jitter)
- Adaptive token estimator (EMA-calibrated chars/token from real `usage` data)
- First-run walkthrough and a "key required" warning state in the picker so the model entries are always discoverable

## Models

| Picker entry | API model | Thinking | Images | Input budget | Output budget |
| ------ | ------ | :---: | :---: | ------ | ------ |
| DeepSeek V4 Pro (thinking) | `deepseek-v4-pro` | ✓ | — | 640K | 384K |
| DeepSeek V4 Pro | `deepseek-v4-pro` | — | — | 960K | 64K |
| DeepSeek V4 Flash (thinking) | `deepseek-v4-flash` | ✓ | — | 640K | 384K |
| DeepSeek V4 Flash | `deepseek-v4-flash` | — | — | 960K | 64K |
| DeepSeek V4 Flash Vision (thinking) | `deepseek-v4-flash-vision-exp` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash Vision | `deepseek-v4-flash-vision-exp` | — | ✓ | 960K | 64K |

All variants share DeepSeek V4's 1M total context window (input + output);
thinking variants reserve the full 384K output budget so max-effort
reasoning chains can't be silently truncated.

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
- The API caps request bodies at 48 MiB (base64 counts toward it) and a
  single image at 32 MiB; the extension pre-checks both and tells you to
  attach fewer/smaller images instead of surfacing an opaque server error.
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

## Billing & the Copilot premium-request quota

Everything this extension sends goes to `api.deepseek.com`, authenticated
with **your** DeepSeek key, and is billed only to your DeepSeek balance. It
never calls a GitHub/Copilot endpoint and has no code path that could touch
your Copilot quota.

That said, in **agent mode** the Copilot Chat host itself can spawn
background **sub-agents** (the `agent` / `runSubagent` tool — notably the
Explore Agent) that default to a Copilot-hosted model regardless of the
model you picked, and those calls *do* consume Copilot premium requests.
This is a platform behavior affecting every BYOK provider (tracked upstream
in [community#197840](https://github.com/orgs/community/discussions/197840);
see [#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16)).
To stop it:

1. In agent mode, open the tools picker ("Configure Tools") and **uncheck
   the `agent` / `runSubagent` tool** — most reliable.
2. Or point the Explore Agent at your model:
   `github.copilot.chat.exploreAgent.model` → a DeepSeek V4 model.
3. Or use Ask mode for turns that don't need tool-calling.

## FAQ / Troubleshooting

**The chat fails with `The reasoning_content in the thinking mode must be
passed back to the API` (400).**
DeepSeek's thinking mode requires prior assistant turns to carry their
reasoning chain back. This extension restores it from a local cache; the
error means the cache has no entry for some turn in this conversation
(pre-extension history, a cleared cache, or eviction in a very long
session). Recovery: start a new chat. Diagnostics: *Show DeepSeek V4
Reasoning Cache Stats*.

**A warning popped up: "prompt cache hit rate dropped".**
Your conversation's cached prompt prefix on DeepSeek's side broke — usually
after a cancelled/failed turn or an editor restart — so subsequent turns
bill at the much higher cache-miss input rate. The popup's *Start New Chat*
cuts losses; *Show Cache Stats* diagnoses. See
[#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19) for
the background.

**Copilot's context-window indicator shows 0 / 0%.**
Update VS Code to **1.120 or newer**. The extension has always reported
usage, but the host code that displays it for extension-provided models
only shipped in VS Code 1.120
([#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18),
[microsoft/vscode#315394](https://github.com/microsoft/vscode/issues/315394)).

**My image attachment seems to be ignored.**
Images are only sent on the **Flash Vision** variants — on text-only
variants they are dropped with a log warning (never proxied through another
model). Also check the format (JPEG/PNG/GIF/WebP) and total request size
(DeepSeek caps request bodies at 48 MiB — base64 counts toward it — and
single images at 32 MiB).

**Why is there no OpenRouter / custom base-URL support?**
Deliberate — see the discussion in
[#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4).
OpenRouter normalizes DeepSeek's thinking protocol to a different shape
(`reasoning_details` instead of `reasoning_content`, different
thinking-enable parameter, no cache-hit accounting), which breaks exactly
the things this extension exists to deliver. OpenRouter-based DeepSeek
access belongs in a separate provider (e.g.
[ostash/openrouter-chat-provider](https://github.com/ostash/openrouter-chat-provider),
built by the requester of #4).

## Privacy

- **No telemetry.** The extension phones home to nobody; the only network
  peer is `api.deepseek.com`.
- Your API key lives in VS Code **SecretStorage** (OS keychain), never in
  settings files.
- The persistent reasoning cache can contain fragments of your code and
  prompts; *Clear DeepSeek V4 Reasoning Cache* purges it (e.g. before
  sharing logs or switching projects), and `deepseekv4.logRawReasoning`
  stays **off** by default so reasoning never hits the log channel
  unasked.
- Image attachments are sent directly to DeepSeek as part of your request
  and are never routed through any third-party model.

## License

MIT. See [LICENSE](./LICENSE). Forked from [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat); the protocol layer was rewritten for DeepSeek V4.
