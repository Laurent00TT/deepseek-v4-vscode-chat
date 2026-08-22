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
    ├─ convertMessages(messages, {imageInput})  ← VS Code parts → OpenAI message[] (image data parts → image_url blocks on Vision variants, see "Multimodal image input")
    ├─ attachReasoningToHistory(out)     ← inject cached reasoning_content into prior assistant turns
    ├─ convertTools(options)             ← VS Code tools → OpenAI function tool defs (host names → wire aliases, see "Tool-name wire aliasing")
    │
    ├─ POST /v1/chat/completions  (stream + thinking + tools)
    │
    └─ processStreamingResponse(ctx, …)
         │  split/classify SSE lines via the pure src/sse.ts (splitSseLines / parseSseData / extractDelta)
         ├─ delta.reasoning_content      → ctx.reasoning += chunk, emit ThinkingPart if available
         ├─ delta.content                → emit LanguageModelTextPart
         ├─ delta.tool_calls             → ctx.toolCalls (ToolCallAssembler, sse.ts), emit LanguageModelToolCallPart once JSON args are valid (echoed wire alias mapped back to the host name)
         └─ finish_reason / [DONE]       → see "Finish reasons" below for the dispatch table
```

The protocol decisions (line splitting, `data: ` prefix, `[DONE]`,
malformed-line classification, usage capture, tool-call assembly/dedup,
clean-finish classification) live in the vscode-free `src/sse.ts` and are
pinned by `test/unit_sse.mjs`; provider.ts keeps the reader loop, the
TextDecoder streaming state, the cancellation bridge, every
`progress.report` emission, and the `finally`-path reasoning persist.

## Per-call state: StreamContext

Every invocation of `provideLanguageModelChatResponse` constructs a fresh
`StreamContext` carrying:

- `toolCalls` — a `ToolCallAssembler` (sse.ts): buffers keyed by
  `tool_calls.index` accumulating partial name/arguments deltas, plus the
  completed-index set that ignores late deltas after a call has emitted
- `reasoning` — accumulated `reasoning_content` for this turn, fingerprinted
  and persisted at finish time
- `emittedText` / `emittedToolCalls` — what we sent to the host this turn,
  used to compute the cache fingerprint (`emittedToolCalls` stores **wire**
  names — see "Tool-name wire aliasing" below)
- `wireNameToHost` — per-request reverse map from advertised wire aliases
  back to VS Code host tool names
- `hasShownThinkingHint` — once-per-turn flag for the `💭 Thinking...`
  text fallback when the proposed `LanguageModelThinkingPart` API isn't
  available

Earlier versions of this code carried these as instance fields on the
provider, which assumed VS Code calls `provideLanguageModelChatResponse`
strictly serially. With multi-window / multi-chat-panel scenarios that
assumption is fragile; encapsulating in `StreamContext` lets concurrent
turns coexist without trampling each other's tool-call buffers.

## Tool-name wire aliasing (issue #20)

DeepSeek only accepts function names matching `^[A-Za-z0-9_-]{1,64}$`.
VS Code's MCP prefixing routinely violates the length cap — PyLance
v2026.3.1's `pylanceCheckSignatureCompatibility` arrives as the 72-char
`activate_fallback_mcp_pylance_mcp_s_pylanceCheckSignatureCompatibility_1`.
Two earlier strategies both failed:

- **Silent rewriting** (upstream fork): the model echoes the rewritten name,
  which matches nothing in VS Code's tool registry — the call routes nowhere.
- **Hard rejection** (0.3.6–0.3.8 `validateTools`): one bad name in
  `options.tools` crashed the whole request. Since Copilot advertises every
  registered tool on every request, one over-long MCP tool name made chat
  entirely unusable (issue #20).

Current design (`src/tool_names.ts`): `toWireName(hostName)` deterministically
aliases each name onto the spec —

- spec-legal names pass through **unchanged** (the common case; aliasing is
  invisible unless a name actually violates the spec);
- illegal characters become `_`, and **every alias that differs from the host
  name carries `_fnv1a32(original)`** — bare sanitization is lossy:
  `weather.get` would emerge as `weather_get` and collide with a legitimate
  sibling tool literally named `weather_get`, and equal-length CJK names
  would all collapse to the same underscore run, silently dropping real
  tools via the first-wins collision guard;
- names too long for `sanitized + "_" + hash` compress to `head(22) + "_" +
  tail(32) + "_" + hash` — exactly 64. The tail gets the larger share because
  MCP prefixes are templated noise while the discriminating semantics sit at
  the end; the hash keeps middle-differing siblings distinct.

The function is pure and idempotent, so both sides of every round-trip agree
without shared state:

- **outbound** — `convertTools` advertises wire names; `convertMessages`
  re-aliases host names in history `tool_calls`; `tool_choice` uses the
  advertised wire name;
- **inbound** — the stream layer maps the echoed wire name back to the host
  name via `ctx.wireNameToHost` (built per request by `buildWireNameMap`,
  first-wins on the astronomically-rare hash collision, with the colliding
  tool dropped from the advertised set) before `progress.report`, so VS Code
  dispatches on the names it registered. Unknown echoed names pass through
  unchanged — same failure mode as a hallucinated tool name before aliasing;
- **fingerprints** — `ctx.emittedToolCalls` records `toWireName(part.name)`,
  keeping the write-side fingerprint keyed identically to the read-side one
  computed over `convertMessages` output. Keying the two sides on different
  name spaces would make every aliased tool call a guaranteed cache miss —
  issue #19's failure mode all over again.

Unusable names (empty after sanitization) skip just that tool with a
`console.error`, never the whole request. Frozen-literal coverage in
`test/unit_tool_wire_name.mjs` pins the algorithm: changing the head/tail
split or hash breaks fingerprint continuity for conversations that span
extension versions, so it must be a deliberate, versioned decision.

Because tools can be skipped, DeepSeek's 128-tools-per-request cap is
enforced against the **advertised** set, not `options.tools` — a host list
slightly over 128 whose skips bring the broadcast set back under the cap is
a legal request. The payload assembly itself (schema sanitization, skip
logic, tool_choice) lives in the vscode-free `src/tool_payload.ts` — the
third extraction after `tool_names.ts` and `tool_choice.ts`, with
`convertTools` reduced to a thin enum→boolean adapter — so
`test/unit_tool_limit.mjs` executes the real skip-then-count path (130 host
tools, 5 unusable → 125 advertised → guard passes). The guard
(`src/tool_limit.ts`) takes the advertised `OpenAIFunctionToolDef[]` rather
than a count: VS Code's host tool shape is structurally incompatible, so
feeding `options.tools` — or any hand-computed number — fails to compile. A
deliberately minimal, best-effort text pin over comment-stripped
`out/provider.js` covers the two properties types can't enforce: the guard
call exists, and no inline host-list count check has crept back.

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

DeepSeek V4 thinking-mode multi-turn rule — as documented, and as the live server has actually behaved over time (standalone integration runs in `test/`):

> **Documented:** with `tools` in the request, every prior assistant turn's `reasoning_content` must be passed back, or the API returns 400 (Thinking Mode guide — still worded this way on 2026-08-22).
>
> **Observed:** the server has moved in steps. Originally every turn was enforced; around 2026-05 plain-text turns stopped needing it while tool-call turns still 400'd; on **2026-08-22** every shape we test was accepted without it — tool-call turns and plain turns, with and without `tools`, on `deepseek-v4-pro`, `deepseek-v4-flash` and the Vision model (`integration_round_trip` ×3, `integration_tools_present`, `integration_no_tc_assistant`, `integration_tools_advertised_no_tc`, `integration_cache_miss_fallback`, `integration_vision_multiturn`).

We still attach `reasoning_content` to **every** prior assistant turn we have cache for. Reasons: (a) sending more is harmless, (b) it preserves prompt-cache prefix bytes when the same conversation continues (the prefix must be byte-identical to hit DS server cache), and (c) it future-proofs against the server tightening the rule again.

When we have no cached reasoning for a tool-call turn, we used to fall back to `reasoning_content = ""` to avoid a guaranteed 400. The empty-string fallback is still in place because it's the conservative choice — but the integration tests in `test/integration_cache_miss_fallback.mjs` show the server now also accepts the turn being omitted entirely.

VS Code's chat history is modeled after the OpenAI Chat Completions schema. **There is no field for `reasoning_content`.** By the time Copilot Chat hands `messages` back to us on the next request, every assistant turn has only `content` and `tool_calls` left — the reasoning has already been dropped, so we re-attach from our local cache.

Forwarding a tool_call turn without restored `reasoning_content` historically triggered HTTP 400 with:

```text
The reasoning_content in the thinking mode must be passed back to the API.
```

As of 2026-08-22 the live server no longer returns it for any shape we test — but the docs still define the rule, so the round-trip mechanism stays, for three reasons: the model otherwise continues each agent turn from a history with its own chain of thought removed; the server prompt-cache prefix is byte-stable only if the same bytes are re-sent; and it keeps working unchanged if DeepSeek re-tightens. Treat the 400 as possible, not as current — the integration scripts report which way the server behaves on the day they run.

### Solution: local reasoning cache + fingerprint index

#### Write side (when a streamed response completes — or aborts)

When SSE delivers `finish_reason` or `[DONE]`, the full `reasoning_content`
of the current turn has already accumulated into `ctx.reasoning` (see
"Per-call state: StreamContext" above). A `captureProgress` wrapper around
the host `progress` callback also accumulates:

- `ctx.emittedText`: every text part we emitted to the UI this turn (used
  as the fallback fingerprint when no tool calls)
- `ctx.emittedToolCalls`: every `{id, name}` we emitted (the primary
  fingerprint anchor when present; `name` is the **wire alias**, matching
  what the read side computes over `convertMessages` output — see
  "Tool-name wire aliasing")

`persistReasoningForTurn(ctx)` then computes a fingerprint, writes the
entry to the LRU `_reasoningCache`, and persists to `globalState`
(debounced 200 ms).

Abnormal exits are covered too (issue #19): `processStreamingResponse`'s
`finally` makes an idempotent best-effort `persistReasoningForTurn` call, so
a turn cancelled mid-stream (Stop button) or aborted by a mid-stream error
still caches whatever reasoning was received, keyed over exactly the parts
already reported to the host. Without this, the host keeps the partial
assistant turn in history while the cache has no entry for it — a guaranteed
fingerprint miss (and a broken server prompt-cache prefix) on every later
request in that conversation. One deliberate exception: a turn whose only
emitted text is the `💭 Thinking...` fallback hint is treated as having no
anchor — that constant text would give every such cancelled turn the same
`tx:` key, and unrelated turns would overwrite each other's reasoning.

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

- **Has tool_calls** → `tc:` prefix, anchored on DeepSeek's immutable id strings. `tc.name` is the **wire alias** on both sides (write side records `toWireName(part.name)`; read side runs over `convertMessages` output, which is already aliased).
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

Session cost is derived from `/user/balance` diff (`sessionSpend = startBalance − currentBalance`), not from a hardcoded price table. This means the figure shown in the tooltip always matches the real bill — DeepSeek's prices change (cache-hit input was cut to 1/10 on 2026-04-26, Pro 75%-off has been extended multiple times) and any local table would drift. Trade-offs: session spend lags ~1.5s behind the debounced balance refresh; shared accounts see other users' spend mixed in; mid-session top-ups manifest as a one-shot re-anchor of `startBalance`.

Per-turn **context-window** usage is reported to GitHub Copilot Chat's native context indicator via a `usage` `LanguageModelDataPart` on the response `progress` stream (see `provideLanguageModelChatResponse`). The host owns the conversation, so its native indicator is inherently per-conversation and follows the focused chat — a `LanguageModelChatProvider` gets no conversation id and no focus signal, so a custom status-bar percentage (the 0.3.6 surface) could only ever show "the last turn that ran" and swapped between conversations (#17). Only real turns drive it: `src/request_kind.ts` classifies each request by system-prompt prefix and we skip the small auxiliary requests Copilot routes through the model (chat-title, progress messages, todo tracking, git messages, …) so they can't reset the indicator. The status-bar **tooltip** still surfaces the DeepSeek-specific cache-hit rate (`prompt_cache_hit_tokens`), which Copilot's UI doesn't show; the status bar itself shows balance + session spend only.

### Multimodal image input (Vision variants)

The two `deepseek-v4-flash-vision-exp` variants (added 2026-08; DeepSeek's
first multimodal model) declare `capabilities.imageInput`, so Copilot Chat
enables image attachments for them. The wire changes exactly one thing:
a **user** message that carries at least one image switches `content` from a
plain string to the OpenAI-style block array

```jsonc
[
  { "type": "text", "text": "..." },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]
```

Everything else (endpoint, thinking mode, `reasoning_effort`, tools) is
identical to Flash.

Invariants, in decreasing order of importance:

- **Text-only messages keep the plain-string shape byte-for-byte.**
  `buildUserContent` (in the vscode-free `src/image_content.ts`) collapses
  back to a string whenever no image survives, so every pre-vision
  conversation serializes exactly as before — the server prompt-cache
  prefix and the reasoning-cache fingerprints depend on this.
- Images ride only on **user** turns. Assistant/system turns and tool
  results never emit image blocks: the Vision guide says images in
  `system`/`assistant` messages return 400, and Chat Completions documents
  `tool` content as a plain string (only the Responses API, which we don't
  use, documents images in tool outputs). `integration_vision_multiturn.mjs`
  (2026-08-22) found Chat Completions **accepts** an `image_url` block
  inside a `tool` message as well, so flattening tool results to text is
  our choice, not an API limit — a candidate for tools that return
  screenshots.
- MIME gate: JPEG/PNG/GIF/WebP (declared MIME, normalized —
  `image/jpg` → `image/jpeg`, parameters stripped). Unsupported images are
  dropped with a `console.warn`, never sent — one bad attachment must not
  fail the whole request. On non-Vision variants every image is dropped
  (with a warn); there is deliberately no vision-proxy fallback.
- Token budgeting: images bill at up to **384 tokens each**
  (`IMAGE_TOKENS_PER_IMAGE`); counted into the pre-flight overflow check,
  the context-usage estimate, and `provideTokenCount`, and subtracted
  before the chars/token EMA calibration (images add prompt tokens without
  adding chars, which would otherwise drag the ratio).
- Transport cap: DeepSeek rejects request bodies over **48 MiB**
  (`MAX_REQUEST_BODY_BYTES`; base64 counts). The serialized body is
  checked once before fetch and an actionable error ("attach fewer/smaller
  images") replaces the opaque server 4xx. A single inline image is capped
  at **32 MiB** (`MAX_IMAGE_BYTES`, raw bytes): the largest user-turn
  attachment is checked before the body is built, same treatment.

#### Verified against the official docs (2026-08-22)

Every vision fact above was originally taken from search summaries; on
2026-08-22 they were re-checked against the official pages
(`api-docs.deepseek.com/guides/vision`, `/guides/files_api`,
`/quick_start/pricing`, `/quick_start/rate_limit`, `/news/news260821`,
EN and zh-cn trees). What the docs add beyond what the code already encodes:

- Model id `deepseek-v4-flash-vision-exp` is the only id; thinking is a
  request parameter on it (`thinking.type`, `reasoning_effort`), not a
  separate model. 1M context / 384K max output, same as Flash; billed at
  Flash prices incl. time-of-day windows; "exp" = experimental, no
  deprecation or GA timeline published.
- Formats are sniffed from the bytes, not the declared MIME — our MIME gate
  is a pre-filter. `image_url.detail` (`low`/`high`/`original`/`auto`,
  default original) exists; we never send it.
- Limits: 48 MiB request body; 32 MiB per inline image; 600 images per
  request; 8192 px per side (4096 px when a request carries ≥ 15 images);
  external URLs ≤ 8192 chars. Per-image token cost is resolution-based
  (small images upscaled to ~384×384, large ones downscaled to ~800×800
  pixels), capped at 384 — the ceiling we budget with.
- Files API exists and is free: `POST/GET/DELETE /files` (purpose
  `user_data`, 64 MiB per file, expiry 1 h–30 d or permanent), referenced
  from a user turn as `{ "type": "file", "file_id": "file-api-…" }`. Not
  used: `integration_vision_multiturn.mjs` (2026-08-22) showed the re-sent
  base64 image prefix **does** hit the server prompt cache (turn 2: 512 of
  the prior 499-token prompt cached; turn 3: 512 of 571), so `file_id`
  reuse would save upload bytes, not tokens — there is no cost case for it.
  (The cache page does not mention images either way.)
- The strict rule is still the *documented* one (with `tools`, every prior
  assistant turn's `reasoning_content` must be passed back or 400) — but
  the live server stopped enforcing it; see "The core challenge" above for
  the 2026-08-22 observation. attachReasoningToHistory stays for
  reasoning continuity and cache-prefix stability.
- Rate limiting is now a per-model **concurrency** cap (Pro 500 / Flash
  2500 / Vision 2500 in-flight requests per account → 429). While queued
  the server streams `: keep-alive` SSE comment lines (non-`data:` lines,
  ignored by `parseSseData`) and drops the connection if inference has not
  started after 10 minutes. `Retry-After` is **not** documented anywhere;
  the 429/503 guidance is "pace your requests" / "retry after a brief wait".

### Errors and retry

`fetchWithRetry` (in the vscode-free `src/api_client.ts`, together with the
endpoint constants and `formatApiError`; the model catalog similarly lives
in `src/model_catalog.ts`) wraps every API call:

- **Retryable**: 5xx, 429, network errors, timeouts
- **Non-retryable**: 401, 402, 422, 400, and other 4xx — surface them immediately with actionable notifications
- Exponential backoff 1 s → 2 s, max 3 attempts; a delay-seconds `Retry-After` on 429/5xx raises the wait when present, capped at 10 s (`MAX_RETRY_AFTER_MS`) — opportunistic, since DeepSeek does not document the header — and the sleep is abortable by Cancel
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

The status bar uses `vscode.MarkdownString` with embedded `command:` links.
The current allowlist (`isTrusted.enabledCommands`) is
`refreshBalance`, `compactCopilotChat`, `showLog`, and
`workbench.action.openSettings` (for the reasoning-effort link).
`clearSession` is no longer surfaced from the tooltip; session-spend
display rebases automatically on API-key change.

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
- `integration_tools_present.mjs` — **the strict rule with `tools` present** (the corner case this extension is built around; enforced as a 400 until mid-2026, accepted since 2026-08-22 — the script reports which way the server behaves today)
- `integration_tools_advertised_no_tc.mjs` — reasoning rules when tools are advertised but the turn makes no tool call
- `integration_cache_miss_fallback.mjs` — the `reasoning_content: ""` stub keeps a conversation alive after a cache miss
- `integration_vision.mjs` — multimodal content blocks against `deepseek-v4-flash-vision-exp`: generates a solid-red PNG locally and requires the model to *see* it, in both thinking and non-thinking modes
- `integration_vision_multiturn.mjs` — the agent-mode interactions `integration_vision.mjs` leaves open: a three-turn Vision + tools + thinking round-trip with the history shapes the extension actually sends (block-array user turn, assistant tool_call + `reasoning_content`, tool result). Hard checks: the model tool-calls with the image's color and every history shape is accepted. Recorded (informational): whether the re-sent image prefix hits the server prompt cache (`usage.prompt_cache_hit_tokens` vs the prior prompt size — the fact that decides whether Files API `file_id` reuse is worth anything), whether Vision enforces the strict `reasoning_content` rule, and whether a `tool`-role message may carry an image block

Run locally:

```bash
DEEPSEEK_API_KEY=sk-... node test/integration_tools_present.mjs
```

CI does not run these (they require a real API key and incur cost). Use them when investigating protocol-level questions.
