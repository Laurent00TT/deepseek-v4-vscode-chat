# Architecture

Internals of the extension. For contributors — end users do not need to read this.

## Data flow

```text
Copilot Chat (UI)
    │  user types a message
    ▼
VS Code LM API
    │  invokes the registered LanguageModelChatProvider
    ▼
DeepSeekV4ChatModelProvider.provideLanguageModelChatResponse(model, messages, options, progress, token)
    │  → creates a fresh StreamContext (per-call state, see below)
    │
    ├─ convertMessages(messages)         ← VS Code parts → OpenAI message[]
    ├─ attachReasoningToHistory(out)     ← inject cached reasoning_content into prior assistant turns
    ├─ convertTools(options)             ← VS Code tools → OpenAI function tool defs
    │
    ├─ POST /v1/chat/completions  (stream + thinking + tools)
    │
    └─ processStreamingResponse(ctx, …)
         │  parse SSE chunks
         ├─ delta.reasoning_content      → ctx.reasoning += chunk, emit ThinkingPart if available
         ├─ delta.content                → emit LanguageModelTextPart
         ├─ delta.tool_calls             → ctx.toolCallBuffers, emit LanguageModelToolCallPart once JSON args are valid
         └─ finish_reason / [DONE]       → see "Finish reasons" below for the dispatch table
```

## Per-call state: StreamContext

Every invocation of `provideLanguageModelChatResponse` constructs a fresh
`StreamContext` carrying:

- `toolCallBuffers` — map keyed by `tool_calls.index`, accumulating partial
  function name + JSON arguments deltas
- `completedToolCallIndices` — set of indices already emitted, used to
  ignore late deltas after a complete tool call has flushed
- `reasoning` — accumulated `reasoning_content` for this turn, fingerprinted
  and persisted at finish time
- `emittedText` / `emittedToolCalls` — what we sent to the host this turn,
  used to compute the cache fingerprint
- `hasShownThinkingHint` — once-per-turn flag for the `💭 Thinking...`
  text fallback when the proposed `LanguageModelThinkingPart` API isn't
  available

Earlier versions of this code carried these as instance fields on the
provider, which assumed VS Code calls `provideLanguageModelChatResponse`
strictly serially. With multi-window / multi-chat-panel scenarios that
assumption is fragile; encapsulating in `StreamContext` lets concurrent
turns coexist without trampling each other's tool-call buffers.

## Finish reasons

DeepSeek can return five `finish_reason` values, including special ones
inside an HTTP-200 response:

| Reason | Meaning | What we do |
|---|---|---|
| `stop` / `tool_calls` | Clean completion | Flush tool-call buffers, **throw** on partial JSON args (something is genuinely wrong) |
| `length` | Hit `max_tokens` | Log only; flush best-effort, don't throw |
| `content_filter` | DS safety filter | Log only; flush best-effort, don't throw |
| `insufficient_system_resource` | Backend mid-stream truncation (DS-specific) | Log, surface an `ErrorMessage` with a "Show Log" button, flush best-effort, don't throw |

The non-clean cases never throw because partial tool-call JSON is *expected*
on truncation; throwing would discard the reasoning_content already streamed
to the UI. The user's chat input box will still let them resend; we don't
bind a "Retry" button to any chat-host command (no stable, panel-agnostic
retry command exists in the public VS Code API).

## Design decision: stable API only, no proposed API

VS Code exposes a `LanguageModelThinkingPart` *proposed* API for streaming and round-tripping chain-of-thought as a first-class chat part. We deliberately do **not** opt into it. The extension uses reflection (`(vscode as Record)["LanguageModelThinkingPart"]`) to *opportunistically* emit a `ThinkingPart` if the constructor happens to be present at runtime, and falls back to a one-shot `💭 Thinking...` `LanguageModelTextPart` otherwise.

### Why we stay on stable API

1. **Distribution.** VS Code Marketplace will not publish an extension that declares `enabledApiProposals`. Even side-loaded, the user must launch VS Code with `--enable-proposed-api Laurent00TT.deepseek-v4-vscode-chat` for the proposal to actually engage. Realistic only on Insiders. Our target audience is stable VS Code + GitHub Copilot Chat — opting in would close the main install path.
2. **Stability.** Proposed APIs change shape between VS Code releases. We would be on the hook to follow [microsoft/vscode#246993](https://github.com/microsoft/vscode/issues/246993) and ship breaking updates each minor.
3. **No functional gap.** The local reasoning cache (next section) already round-trips `reasoning_content` reliably. The proposed API would replace the cache with a host-managed equivalent, but the cache is already shipped, persisted, fingerprint-deduped, and integration-tested. Switching would be churn for parity.

### What we lose by not opting in

- The thinking stream renders as plain text plus a leading `💭 Thinking...` line, not the native collapsible thinking UI Copilot uses for first-party providers.
- Reasoning is not round-tripped through the host's chat history — we maintain it ourselves in `_reasoningCache`.

Both are accepted trade-offs.

### When to revisit this decision

Re-evaluate (and possibly switch) **only if** one of the following holds:

- **`LanguageModelThinkingPart` graduates to stable API.** Our reflection path then auto-engages with zero code changes; we'd additionally consider deleting `_reasoningCache` if the host starts persisting thinking parts in chat history.
- **A reasoning round-trip scenario emerges that the cache cannot cover.** Today the dual-mode fingerprint (`tc:` / `tx:` prefix) plus `globalState` persistence plus `reasoning_content=""` fallback covers every case we've encountered. If a future failure mode resists all three layers, the proposed API's host-side round-trip becomes worth its distribution cost.
- **Distribution model changes.** If the project ever pivots to Insiders-only or developer-preview audience, the cost calculus inverts.

Until one of these triggers, the answer stays "no proposed API."

## The core challenge: cross-turn reasoning_content round-trip

### Problem

DeepSeek V4 thinking-mode multi-turn rule (verified empirically and consistent with the official Tool Calls sample code):

> **When `tools` is non-empty in the request, every prior assistant turn in the `messages` array must carry its original `reasoning_content`, regardless of whether that turn itself produced any `tool_calls`.**

VS Code's chat history is modeled after the OpenAI Chat Completions schema. **There is no field for `reasoning_content`.** By the time Copilot Chat hands `messages` back to us on the next request, every assistant turn has only `content` and `tool_calls` left — the reasoning has already been dropped.

Forwarding messages as-is to DeepSeek triggers HTTP 400:

```text
The reasoning_content in the thinking mode must be passed back to the API.
```

### Solution: local reasoning cache + fingerprint index

#### Write side (when a streamed response completes)

When SSE delivers `finish_reason` or `[DONE]`, the full `reasoning_content`
of the current turn has already accumulated into `ctx.reasoning` (see
"Per-call state: StreamContext" above). A `captureProgress` wrapper around
the host `progress` callback also accumulates:

- `ctx.emittedText`: every text part we emitted to the UI this turn (used
  as the fallback fingerprint when no tool calls)
- `ctx.emittedToolCalls`: every `{id, name}` we emitted (the primary
  fingerprint anchor when present)

`persistReasoningForTurn(ctx)` then computes a fingerprint, writes the
entry to the LRU `_reasoningCache`, and persists to `globalState`
(debounced 200 ms).

#### Read side (start of every new request)

`attachReasoningToHistory(openaiMessages)` walks the converted message list. For every `role: "assistant"` entry it:

1. computes the same fingerprint from `msg.content` and `msg.tool_calls`;
2. looks up `_reasoningCache.get(fp)` — on hit, sets `msg.reasoning_content`;
3. on miss, sets `msg.reasoning_content = ""` as fallback. The model loses
   that turn's reasoning context but the conversation survives instead of
   deadlocking on a guaranteed 400. Cache misses are logged for diagnostics.

## Fingerprint algorithm: why hybrid

We went through three iterations. The first two had real failure modes in production.

### v1 (failed): mixed text + tool_calls hash

```typescript
fp = sha256(text[0:256] + tool_calls.map(tc => `${tc.name}:${tc.id}`).sort().join())
```

**Failure**: Copilot's Autopilot, between LLM invocations, reshapes assistant message text in subtle ways — whitespace normalization, emoji byte differences, hint text being merged or stripped — and the text we accumulated at write time no longer matched the text we read back at read time. Cache miss, 400 returned.

### v2 (partial failure): tool_calls only

```typescript
fp = sha256(sorted(tool_calls.map(tc => `${tc.name}:${tc.id}`)).join("|"))
// returns "" when there are no tool_calls
```

This fixed v1's instability — DeepSeek-issued `tool_call.id`s are stable strings that VS Code preserves verbatim across history reads.

**New failure**: DeepSeek's actual rule is stricter than the docs read at first glance. With `tools` present, **every** prior assistant turn needs `reasoning_content`, including the ones with no tool calls. v2 returned an empty fingerprint for tool-less assistants and never looked them up, so their reasoning was never restored. 400 again.

### v3 (current): hybrid two-mode with prefix

```typescript
function fingerprintAssistantTurn(input: { text: string; toolCalls: ... }): string {
  if (input.toolCalls.length > 0) {
    return "tc:" + sha256(sorted(toolCalls.map(tc => `${tc.name}:${tc.id}`)).join("|")).slice(0, 16);
  }
  const norm = input.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!norm) return "";
  return "tx:" + sha256(norm).slice(0, 16);
}
```

Key points:

- **Has tool_calls** → `tc:` prefix, anchored on DeepSeek's immutable id strings.
- **No tool_calls** → `tx:` prefix, hash of NFKC-normalized visible text. VS Code stores the `LanguageModelTextPart`s we emit verbatim, so the text round-trips reliably.
- The prefix prevents collisions between the two modes.
- NFKC normalization absorbs emoji / CJK encoding variants.

Real-world result: an 18-turn agent session against the live API hit 100 % cache hits and zero 400s.

## Cache lifecycle

### LRU + dual capacity limits

```text
ReasoningCache(maxSize = 512)
  ├─ buffer: CachedTurn[]            ← array-based LRU; push to tail, shift from head
  ├─ MAX_TOTAL_BYTES = 20 MB         ← hard ceiling; oldest entries evicted on overflow
  ├─ ENTRY_SIZE_WARN_BYTES = 192 KB  ← per-entry warning threshold; logs only, never truncates
  └─ _totalBytes                     ← maintained incrementally for O(1) stats
```

Eviction policy: `while (length > maxSize || totalBytes > MAX_TOTAL_BYTES) shift()`. We always evict from the head (oldest); recent entries stay at the tail. This matches plain count-based LRU semantics and keeps active conversation entries safe.

### Persistence: globalState + debounce

```text
cache.set / cache.get LRU bump
        │
        ▼
_reasoningCache.onChange()
        │
        ▼
debounce 200 ms
        │
        ▼
context.globalState.update(KEY, cache.serialize())
```

On startup, `restore(globalState.get(KEY))` rehydrates the cache. A conversation can survive a VS Code restart and continue without 400.

A 20 MB cap with a 16-char text hash leaves the serialized payload well below VS Code's effective `globalState` ceiling (~100 MB).

## Protocol-layer details

### Thinking-mode parameters

```typescript
{
  thinking: { type: "enabled" | "disabled" },
  reasoning_effort: "high" | "max",  // only applies when thinking is enabled
}
```

The `reasoning_effort` value is read at request time from the `deepseekv4.reasoningEffort` user setting (default `max`). It is sent only when the variant has `thinking: true`. Per-request `[req] reasoning_effort=...` is logged to the output channel for observability.

In thinking mode DeepSeek ignores `temperature`, `top_p`, `presence_penalty`, and `frequency_penalty`. We omit them from the request body to keep it clean (better prompt-cache hit rate).

### Usage capture

`stream_options: { include_usage: true }` makes DeepSeek emit a final chunk with:

- `prompt_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- `completion_tokens` / `completion_tokens_details.reasoning_tokens`

A two-currency pricing table (USD + CNY) handles cost estimation; the active currency follows the account balance.

### Errors and retry

`fetchWithRetry` wraps every API call:

- **Retryable**: 5xx, 429, network errors, timeouts
- **Non-retryable**: 401, 402, 422, 400, and other 4xx — surface them immediately with actionable notifications
- Exponential backoff 1 s → 2 s, max 3 attempts
- Per-attempt timeout of 5 minutes (max-effort thinking can legitimately take 2–3 minutes)

`notifyApiError` then maps each non-retryable status to a specific user
prompt:

| Status | Action button(s) | Routes to |
|---|---|---|
| 401 | "Update API Key" | `deepseekv4.manage` |
| 402 | "Open DeepSeek Billing" | `https://platform.deepseek.com/usage` |
| 422 | "Reload Window" | `workbench.action.reloadWindow` |
| 429 | (warning, no button — retry already happened) | — |
| 400 (with "reasoning"/"thinking" in body) | "Start New Chat" / "Show Log" | `workbench.action.chat.newChat` / `deepseekv4.showLog` |

The 400+reasoning path exists because a stale or partial reasoning cache
can produce DeepSeek's `The reasoning_content in the thinking mode must be
passed back to the API` error, and "start a new chat" is the simplest
recovery: a fresh chat session means no prior assistant turns to round-trip
reasoning for.

## Status bar

The status bar uses `vscode.MarkdownString` with embedded `command:` links —
clicks fire the `refresh`, `showLog`, and `clearSession` commands.

### The hover-refresh limitation

`StatusBarItem.tooltip` is declarative: assigning a new `MarkdownString`
while the hover popup is already on screen does **not** re-render the
visible popup. The user sees stale data until they mouse out and back in.

We tried two work-arounds on the manual-refresh path:

1. **Just swap the tooltip ref** — popup stays stale. (0.2.x behaviour.)
2. **Dispose + recreate the StatusBarItem** — popup closes (good), but
   VS Code 1.106+ does not auto-re-fire hover on the new item. The user
   sees a flicker followed by the popup vanishing entirely. Strictly
   worse than option 1.

Settled approach (0.3.0+): swap the tooltip reference (so the next hover is
fresh) **and** flash a 4-second `setStatusBarMessage` ack like
`✓ DeepSeek balance: ¥11.81` next to the status bar. The ack is the
immediate feedback the user gets without re-hovering. Tracked with a
TODO in `flashRefreshAck()`; if VS Code ever exposes an imperative
hover-refresh API, switch to that.

The silent background-refresh path (debounced after each chat completion)
does not flash an ack — it just swaps the tooltip ref so the next hover is
current.

## Background balance refresh

On every chat completion we call `scheduleBalanceRefresh()`, which arms a 1.5-second debounce timer that fires `refreshBalance(silent=true)`. Silent mode:

- on success, only logs `balance.auto_refresh`; no popup
- on failure, only logs `balance.auto_refresh.error`; no popup
- precondition: `_balance` already exists (the user has fetched it manually at least once); otherwise no-op

Pending timers are cleared in `dispose()` to avoid late callbacks against torn-down resources.

## Integration tests

Files in `test/integration_*.mjs` hit the live DeepSeek API directly, **bypassing VS Code**, and serve as protocol-layer sanity checks:

- `integration_round_trip.mjs` — basic thinking + tool_call round-trip
- `integration_no_tc_assistant.mjs` — reasoning round-trip rules without `tools`
- `integration_tools_present.mjs` — **the strict rule with `tools` present** (the corner case this extension is built around)

Run locally:

```bash
DEEPSEEK_API_KEY=sk-... node test/integration_tools_present.mjs
```

CI does not run these (they require a real API key and incur cost). Use them when investigating protocol-level questions.
