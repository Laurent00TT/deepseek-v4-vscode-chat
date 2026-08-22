# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

<!-- Two release-ready groups below: "Vision" can ship alone as 0.4.0 (cut at
     the vision commit); the engineering-series entries can follow as 0.4.1+. -->

### Added

- **Native multimodal image input via `deepseek-v4-flash-vision-exp`** (DeepSeek's first vision model, released 2026-08-21). Two new picker variants — **Flash Vision (thinking)** and **Flash Vision** — declare `capabilities.imageInput`, so Copilot Chat enables image attachments; images are sent as base64 `data:` URLs inside the Vision content-block format (`{type:"text"}` + `{type:"image_url"}`), meaning DeepSeek sees the actual pixels — the "no vision proxy" pledge from the old *Text-only, by design* README section is honored, not worked around. The key wire invariant: **text-only messages keep the legacy plain-string `content` shape byte-for-byte** (block arrays appear only on user turns that actually carry an image to a Vision variant), so server prompt-cache prefixes and reasoning-cache fingerprints are unchanged for every existing conversation. Supported formats JPEG/PNG/GIF/WebP (unsupported attachments are dropped with a log warning rather than failing the request; non-Vision variants also warn instead of silently ignoring). Images are budgeted at up to 384 tokens each in the pre-flight overflow check, the context-usage estimate, and `provideTokenCount` — and subtracted before the chars/token EMA calibration so multimodal turns don't skew the estimator. DeepSeek's 48 MiB request-body cap (base64 counts) is pre-checked locally with an actionable "attach fewer/smaller images" message instead of an opaque server 4xx. Block assembly lives in the vscode-free `src/image_content.ts` (same extraction pattern as `tool_payload.ts`), pinned by `test/unit_image_content.mjs` (45 assertions, including the collapse-to-string invariant); `test/integration_vision.mjs` verifies the exact emitted wire shape live — it generates a solid-red PNG locally and requires the model to *see* it, in both thinking and non-thinking modes. Marketplace-visible metadata changed with this: the extension description now mentions Flash Vision / image input, and keywords gained `vision`, `multimodal`.

- **`test/integration_vision_multiturn.mjs`** — live three-turn Vision + tools + thinking round-trip using the exact request-body shape the extension emits (`stream_options.include_usage`, `thinking` + `reasoning_effort`, `tools` + `tool_choice`). Hard checks: the model tool-calls with the generated image's color (it sees it) and returns `reasoning_content`; the history `[user(blocks), assistant(tool_calls + reasoning_content), tool]` and a third-turn follow-up are accepted. Recorded, never fatal: whether the re-sent image prefix hits the server prompt cache (`usage.prompt_cache_hit_tokens` against the prior prompt size — the measurement that decides whether Files API `file_id` reuse would save anything), whether the strict `reasoning_content` rule also applies to the Vision model, and whether a `tool`-role message may carry an image block (the extension flattens tool results to text; this records whether that is our limitation or the API's).

- **Per-image 32 MiB pre-check on the Vision variants.** DeepSeek's Vision guide caps a single inline (base64/URL) image at 32 MiB, separately from the 48 MiB request-body cap; the largest user-turn attachment is now checked before the body is built and an actionable error ("attach a smaller image, or start a new chat") replaces the server 4xx. `MAX_IMAGE_BYTES` lives in `image_content.ts` and is pinned by `unit_image_content.mjs`.

- **`test/unit_request_body.mjs` — golden-request guard.** The serialized `/chat/completions` body is now pinned **byte-for-byte** against literal expected strings (thinking / non-thinking + tools / vision block-array cases, plus max_tokens clamp and thinking-mode param gating). The body assembly moved verbatim into the vscode-free `src/request_body.ts` (`buildRequestBody`, `coerceReasoningEffort`) to make that possible. Rationale: the server prompt cache keys on the request prefix and the reasoning-cache fingerprints are computed over the same converted messages, so a reordered key or an `undefined` that starts serializing silently costs users 12× on cache-miss input pricing without failing any behavior test — the byte-stability invariant was previously enforced only by review discipline.

- **`test/unit_sse.mjs` — first unit coverage of the SSE protocol path** (49 assertions). The pure protocol logic moved verbatim from provider.ts into the vscode-free `src/sse.ts`: `splitSseLines`, `parseSseData`, `extractDelta`, `isCleanFinish`, and `ToolCallAssembler` (the buffer/dedup/early-emit/flush state machine formerly spread across `StreamContext`, `tryEmitBufferedToolCall`, and `flushToolCallBuffers`); `tryParseJSONObject` moved with it (its only consumers) so the test import chain stays free of the `vscode` module. This is the highest-churn region in the repo's fix history (#19, #20, the 0.3.x cancellation/error-scoping fixes), and the tests pin exactly the behaviors a well-meaning refactor would "fix": `\n`-only line splitting (no CRLF normalization), the exact `data: ` prefix, exact `[DONE]` matching, only-JSON.parse-errors-are-malformed classification, usage captured from the EMPTY-choices final chunk independently of delta dispatch, post-completion tool-call deltas ignored, and the `flush(throwOnInvalid)` / `unknown_tool` asymmetries. What deliberately did **not** move: the reader loop and TextDecoder streaming state, the cancellation→`reader.cancel` bridge, all `progress.report` emissions (including the ThinkingPart reflection and the one-shot 💭 fallback), the wire→host name mapping, and the `finally`-path reasoning persist — the host-coupled seams whose ordering earlier entries document.

- **Retry backoff honors `Retry-After` and is now abortable.** When a 429/5xx response carries a delay-seconds `Retry-After` header, the backoff sleep is raised to it — capped at 10 s (`MAX_RETRY_AFTER_MS`), because a chat request stalled for minutes inside Copilot's UI reads as a hang; the honored value is logged (`retry.delay`). The HTTP-date header form and malformed values are ignored (never extend the wait). Alongside this, the backoff sleep itself became abort-aware (`abortableDelay`): a user's Cancel during the sleep now surfaces immediately instead of being ignored until the sleep ran out — previously a Cancel could sit unacknowledged for the full backoff. Covered by `test/unit_api_client.mjs` (30 assertions: delay computation, abortable sleep, retry/no-retry/abort paths via a monkey-patched fetch, and the `formatApiError` strings moved in the previous entry).

- **README: the long-promised "Billing & Copilot quota" section** ([#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16) — sub-agents spawned by Copilot's agent mode run on Copilot-hosted models and burn premium requests regardless of the selected BYOK model; documented remedies: uncheck `agent`/`runSubagent`, set `github.copilot.chat.exploreAgent.model`, or use Ask mode), plus a **FAQ/Troubleshooting** section covering the 400 `reasoning_content` error, the cache-breakdown warning, the context indicator requiring VS Code ≥ 1.120 ([#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18)), image-attachment gotchas, and the deliberate no-OpenRouter/base-URL stance ([#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4)); a six-variant model table; and an explicit **Privacy** section (zero telemetry, SecretStorage key, purgeable reasoning cache, no third-party image routing).
- **`README.zh-CN.md`** — full Chinese translation of the user-journey docs (features, models, vision, quick start, commands/settings, billing/quota, FAQ, privacy). English stays normative; the file carries a sync-stamp banner and the PR template gained a docs-synced checkbox so the two can't silently drift. Not shipped in the VSIX (Marketplace renders README.md only); the link resolves to the repo.

- **`CONTRIBUTING.md`** — the load-bearing invariants, in checklist form: the byte-stable request body (and its golden test), the frozen identifiers (vendor/model ids/settings/globalState keys) and frozen algorithms (fingerprint, wire aliasing) that key user-persisted state across upgrades, the bug-compatible-not-spec-compliant SSE rules, zero runtime dependencies, the pure-module + thin-adapter house pattern, the full verification matrix (including which tests need a funded `DEEPSEEK_API_KEY`), and release/revert mechanics. Previously these lived only in scattered code comments.

### Changed

- **Model catalog and HTTP layer extracted to leaf modules** (`src/model_catalog.ts`: `MODEL_VARIANTS` + `findVariant`; `src/api_client.ts`: `fetchWithRetry`, `formatApiError`, endpoint constants, `BalanceInfo`) — verified byte-identical moves. Deliberately **left** in provider.ts: `refreshBalance` (its HTTP call interleaves with session-anchor mutation and status-bar refresh — no clean seam), `notifyApiError` and the picker-info assembly (vscode-bound). provider.ts drops from 2,243 to 1,935 lines across this and the SSE extraction.

- **Repo-wide prettier adoption, pinned and CI-enforced.** One-time `prettier --write` pass over the TS sources (semantically neutral — verified by compile, eslint, all unit suites including the `out/provider.js` text pin, and a vsce dry package; compiled string literals unchanged). Prettier is now pinned exactly (`3.8.3`) because formatting drifts across prettier minors, and CI gained a `prettier --check` step so style can no longer drift. The reformat commit is listed in `.git-blame-ignore-revs`, which GitHub's blame view honors natively.

- **Live-API observation (2026-08-22): DeepSeek no longer returns the `reasoning_content` 400.** Every history shape the integration scripts test — tool-call turns and plain turns, with and without `tools`, on `deepseek-v4-pro`, `deepseek-v4-flash` and the Vision model — was accepted without `reasoning_content` (`integration_round_trip` three times in a row, plus `integration_tools_present`, `integration_no_tc_assistant`, `integration_tools_advertised_no_tc`, `integration_cache_miss_fallback`, `integration_vision_multiturn`), while the Thinking Mode guide still documents the 400. **No extension behaviour change**: reasoning is still attached to every prior assistant turn (the model otherwise continues from a history stripped of its own chain of thought; the server prompt-cache prefix is byte-stable only if the same bytes are re-sent; and it keeps working if the rule is re-tightened). `integration_round_trip.mjs` and `integration_cache_miss_fallback.mjs` now *record* whether the negative case is rejected instead of failing on acceptance — as written they were going red on the relaxed server and, in the round-trip script, blocking their own positive check. The same live run also settled two open questions: the re-sent base64 image prefix **does** hit the server prompt cache (so Files API `file_id` reuse has no token-cost case), and Chat Completions accepts an `image_url` block inside a `tool` message (text-flattening of tool results is our choice, not an API limit). README/ARCHITECTURE updated accordingly.

- **`.gitattributes` pins LF in the working tree (`* text=auto eol=lf`).** On Windows with the default `core.autocrlf=true`, every text file checked out as CRLF and `npx prettier --check .` (endOfLine `lf`) flagged all sources even though CI was green — the CONTRIBUTING verification matrix could not pass on a stock Windows clone. The index was already LF everywhere, so this is checkout-only; existing clones re-checkout once with `git rm --cached -r . && git reset --hard`.

## [0.3.11] - 2026-08-19

### Fixed

- **Stray `.claude/` worktree directories no longer get bundled into the VSIX.** vsce packs everything not blacklisted in `.vscodeignore`, so a leftover Claude worktree under `.claude/worktrees/` silently ballooned a local build from ~110 KB to 885 KB (81 stray files, including a stale `.vsix`). The directory is now excluded wholesale.

### Added

- **[#22](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/22): peak/off-peak pricing panel in the status-bar tooltip.** DeepSeek moved V4 Flash/Pro to time-of-day billing on 2026-08-16 (peak 01:00–04:00 and 06:00–10:00 UTC, off-peak everywhere else). Hovering the balance now shows a panel pinned above the header that lists BOTH windows in local wall-clock time, with a read-only radio dot marking the side of the boundary the system clock is on right now — `$(circle-filled)` + bold for the active window, `$(circle-outline)` for the other (UTC+8 renders peak `09:00–12:00 · 14:00–18:00` against off-peak `12:00–14:00 · 18:00–09:00`). Row labels are bilingual (`Peak/高峰`, `Off-peak/非高峰`) — DeepSeek's billing announcement and the bulk of the user base are Chinese, and two constant strings don't warrant an l10n pipeline. This replaced the first-cut one-line hint (`$(check) Off-peak pricing · until 09:00`) after design review: the full table answers both "which side am I on" and "when does it flip" at a glance, without a separate countdown row crowding the balance section. Off-peak ranges are computed as the ring complement of `PEAK_WINDOWS_UTC` (`offPeakWindowsUtc`) — never hand-maintained as a second constant that could drift; `formatWindowsLocal` shifts windows by the live `Date#getTimezoneOffset()` (so DST transitions self-correct at the next tooltip rebuild), re-sorts by local start (UTC−5 sees `01:00–05:00 · 20:00–23:00`, not the raw UTC order), and renders midnight-crossing ranges as-is (`18:00–09:00`) rather than splitting them into two rows for half the world's timezones. Only the window is hardcoded (`src/off_peak.ts`, one documented constant) — no prices or multipliers, consistent with the balance-diff cost philosophy: prices drift, and the real bill stays anchored to `/user/balance`. A one-shot timer re-armed at each window edge rebuilds the tooltip so an idle window can't show yesterday's dot after sitting across a boundary (the tooltip is declarative — see the `flashRefreshAck` comment).
- **`test/unit_off_peak.mjs`** — pins the window constant and the half-open `[start, end)` edge convention second-by-second around all four edges, `nextBoundary`'s strictly-after semantics (including sub-minute precision, the evening wrap to next day, and a month rollover), the structural invariants the boundary timer relies on (every edge flips the state; the next boundary is always in the strict future within 24h), the off-peak complement's exact shape plus the panel's partition invariant (peak + off-peak windows cover the full 24h ring — a drifted complement would render overlapping or missing hours), and `formatWindowsLocal` across UTC+0 / +8 / −5 / +5:30: local-start re-sorting, as-is midnight wraps, and half-hour-timezone minute rendering.

## [0.3.10] - 2026-08-12

### Fixed

- **The 128-tools-per-request cap now counts the tools actually sent to the API, not the raw host list.** The pre-request guard in `provideLanguageModelChatResponse` counted `options.tools`, but since the issue #20 wire-aliasing fix tool assembly may skip unusable or colliding tools — so a host list slightly over 128 whose broadcast set is back under the cap was rejected for a violation that never reached the wire. The guard (`assertAdvertisedToolLimit` in `src/tool_limit.ts`) takes the advertised `OpenAIFunctionToolDef[]` itself, not a count: VS Code's host tool shape is structurally incompatible, so re-feeding `options.tools` (or any hand-computed number) is a compile error. One deliberate edge: a host list of **any** size whose tools are all unusable now proceeds as a tool-less request (each skip individually logged) instead of throwing the old — and factually wrong — "more than 128 tools" error; this matches what already happened for the same input at ≤128 tools.

### Changed

- **Tool payload assembly extracted to the vscode-free `src/tool_payload.ts`** (`buildToolPayload`: schema sanitization, wire-alias skip logic, tool_choice resolution — moved verbatim from `utils.ts`), leaving `convertTools` as a thin enum→boolean adapter. Third instance of the `tool_names.ts` / `tool_choice.ts` extraction pattern; done so the unit harness can execute the real skip-then-count path instead of asserting about it textually.

### Added

- **`test/unit_tool_limit.mjs`** — pins the cap constant, the guard boundary (128 passes, 129 throws), and the real regression scenario end to end: 130 host tools with 5 unusable names advertise 125 defs and pass, 129 usable defs throw, all-unusable lists advertise nothing, and every skip logs exactly one diagnostic line. A deliberately minimal best-effort text pin over comment-stripped `out/provider.js` guards the two properties the type system can't: the guard call exists in provider.ts, and no inline host-list count check has crept back.

## [0.3.9] - 2026-08-12

### Fixed

- **[#20](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/20): one over-long MCP tool name crashed every chat request.** PyLance v2026.3.1's `pylanceCheckSignatureCompatibility` arrives behind VS Code's MCP prefix as a 72-char name, violating DeepSeek's `^[A-Za-z0-9_-]{1,64}$` function-name spec — and `validateTools` hard-threw on the first illegal name, so any Python user with current PyLance lost chat entirely (the request never reached the model). Tool names are now **deterministically wire-aliased** instead of rejected: spec-legal names pass through unchanged; illegal characters become `_` with an `fnv1a32` hash of the original appended to every changed alias (bare sanitization is lossy — `weather.get` would collide with a legitimate `weather_get` sibling, and equal-length CJK names would all collapse to the same underscore run); names too long for `sanitized+hash` compress to `head(22) + tail(32) + hash` (exactly 64 chars — the tail keeps the semantically distinguishing suffix legible for the model). The stream layer maps the model's echoed alias back to the host name before reporting, so VS Code's tool registry always dispatches on the names it registered — resolving the "the model's echo wouldn't match the registry" objection that made 0.3.6 choose hard rejection over the upstream fork's silent rewriting (which had no reverse map and routed calls nowhere). Reasoning-cache fingerprints key on wire names on **both** the write side (`ctx.emittedToolCalls`) and the read side (over `convertMessages` output); keying them differently would have made every aliased tool call a guaranteed cache miss — issue #19's reasoning-loss failure mode all over again. Names that are unusable even after aliasing (empty or non-string) or that collide (vanishingly rare hash collision) skip just that tool with a logged error instead of failing the request.

### Added

- **`test/unit_tool_wire_name.mjs`** — 31 assertions covering spec-legal passthrough, sanitization, the exact issue #20 PyLance name, determinism, idempotence, sibling-collision resistance, and `buildWireNameMap` round-trip/first-wins semantics. A frozen-literal case pins the aliasing algorithm: changing the head/tail split or hash function breaks fingerprint continuity for conversations spanning extension versions, so it must be a deliberate versioned decision, not drift.

## [0.3.8] - 2026-07-28

### Fixed

- **[#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19): false "prompt cache hit rate dropped to 0%" popups.** The cache-breakdown warning pipeline (per-request hit rate, session peak, and the `shouldWarnCacheBreakdown` gate) ran for **every** request, but Copilot routes auxiliary requests (chat-title, summarization, todo tracking, …) through the selected model too. An auxiliary request has a novel prompt prefix — its server cache hit rate is legitimately ~0% — and Copilot re-renders conversation history inside it, so its reasoning fingerprints miss (a turn stored under a `tc:` tool-call key re-renders as text and computes a `tx:` key that was never stored). Compared against a 100% peak set by the healthy main conversation, that satisfied every warning gate and fired the popup in-session with no actual cost problem. The warning (and peak tracking) now only consider real conversation turns, reusing the same `isReportableContextRequest` classification that already gates the native context indicator (issue #17). The classifier previously had **no** prefix for Copilot's conversation-summarization (compaction) request — the single worst offender, since it re-renders the entire history — so it fell into the reportable `background` catch-all; a new `conversation-summarizer` kind now matches it (prompt prefix verified against `microsoft/vscode-copilot-chat`'s `summarizedConversationHistory.tsx`, shared by both full and simple summarization modes). This also stops summarization requests from clobbering the native context indicator.
- **Reasoning lost for cancelled or mid-stream-failed turns.** `persistReasoningForTurn` only ran when the stream delivered a `finish_reason` chunk or the `[DONE]` sentinel. Hitting Stop exits the read loop before either arrives, and a mid-stream throw (e.g. invalid tool-call JSON on a clean finish) propagates before the persist call — in both cases the turn's `reasoning_content` was dropped while the partially-streamed text stayed in chat history, making that turn a guaranteed reasoning-cache miss (and a broken server prompt-cache prefix) on every later request in the conversation. The stream reader's `finally` now performs an idempotent best-effort cache write covering all abnormal exits. One deliberate exception: a turn whose only emitted text is the `💭 Thinking...` fallback hint (hosts without `LanguageModelThinkingPart`) is treated as unkeyable — that constant text would give every such cancelled turn the same fingerprint and unrelated turns would overwrite each other's reasoning.
- **Misleading warning wording.** The popup asserted the cache was "likely evicted or lost across a restart" — a hard-coded guess that misdirected issue #19's diagnosis (the reporter never restarted). It now lists the possible causes neutrally and defers diagnosis to *Show Cache Stats*.

### Added

- **`test/unit_reasoning_cache.mjs`** — first coverage of the fingerprint set/get symmetry the reasoning cache depends on: whitespace/NFKC-insensitive `tx:` keys, order-insensitive `tc:` keys, the documented `tc:`/`tx:` flip asymmetry, LRU bump/eviction order, in-session byte-cap eviction, `restore()` sanitization, and the stats-exempt lookup below.
- **Stats-exempt cache lookups for auxiliary requests.** `ReasoningCache.get(fp, countStats)` — auxiliary requests still get the full attach (the `""` stub is required to avoid a 400) and still LRU-bump entries, but no longer pollute the hit/miss counters behind *Show Cache Stats*. Before this, a handful of summarization/title requests could drag the displayed hit rate under the 50% threshold and trigger that command's own "cache broken, start a new chat" advice for a perfectly healthy conversation.

## [0.3.7] - 2026-06-08

### Changed

- **Context-window usage now feeds Copilot Chat's _native_ context indicator instead of a custom status-bar percentage.** After each turn the provider reports `usage` (prompt / completion / total / cached tokens) to the host via a `usage`-MIME `vscode.LanguageModelDataPart` on the response `progress` stream. Copilot's native indicator is **per-conversation and follows the focused chat** — something a status-bar item could never do, because a `LanguageModelChatProvider` receives no conversation id and no focus signal. With multiple chats open the old custom percentage could only ever show "the last turn that ran" and visibly swapped between conversations ([#17](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/17)). The status bar now shows balance + session spend only. Mechanism mirrors the upstream [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot) provider.

### Added

- **Request classification (`src/request_kind.ts`)** so only real conversation turns drive the native context indicator. Copilot routes many small auxiliary requests through the selected model — notably a `chat-title` request right after the **first** turn, plus progress messages, todo tracking, prompt categorization, git branch/commit messages, and rename suggestions. Each carries only a few hundred tokens; reporting their usage reset the indicator to ~0% (the symptom where the percentage collapsed once the first task finished). Requests are classified by system-prompt prefix (mirrors the upstream classifier); only `main-agent` / `background` (real) turns are reported. 31 assertions in `test/unit_request_kind.mjs`. A `ctxusage` line in the `DeepSeek V4` output channel logs the classified kind and whether it was reported.

### Removed

- **Custom status-bar context-usage percentage (`X.X%`), the tooltip "Context Window" breakdown block, and the `deepseekv4.showContextUsage` setting** — superseded by the native indicator above. The DeepSeek-specific cache-hit-rate row stays in the status-bar tooltip; the one-shot 95% context nudge is unchanged. (`ContextUsageService` and its snapshot remain internally, driving the nudge and the cache-hit row.)

### Fixed

- **[#17](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/17): the status-bar context percentage flickered / swapped between conversations** with multiple chats active, and reflected the most-recently-run chat rather than the focused one. Resolved by delegating context display to Copilot's native per-conversation indicator.

## [0.3.6] - 2026-05-19

### Added

- **Context-usage indicator in status bar.** Live `X.X%` of the context window used, rendered in the standard description-foreground color (the percentage segment was deliberately kept inside the main DS V4 status item rather than split into a tier-coloured second item, after a brief experiment let other extensions like Python's "No Environment" slot in between and break visual cohesion). Tooltip shows a Current / Messages / Tools breakdown plus a Cap explanation (`1M − 384K reserved for thinking chain`).
- **`Clear DeepSeek V4 Reasoning Cache` command** for scrubbing private state from globalState before sharing logs or switching projects. Awaits a hard `globalState.update` flush before reporting success, so a reload immediately after clearing cannot restore stale reasoning.
- **`deepseekv4.showContextUsage` setting** to toggle the status-bar percentage indicator.
- **`deepseekv4.logRawReasoning` setting** (default `false`) gates streaming of raw `reasoning_content` to the OutputChannel. Previously the channel captured every reasoning byte unconditionally, which could leak private code, paths, or intermediate state into bug-report logs.
- **Cache-hit-rate display in tooltip** plus a breakdown warning when local reasoning-cache misses cause server-side prompt-cache prefix to collapse. Throttled to at most one warning per 5 minutes.
- **Actionable error dialog for HTTP 400 context-overflow.** Detects "maximum context length" / "reduce the length" wording from DeepSeek and surfaces Start New Chat / Show Log buttons instead of a cryptic 400.
- **`DeepSeek V4: Compact Copilot Chat` command.** Detects whether `github.copilot.chat.compact` is registered (so a freshly-installed Copilot Chat works without an extension reload). If present, runs Copilot's compaction flow; if absent, surfaces a single information message. Does **not** touch DeepSeek-owned state (reasoning cache, balance baseline, etc.) — wording reflects this explicitly.
- **One-shot 95% context-window nudge.** When the shared 1M context crosses 95% a single yellow toast offers `Compact Conversation`. Re-arms automatically when usage drops below 80%, so dismissing the prompt does not result in re-nagging every turn.
- **Internal: `src/context_usage.ts` + `src/context_usage_service.ts`** — shared snapshot for context-window state. Pure helpers (vscode-free) in `context_usage.ts`; stateful wrapper with `vscode.EventEmitter` in `context_usage_service.ts`. Matches the pattern used by `cache_breakdown.ts` and `tool_names.ts`. (Drives the status-bar percentage and tooltip breakdown. The companion `Show DeepSeek V4 Context Window` webview command stays compiled but is intentionally not surfaced in this release — see `docs/CONTEXT_WINDOW_INTEGRATION.md` "Release status (0.3.6)".)
- **Unit tests:** `test/unit_context_usage.mjs` (28 assertions covering estimate vs API authority, model-switch invalidation, clear-state recovery, and the breadcrumb case) and `test/unit_tool_choice.mjs` (9 assertions for the new `resolveToolChoice` helper).

### Changed

- **Session cost now derived from `/user/balance` diff** instead of a hardcoded price table. The displayed figure always matches the real bill regardless of DeepSeek's frequent price changes (e.g. the cache-hit input cut to 1/10 on 2026-04-26, and the Pro 75%-off discount extended to 2026-05-31). Currency follows the account directly.
- **Tool-name validation is strict.** Names that `sanitizeFunctionName` would rewrite — digit-leading (`1tool`), underscore-leading (`_private`), consecutive underscores (`foo__bar`), or longer than 64 chars — are now rejected with an actionable error showing the rewrite that would have happened. Previously such names were silently rewritten before send, and the model's echo didn't match VS Code's registry, so the tool call routed nowhere.
- **Reasoning-content attachment is thinking-mode only.** Switching from a thinking to a non-thinking variant strips stale `reasoning_content` from prior assistant turns instead of forwarding it.
- **Thinking variants now configure `maxOutputTokens = 384K`** to cover the full reasoning-chain budget at max effort (was 256K, which silently truncated long chains). Input budgets recomputed as `1M − maxOutputTokens` to honour DeepSeek's combined 1M ceiling.
- **`ARCHITECTURE.md` cross-turn rule relaxed** to reflect the 2026-05 server behaviour: DeepSeek now accepts requests that omit `reasoning_content` on non-tool-call assistant turns, even when `tools` is advertised.
- **Tooltip `MarkdownString.isTrusted` narrowed.** Was `true` (full trust — any `command:URI` in the tooltip markdown would execute on click). Now `{ enabledCommands: [...] }` listing exactly the command IDs the tooltip actually renders. Defense-in-depth against future regressions that might let dynamic data leak into command-link positions.

### Fixed

- **Token K/M units use SI base-1000.** The previous base-1024 (KiB) formatter caused a confusing mismatch where the header showed "106.8K" while the body's Prompt-tokens row showed "109,067" for the same value (109,067 / 1024 = 106.5; only visible after putting both representations side by side). LLM APIs universally price and report tokens in decimal — we now match.
- **`User-Agent` and boot log no longer report `ext=unknown`.** The `EXT_ID` constant was stale (`deepseek-community.…` left over from a fork's previous publisher); `vscode.extensions.getExtension` silently returned `undefined` and the version fell back to `"unknown"`. Now reads the version directly from `context.extension.packageJSON`.
- **SSE handler no longer swallows runtime errors from `processDelta`.** The try/catch around `JSON.parse(data) + await processDelta(...)` was eating any `processDelta` throw — including the deliberate "Invalid JSON for tool call" raised by `flushToolCallBuffers` on a clean `finish_reason="tool_calls"` chunk. The host saw a successful stream with no tool call (worst-kind silent failure for an agent loop). Parse errors are now caught + logged + continue; everything else propagates.
- **`ToolMode.Required` with multiple tools no longer throws.** VS Code's `Required` semantic is "must call at least one tool" — with a single candidate that is equivalent to forcing the named function, but with multiple candidates we now send DeepSeek's (OpenAI-compatible) `tool_choice: "required"` literal. Previously the path hard-threw, blocking valid agent scenarios.
- **Cancellation now interrupts streaming reads immediately.** The cancellation token is bridged into `reader.cancel()` inside `processStreamingResponse`; previously cancelling a long thinking-mode request would hang `await reader.read()` for tens of seconds waiting for the next SSE chunk.
- **API key change re-anchors session baseline.** A silent `refreshBalance(true)` fires after the secret listener resets state, so session-spend tracking keeps working after a key swap without requiring the user to manually click the refresh link.
- **`registerLanguageModelChatProvider` Disposable** is now pushed into `context.subscriptions` so it disposes cleanly on extension deactivate.

### Removed

- Hardcoded `PRICING` USD/CNY tables and `estimateCost` function (replaced by balance-diff session spend, see Changed).
- Dead `.vscode-test.mjs` config pointing at a non-existent `out/test/**/*.test.js`.
- Unconditional raw-reasoning streaming to OutputChannel (now gated by `deepseekv4.logRawReasoning`).

### Security

- **`npm audit fix` resolves two high-severity advisories** (`GHSA-q3j6-qgpj-74h6` path-traversal and `GHSA-v39h-62p7-jpjc` host-confusion in `fast-uri` ≤3.1.1, both CVSS 7.5). Dependency chain was `@vscode/vsce → secretlint → ajv → fast-uri`. Dev-dependency only, never shipped in the VSIX runtime, but the packaging pipeline itself touched the vulnerable code path.

### Documentation

- `docs/CONTEXT_WINDOW_INTEGRATION.md` — design rationale for the context-window subsystem, including the verified reason VS Code's native `chat/contextUsage/actions` menu cannot be a contribution target (proposed API, Marketplace-incompatible), and a "Release status (0.3.6)" section documenting which surfaces ship and which stay internal.

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
