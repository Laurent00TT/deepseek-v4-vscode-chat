# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [released]

## [Unreleased]

### Added

- **`DeepSeek V4: Show Context Window Details` command.** Opens a
  QuickPick listing the current `ContextUsageSnapshot`: model variant,
  used / window tokens with percentage, budget split (input vs output),
  API-reported prompt / cache-hit / cache-miss / completion / reasoning
  token counts, local pre-request estimate, and a "last update" age.
  A warning row appears at ≥ 70% usage. Selecting the final
  `Compact Copilot Chat` item invokes the bridge command below.
- **`DeepSeek V4: Compact Copilot Chat` command.** Detects whether
  `github.copilot.chat.compact` is registered (so a freshly-installed
  Copilot Chat works without an extension reload). If present, runs
  Copilot's compaction flow; if absent, surfaces a single information
  message. Does **not** touch DeepSeek-owned state (reasoning cache,
  balance baseline, etc.) — wording reflects this explicitly.
- **Tooltip "Context Details" link.** The status-bar tooltip now ends
  with a `$(graph) Context Details` link next to the existing
  `View full log` link, so users can jump from the quick glance into
  the full QuickPick.
- **`src/context_usage.ts` + `src/context_usage_service.ts`** — shared
  source of truth for the latest snapshot. Pure helpers (vscode-free)
  live in `context_usage.ts`; the stateful wrapper with
  `vscode.EventEmitter` lives in `context_usage_service.ts`, matching
  the pattern already used for `cache_breakdown.ts` and `tool_names.ts`.
- **`test/unit_context_usage.mjs`** — 26 assertions covering the four
  invariants from the design doc: estimate vs API authority, model-switch
  invalidation, clear-state recovery, and the breadcrumb case.

### Documentation

- `docs/CONTEXT_WINDOW_INTEGRATION.md` — design rationale for the new
  feature, including the verified reason VS Code's native
  `chat/contextUsage/actions` menu cannot be a contribution target
  (proposed API, Marketplace-incompatible).

## [0.3.7] - 2026-05-12

### Added

- **Context-usage indicator in status bar.** Live `X.X%` of the context window used, rendered in the standard description-foreground color (the percentage segment was deliberately kept inside the main DS V4 status item rather than split into a tier-coloured second item, after a brief experiment let other extensions like Python's "No Environment" slot in between and break visual cohesion). Tooltip shows a Current / Messages / Tools breakdown plus a Cap explanation (`1M − 384K reserved for thinking chain`).
- **`Clear DeepSeek V4 Reasoning Cache` command** for scrubbing private state from globalState before sharing logs or switching projects. Awaits a hard `globalState.update` flush before reporting success, so a reload immediately after clearing cannot restore stale reasoning.
- **`deepseekv4.showContextUsage` setting** to toggle the status-bar percentage indicator.
- **`deepseekv4.logRawReasoning` setting** (default `false`) gates streaming of raw `reasoning_content` to the OutputChannel. Previously the channel captured every reasoning byte unconditionally, which could leak private code, paths, or intermediate state into bug-report logs.
- **Cache-hit-rate display in tooltip** plus a breakdown warning when local reasoning-cache misses cause server-side prompt-cache prefix to collapse. Throttled to at most one warning per 5 minutes.
- **Actionable error dialog for HTTP 400 context-overflow.** Detects "maximum context length" / "reduce the length" wording from DeepSeek and surfaces Start New Chat / Show Log buttons instead of a cryptic 400.

### Changed

- **Session cost now derived from `/user/balance` diff** instead of a hardcoded price table. The displayed figure always matches the real bill regardless of DeepSeek's frequent price changes (e.g. the cache-hit input cut to 1/10 on 2026-04-26, and the Pro 75%-off discount extended to 2026-05-31). Currency follows the account directly.
- **Tool-name validation is strict.** Names that `sanitizeFunctionName` would rewrite — digit-leading (`1tool`), underscore-leading (`_private`), consecutive underscores (`foo__bar`), or longer than 64 chars — are now rejected with an actionable error showing the rewrite that would have happened. Previously such names were silently rewritten before send, and the model's echo didn't match VS Code's registry, so the tool call routed nowhere.
- **Reasoning-content attachment is thinking-mode only.** Switching from a thinking to a non-thinking variant strips stale `reasoning_content` from prior assistant turns instead of forwarding it.
- **Thinking variants now configure `maxOutputTokens = 384K`** to cover the full reasoning-chain budget at max effort (was 256K, which silently truncated long chains). Input budgets recomputed as `1M − maxOutputTokens` to honour DeepSeek's combined 1M ceiling.
- **`ARCHITECTURE.md` cross-turn rule relaxed** to reflect the 2026-05 server behaviour: DeepSeek now accepts requests that omit `reasoning_content` on non-tool-call assistant turns, even when `tools` is advertised.

### Fixed

- **Cancellation now interrupts streaming reads immediately.** The cancellation token is bridged into `reader.cancel()` inside `processStreamingResponse`; previously cancelling a long thinking-mode request would hang `await reader.read()` for tens of seconds waiting for the next SSE chunk.
- **API key change re-anchors session baseline.** A silent `refreshBalance(true)` fires after the secret listener resets state, so session-spend tracking keeps working after a key swap without requiring the user to manually click the refresh link.
- **`registerLanguageModelChatProvider` Disposable** is now pushed into `context.subscriptions` so it disposes cleanly on extension deactivate.

### Removed

- Hardcoded `PRICING` USD/CNY tables and `estimateCost` function (replaced by balance-diff session spend, see Changed).
- Dead `.vscode-test.mjs` config pointing at a non-existent `out/test/**/*.test.js`.
- Unconditional raw-reasoning streaming to OutputChannel (now gated by `deepseekv4.logRawReasoning`).

## [0.3.5] - 2026-05-08

### Fixed

- Tool-result text no longer carries VS Code 1.118+'s internal
  `cache_control` / `ephemeral` sentinel
  (`{"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}`),
  which the previous `JSON.stringify` fallback in `collectToolResultText`
  was injecting at the end of tool-call results — causing models to
  hallucinate trailing garbage and "fix" valid files (#11). Switched to
  a defensive whitelist (text parts and strings only), with a one-time
  `console.warn` for any future novel part type. Upstream:
  [microsoft/vscode#313920](https://github.com/microsoft/vscode/issues/313920).

## [0.3.4] - 2026-05-01

### Added

- Account balance is now rendered inline in the status bar text
  (e.g. `$(sparkle) DS V4  ¥13.33`) so users can monitor it without
  hovering over the indicator. Closes #5.
- A silent background balance fetch runs once on extension activation,
  so the balance appears automatically a couple seconds after a VS Code
  reload — no manual hover-refresh needed first. Failures are swallowed
  (no-op when the API key isn't yet configured).

### Changed

- The hover tooltip is unchanged. It remains the source of truth for the
  `fetchedAt` timestamp, the granted vs topped-up split, currency-mismatch
  warnings, and session spend / request count.

## [0.3.3] - 2026-05-01

### Fixed

- Thinking mode 400 error when `ReasoningCache` missed a prior turn's
  reasoning chain. The extension now sets `reasoning_content=""` as a
  fallback on cache MISS instead of omitting the field entirely, preventing
  a conversation-deadlocking 400 from the DeepSeek API (#7).

## [0.3.2] - 2026-04-29

### Added

- New setting `deepseekv4.reasoningEffort` (`"high"` | `"max"`, default `"max"`)
  to control reasoning depth on `(thinking)` model variants. Switch to `high`
  for faster, lighter responses on simple chat without changing models. Has
  no effect on non-thinking variants. Reads at request time, so changes apply
  to the next message without reloading.
- Status-bar tooltip now shows the current `reasoning_effort` value with a
  click-through link that opens the setting directly. Improves discoverability
  for the new option without intrusive notifications.
- Walkthrough adds a third step (**Tune reasoning effort (optional)**) that
  introduces the new setting to first-time users with a one-click link to the
  setting and a brief explanation of `high` vs `max`.
- Per-request `[req] reasoning_effort=<value> (variant=<id>)` log line in the
  output channel, so users and developers can confirm at a glance which
  effort each request is sending.

### Changed

- `MODEL_VARIANTS` no longer hardcodes `effort: "max"` on thinking variants;
  the value comes from the new user setting at request time. Variant tooltips
  drop the "at max effort" suffix to match.
- `DeepSeekModelVariant` type drops the `effort?: "high" | "max"` field. This
  is an internal type; no public API is affected.

## [0.3.1] - 2026-04-29

### Added

- New integration test `test/integration_tools_advertised_no_tc.mjs` covering the
  corner case where `tools` is advertised in the request but the conversation
  history contains no `assistant.tool_calls` turn. Confirms that DeepSeek does
  NOT require `reasoning_content` round-trip in this case, refining the previous
  understanding that "tools advertised → all turns must round-trip".

### Changed

- Fingerprint doc comment in `src/reasoning_cache.ts` now describes the actual
  trigger condition for `reasoning_content` round-trip (history contains an
  `assistant.tool_calls` turn) instead of the previous over-strong wording
  (tools advertised in the request). Behavior is unchanged: the existing
  "round-trip every assistant turn that has reasoning" strategy is a strict
  superset of the real rule, so the API never sees a missing `reasoning_content`.

## [0.3.0] - 2026-04-28

### Added

- Detect `finish_reason: "insufficient_system_resource"` mid-stream (DeepSeek's
  HTTP-200 backend-truncation signal): log it, surface an actionable
  ErrorMessage with a "Show Log" button (so the user can inspect the
  truncation), and flush partial tool-call buffers without throwing —
  preserving any reasoning/content already streamed to the UI. Also surface
  `length` and `content_filter` in the log channel for observability.
- Picker warning state when no API key is configured: model variants stay
  visible (with a `warning` icon and a tooltip pointing at the
  `Manage DeepSeek V4 Provider` command) instead of disappearing from the
  Copilot model picker entirely.
- `onDidChangeLanguageModelChatInformation` event wired through a new
  EventEmitter and a `SecretStorage.onDidChange` listener, so a key change in
  another VS Code window refreshes this window's picker without requiring a
  reload.
- Adaptive chars-per-token estimator: starts at 3.0 and converges via
  EMA (alpha=0.3) toward the observed `chars / prompt_tokens` ratio after
  each request. Replaces the hardcoded `/3` heuristic; values are clamped to
  `[1.0, 6.0]` to absorb outliers. Per-request input chars stay in a local
  variable rather than an instance field, so concurrent
  `provideLanguageModelChatResponse` calls can't pollute each other's EMA
  updates with the wrong request's size.
- First-run walkthrough that opens automatically when the extension activates
  without a configured key. Two steps: set the API key, pick a model.
- Status-bar tooltip now warns when the account currency is anything other
  than USD/CNY (cost estimation falls back to USD pricing in that case).

### Removed

- Legacy `<|tool_call_begin|>` / `<|tool_call_argument_begin|>` /
  `<|tool_call_end|>` text-tokenizer path. This was a V3.x compatibility
  shim for backends that streamed tool calls as raw text; V4 always uses the
  structured `delta.tool_calls` channel. ~170 lines deleted, including the
  `processTextContent`, `emitTextToolCallIfValid`, `flushActiveTextToolCall`,
  and `stripControlTokens` helpers and the `_textTool*` / `_emittedTextTool*`
  / `_hasEmittedAssistantText` / `_emittedBeginToolCallsHint` instance
  fields.

### Changed

- All per-turn streaming state (`toolCallBuffers`, `completedToolCallIndices`,
  `reasoning`, `emittedText`, `emittedToolCalls`, `hasShownThinkingHint`) is
  now encapsulated in a per-call `StreamContext` instead of living as
  instance fields on the provider. Concurrent `provideLanguageModelChatResponse`
  calls (multi-window, multi-chat-panel) can no longer corrupt each other's
  buffers.
- `usage` log line now includes the running `chars_per_token` estimate.
- `processStreamingResponse` no longer needs the post-stream cleanup block
  that reset shared instance state — `ctx` simply goes out of scope.
- Manual balance refresh now flashes a transient `$(check) DeepSeek balance: ¥xx.xx` message next to the status-bar item, so the user sees the new
  value immediately even when the click closes the hover popup. The next
  hover re-reads the (already-swapped) tooltip and shows fresh data. We
  experimented with a dispose+recreate trick to force the popup to close
  and re-trigger in-place, but VS Code 1.106+ does not auto-re-fire hover
  on the recreated item — the user got a flicker followed by the popup
  vanishing, strictly worse than the swap-only behaviour. The transient
  ack is the most we can do until VS Code adds an imperative
  hover-refresh API; tracked with a TODO in `flashRefreshAck()`.

## [0.2.2] - 2026-04-27

### Fixed

- Marketplace icon is now a full-bleed blue tile with no white border or rounded corners. Earlier 0.2.1 attempted this via a trim + inset-crop pipeline on the original artwork, but rounded corners still produced visible white triangles. Replaced the source artwork with a full-bleed version and reduced `prepare-icon.mjs` to a straight resize.

## [0.2.0] - 2026-04-26

### Added

- Reasoning cache total-byte tracking with safe LRU-aligned eviction (20 MB cap)
- Per-attempt HTTP timeout (5 min) with retry on timeout
- `Show DeepSeek V4 Reasoning Cache Stats` command for runtime diagnostics
- Unicode NFKC normalization in the text-mode fingerprint to handle emoji/CJK robustly
- Dedicated 400-error detection with actionable guidance when reasoning_content is missing
- Background auto-refresh of account balance after each chat (debounced, silent)

### Changed

- Reasoning cache size raised from 32 to 512 entries
- Per-entry size monitor: warns when an entry exceeds 192 KB
- Bilingual currency display: session/balance figures auto-switch CNY/USD based on the account
- Status bar simplified to `DS V4` + hover tooltip carrying balance, refresh, and log links

### Fixed

- Persisting reasoning cache to `globalState` survives VS Code restarts
- Hybrid fingerprint (`tc:` + `tx:`) reliably round-trips reasoning across all assistant turns,
  not just those that themselves contain tool calls

## [0.1.0] - 2026-04-25

### Added (initial release)

- DeepSeek V4 Pro / Flash with four model variants (each with `thinking` toggle)
- Extended thinking with full reasoning chain round-trip across multi-turn agent loops
- Tool calling support, including correct handling of DeepSeek's stricter
  `tools`-present round-trip rule
- LRU reasoning cache with `globalState` persistence
- Cost tracking: per-request and session-cumulative spending
- Status bar integration with `MarkdownString` hover tooltip
- Retry on transient failures (3 attempts, exponential backoff)
- Structured error handling with actionable buttons (401, 402, 422, 429)
- API key validation on save
