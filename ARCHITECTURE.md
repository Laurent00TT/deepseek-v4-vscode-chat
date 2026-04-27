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
    │
    ├─ convertMessages(messages)         ← VS Code parts → OpenAI message[]
    ├─ attachReasoningToHistory(out)     ← inject cached reasoning_content into prior assistant turns
    ├─ convertTools(options)             ← VS Code tools → OpenAI function tool defs
    │
    ├─ POST /v1/chat/completions  (stream + thinking + tools)
    │
    └─ processStreamingResponse
         │  parse SSE chunks
         ├─ delta.reasoning_content      → accumulate to _currentTurnReasoning, emit ThinkingPart if available
         ├─ delta.content                → emit LanguageModelTextPart
         ├─ delta.tool_calls             → buffer, emit LanguageModelToolCallPart once JSON args are valid
         └─ finish_reason / [DONE]       → flush + persist reasoning to the cache
```

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

When SSE delivers `finish_reason` or `[DONE]`, the full `reasoning_content` of the current turn has already accumulated into `_currentTurnReasoning`. A `captureProgress` wrapper around the host `progress` callback also accumulates:

- `_currentTurnEmittedText`: every text part we emitted to the UI this turn (used as the fallback fingerprint when no tool calls)
- `_currentTurnEmittedToolCalls`: every `{id, name}` we emitted (the primary fingerprint anchor when present)

`persistReasoningForTurn()` then computes a fingerprint, writes the entry to the LRU `_reasoningCache`, and persists to `globalState` (debounced 200 ms).

#### Read side (start of every new request)

`attachReasoningToHistory(openaiMessages)` walks the converted message list. For every `role: "assistant"` entry it:

1. computes the same fingerprint from `msg.content` and `msg.tool_calls`;
2. looks up `_reasoningCache.get(fp)` — on hit, sets `msg.reasoning_content`;
3. on miss, logs but does not throw — we let DeepSeek be the authority on whether the request is valid.

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

In thinking mode DeepSeek ignores `temperature`, `top_p`, `presence_penalty`, and `frequency_penalty`. We omit them from the request body to keep it clean (better prompt-cache hit rate).

### Usage capture

`stream_options: { include_usage: true }` makes DeepSeek emit a final chunk with:

- `prompt_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- `completion_tokens` / `completion_tokens_details.reasoning_tokens`

A two-currency pricing table (USD + CNY) handles cost estimation; the active currency follows the account balance.

### Errors and retry

`fetchWithRetry` wraps every API call:

- **Retryable**: 5xx, 429, network errors, timeouts
- **Non-retryable**: 401, 402, 422 and other 4xx — surface them immediately with actionable notifications
- Exponential backoff 1 s → 2 s, max 3 attempts
- Per-attempt timeout of 5 minutes (max-effort thinking can legitimately take 2–3 minutes)

## Status bar

The status bar uses `vscode.MarkdownString` with embedded `command:` links — clicks fire the `refresh`, `showLog`, and `clearSession` commands. VS Code does not let a tooltip refresh while it is being shown, so after a manual refresh we flash a 4-second status-bar message as immediate feedback.

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
