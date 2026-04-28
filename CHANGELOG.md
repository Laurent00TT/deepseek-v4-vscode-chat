# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Manual balance refresh now flashes a transient `$(check) DeepSeek balance:
  ¥xx.xx` message next to the status-bar item, so the user sees the new
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
