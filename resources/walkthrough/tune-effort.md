# Tune reasoning effort

Thinking variants accept two effort levels via the
`deepseekv4.reasoningEffort` setting:

| Value | Behavior |
|---|---|
| **`max`** (default) | Deepest reasoning chain. Best for agent tasks, refactors, complex bug hunts. Uses the most reasoning tokens. |
| **`high`** | Shorter reasoning chain, faster responses, lower cost. Good for everyday chat and simple Q&A. |

The setting is read at request time, so changes take effect on the **next
message** — no reload required.

## When to switch

- Stay on `max` if you mostly use Copilot Chat in agent mode with tools.
- Switch to `high` if you find yourself in long Q&A conversations where
  the reasoning chains feel longer than necessary.

You can flip between modes any time without changing the model.

## Where it shows up

- Hover the **DS V4** status-bar item — it displays the current effort
  next to a "configure" link.
- Each request also logs `[req] reasoning_effort=...` to the
  **DeepSeek V4** output channel (run `Show DeepSeek V4 Log`).

## What it does NOT affect

- Non-thinking variants (`DeepSeek V4 Pro`, `DeepSeek V4 Flash`) — the
  setting is ignored when thinking is disabled.
- Reasoning content already cached from prior turns — those round-trip
  unchanged. Only the new request uses the new effort.
