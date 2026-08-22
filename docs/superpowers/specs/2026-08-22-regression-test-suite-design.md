# Regression test suite — design (2026-08-22)

Status: approved by the maintainer in chat on 2026-08-22 (option "P0 + P1, all").

## Goal

After any upgrade — VS Code API, DeepSeek protocol, or our own refactors — a single
`npm test` run must answer three questions:

1. **Did the wire bytes change?** (request body for text / tools / vision /
   reasoning-attach)
2. **Did a frozen identifier or persisted format change?** (model ids, settings
   keys, command ids, vendor, SecretStorage / globalState keys, reasoning-cache
   serialization, fingerprint algorithm)
3. **Did adapter behaviour change?** (streaming, cancellation, error mapping,
   picker entries, activation)

Today 13 unit suites cover the pure modules only. `utils.ts` (the whole
VS Code → OpenAI message adapter), `provider.ts` (reasoning attach/persist,
stream loop, usage capture, error mapping, picker) and `extension.ts`
(activation, commands) have no automated coverage because they import
`vscode`.

## Decision: minimal `vscode` shim for adapters, pure modules stay mock-free

- Pure modules keep the house rule: tests import `../out/*.js` in plain Node,
  no `vscode` anywhere in the import chain.
- Adapter modules (`utils`, `provider`, `extension`) are tested against the
  **real compiled output** with a hand-written minimal `vscode` replacement
  injected by a `--require` preload that patches `Module._resolveFilename`
  (the compiled output is CommonJS, `require("vscode")`). Production code is
  not changed for testability.
- The shim implements only the API surface the three adapters use (~25
  symbols) and carries **no logic of its own** beyond recording calls and
  returning preset answers. Adding an API to the shim is fine; adding
  behaviour that the real VS Code does not have is not.
- Coverage is reported with `c8` (devDependency only; the VSIX stays at zero
  runtime dependencies). First version: report, no threshold gate.

Rejected alternatives: extracting more pure modules (each extraction is a
production change made *for* testing, and stream/progress/finally-persist
logic is adapter logic by nature); real VS Code integration tests via
`@vscode/test-electron` (needs Copilot Chat for the LM provider API; slow).

## A. Infrastructure

| Piece | Contents |
| --- | --- |
| `test/vscode_shim/index.cjs` | Classes: `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, `LanguageModelDataPart` (+ static `json` / `image` / `text`), `MarkdownString`, `ThemeIcon`, `ThemeColor`, `EventEmitter`, `Disposable`, `Uri` (`parse`), `CancellationTokenSource`. Enums: `LanguageModelChatMessageRole`, `LanguageModelChatToolMode`, `StatusBarAlignment`, `ProgressLocation`, `ViewColumn`. Namespaces as recordable stubs: `window` (`showErrorMessage` / `showWarningMessage` / `showInformationMessage` / `showInputBox` / `setStatusBarMessage` / `withProgress` / `createOutputChannel` / `createStatusBarItem` / `createWebviewPanel`), `commands` (`executeCommand` / `registerCommand` / `getCommands`), `workspace.getConfiguration`, `env.openExternal`, `lm.registerLanguageModelChatProvider`, `extensions.getExtension`, `version`. Each stub records its calls (`shim.calls.<name>`) and returns a preset answer (`shim.answers.<name>`); `shim.reset()` clears both. `LanguageModelThinkingPart` is **absent by default** (tests the 💭 fallback) and can be installed per test (`shim.installThinkingPart()`). |
| `test/vscode_shim/register.cjs` | `--require` preload: resolves the bare specifier `vscode` to `index.cjs`. Usage: `node --require ./test/vscode_shim/register.cjs test/adapter_x.mjs`. |
| `test/helpers/check.mjs` | `check(label, got, expected)`, `checkDeep`, `summary(name)` → prints the `=== Results: N passed, M failed ===` line and sets the exit code, matching the existing suites. |
| `test/helpers/fakes.mjs` | `fakeSecrets()`, `fakeMemento()`, `fakeOutputChannel()`, `fakeStatusBarItem()`, `fakeCancellationToken()`, `progressCollector()`, `sseStream(chunks)` (array of strings → `ReadableStream<Uint8Array>`), `withFetch(handler, fn)` (temporarily replaces `globalThis.fetch`), `makeProvider(overrides)` (constructs a real `DeepSeekV4ChatModelProvider` with the fakes). |
| `package.json` scripts | `test:unit` unchanged; `test:adapter` runs every `test/adapter_*.mjs` with the preload; `test` = both; `test:coverage` = `c8 --reporter=text --reporter=text-summary npm test`. CI runs `npm test` and `npm run test:coverage` (report only). |

## B. Test matrix

### P0 — upgrade red lines

| File | Pins |
| --- | --- |
| `test/unit_model_catalog.mjs` (pure) | All six variants' `id`, `displayName`, `apiModel`, `thinking`, `vision`, `maxInputTokens`, `maxOutputTokens` as literals; ids unique; `findVariant` hit/miss; vision ⇒ `imageInput` derivation. |
| `test/unit_manifest.mjs` (pure; reads `package.json` + compiled `out/*.js` text) | vendor `deepseek-v4` in `contributes.languageModelChatProviders`; the seven contributed command ids and titles; the two settings keys with enum/default; `engines.vscode`; walkthrough id equals the constant in `out/extension.js`; SecretStorage key `deepseekv4.apiKey` and globalState keys `deepseekv4.reasoningCache` / `deepseekv4.welcomeShown` present verbatim in the compiled output. |
| `test/adapter_convert_messages.mjs` | `convertMessages`: role mapping (user/assistant/system); assistant `tool_calls` (generated id when `callId` missing, `JSON.stringify(input)`, `toWireName` aliasing, `content` undefined when no text); tool results → `role:"tool"` with `tool_call_id`, text concatenation, `cache_control` sentinel dropped silently, unknown parts dropped with a warning; user images (vision on → blocks; vision off → dropped + warn; unsupported MIME → dropped + warn; text-only stays string); empty text never emitted. `convertTools` (`Required` → named / `required` tool_choice). `validateRequest` (missing tool result throws; well-paired passes; empty list throws). `isToolResultPart`. |
| `test/adapter_request_golden.mjs` | End-to-end golden: a realistic VS Code history (system, user, assistant text, assistant tool_call, user tool-result carrying the `cache_control` sentinel, user with image) → `convertMessages` → reasoning attach with a pre-seeded `ReasoningCache` → `buildRequestBody` → `JSON.stringify` compared **byte-for-byte** against literal strings for three cases: thinking + tools, non-thinking, vision. |

### P1 — adapter behaviour

| File | Pins |
| --- | --- |
| `test/adapter_provider_stream.mjs` | `processStreamingResponse` over `sseStream`: text/reasoning interleave (ThinkingPart when installed, else one 💭 hint per turn); tool-call delta assembly, early emit, host-name reverse map; usage captured from the empty-`choices` chunk; `finish_reason` handling (`length`, `content_filter`, `insufficient_system_resource` → error toast with "Show Log"); `[DONE]` flush; cancellation → `reader.cancel` called and reasoning still persisted from `finally`; mid-stream throw still persists; a turn that emitted only the 💭 hint is not cached. |
| `test/adapter_provider_reasoning.mjs` | `attachReasoningToHistory`: hit, miss → `""`, non-thinking variant strips `reasoning_content`, `countStats=false` leaves stats untouched; `persistReasoningForTurn` `tc:` / `tx:` anchors, set side keyed on the wire name; cross-instance restore (second provider built from the first one's `globalState` hits). |
| `test/adapter_provider_request.mjs` | `provideLanguageModelChatResponse` with `withFetch`: request headers (Authorization, User-Agent) and body bytes; non-retryable 400-with-reasoning → "Start New Chat" / "Show Log"; 401 → "Update API Key"; 402 / 422 / 429 mapping; 48 MiB and 32 MiB pre-checks (toast + throw); token-overflow pre-check; post-usage: EMA calibration, `contextUsage.updateFromApi`, `usage` DataPart reported only for real turns, cache-breakdown warning gate, 95 % / 80 % context nudge hysteresis. |
| `test/adapter_provider_info.mjs` | `prepare/provideLanguageModelChatInformation`: six entries, with/without key (tooltip, `detail`, `statusIcon`), `capabilities.imageInput` only on vision, `family` / `version`; `provideTokenCount` (text estimate, image = 384); secret change fires `onDidChangeLanguageModelChatInformation` and resets session state. |
| `test/adapter_extension_activate.mjs` | `activate`: registered command set (incl. the unexposed `showContextWindow`), `registerLanguageModelChatProvider("deepseek-v4", …)`, Manage command (empty input → `secrets.delete`; validation failure → "Save anyway" flow), welcome (existing key → no walkthrough but `welcomeShown` written; no key → `openWalkthrough` + `welcomeShown`), compact bridge with/without the Copilot command. |
| `test/unit_tool_payload.mjs` (pure) | `sanitizeSchema` branches via `buildToolPayload`: `anyOf` prefers the `string` branch, integer-like property names become `integer`, unknown keywords pruned, `required` filtered to strings, non-boolean `additionalProperties` removed, array `items` normalised, non-object input → empty object schema; missing description → `""`; `tool_choice` passthrough. |

### P2 — optional

`test/adapter_status_tooltip.mjs` (`buildTooltip` rows incl. the peak/off-peak
panel and the no-balance state), `test/adapter_context_usage_service.mjs`.

## C. Documentation

- CONTRIBUTING: replace "no vscode mock" with the layered statement above;
  add `npm run test:coverage` to the verification matrix; the shim rule
  ("APIs yes, behaviour no").
- ARCHITECTURE: new "Test strategy" subsection (pure vs adapter tests, how
  the shim is injected, what the golden tests guard).
- CHANGELOG: one entry under Added.

## D. Out of scope

Webview HTML rendering tests; real VS Code integration tests; a coverage
threshold gate (first version reports only).

## Implementation order

1. Infrastructure (shim, register, helpers, scripts, c8) + one smoke adapter
   test proving the preload chain works.
2. P0 files, then P1 files — each test file is independent and lands as its
   own commit so any one can be reverted alone.
3. Docs + CHANGELOG.
4. Full matrix (`compile`, `lint`, `test`, `test:coverage`, `prettier --check`,
   `vsce package`) before hand-off.
