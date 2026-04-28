# Pick a DeepSeek V4 model

After setting your API key, open Copilot Chat and use the model picker at
the bottom of the chat input. You will see four DeepSeek V4 variants:

| Variant | Best for |
|---|---|
| **DeepSeek V4 Pro (thinking)** | Complex agent tasks, deep reasoning at max effort |
| **DeepSeek V4 Pro** | Strong coding without the thinking-mode latency |
| **DeepSeek V4 Flash (thinking)** | Cheapest path to extended thinking |
| **DeepSeek V4 Flash** | Fast everyday edits, lowest cost |

If you don't see them in the picker, open VS Code's Language Models manager
and make sure DeepSeek V4 is enabled.

## Status bar

The DeepSeek V4 status-bar item shows your account balance and the running
session cost after the first request. Click it to view the full log channel
or refresh the balance.

## Cost transparency

Every chat completion logs the prompt-cache hit rate, completion tokens,
reasoning tokens, and the per-request cost to the **DeepSeek V4** output
channel. Run **Show DeepSeek V4 Log** to inspect.
