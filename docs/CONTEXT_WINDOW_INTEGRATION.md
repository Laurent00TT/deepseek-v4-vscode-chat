# Context Window Integration Design

## Status

Proposed. No implementation has been applied yet. Supersedes the previous
draft of this document, which recommended contributing into VS Code's
native `chat/contextUsage/actions` menu — that menu is gated behind the
`chatParticipantAdditions` proposed API and is therefore unusable for a
Marketplace-published extension.

Assessment based on the local VS Code source at
`C:\Users\11541\Desktop\projects\vscode` (tag `1.120.0`,
released 2026-05-13).

## Goal

Give users a clear, accurate view of how much of their DeepSeek V4
context window is used in the current Copilot Chat session, and offer
an actionable next step when the window is full.

Specifically, the experience must answer:

- How much of the context window does the latest request use?
- Which model variant is active, thinking or non-thinking?
- What did DeepSeek's API actually report for prompt and completion
  tokens (versus our local estimate)?
- Can the user invoke Copilot Chat's existing compaction flow when
  available?

## Why we cannot hook into VS Code's native context-usage widget

The previous draft proposed contributing a menu item into VS Code 1.120's
native `ChatContextUsageDetails` popup at the menu id
`chat/contextUsage/actions`. Verifying against VS Code source:

1. The menu id is real:
   [`menusExtensionPoint.ts:537`](file://C:/Users/11541/Desktop/projects/vscode/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L537).
2. It is gated by `proposed: 'chatParticipantAdditions'` on line 540.
   Extensions contributing to it must declare `enabledApiProposals`,
   and the Marketplace rejects any extension that does so.
3. The widget itself reads its data from
   [`IChatResponseModel.usage`](file://C:/Users/11541/Desktop/projects/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L264),
   which is populated by `ChatResponseStream.usage(...)` from the
   `ChatParticipant` API. Our extension is a `LanguageModelChatProvider`,
   not a `ChatParticipant`; we have no stable channel into that field.
   Even if we contributed the menu item, the widget would show whatever
   Copilot's agent loop chose to report (likely an estimate it computes
   from token-count alone), not DeepSeek's authoritative
   `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` numbers.

Both constraints are independent, and either alone is sufficient to
drop the native-widget integration. We design around them.

## Constraints (carried over from prior work)

The status quo on `main` already includes these decisions; they must
not be disturbed:

- Session cost derives from `/user/balance` deltas, not a hardcoded
  pricing table (commit `678d06f`).
- Status-bar percentage stays inside the main DeepSeek status item;
  no dual-item experiment (`5688c15`).
- Status-bar foreground is the standard `descriptionForeground` —
  no per-tier hex tinting (`5688c15`, doc-sync `d4b0e60`).
- Tooltip uses `MarkdownString` and must not use codicon
  `$(name~themeColor)` syntax — VS Code renders it as literal text
  in tooltips (`5688c15` revert).
- Tool-name validation anchors on DeepSeek's spec
  `^[A-Za-z0-9_-]{1,64}$`, no upstream-fork over-defensive rewriting
  (`139ff4a`).
- `Clear Reasoning Cache` command and `deepseekv4.logRawReasoning`
  setting protect private reasoning state (`f1be4a9`).

## Recommended design

Three surfaces, all inside the extension, no proposed-API dependency:

### 1. Status bar (unchanged)

Keep the current status-bar percentage. It is the fastest-glance
surface, works without Copilot, and already covers the `< 70%`,
`70-90%`, `> 90%` pressure cases textually in its tooltip.

### 2. Command-palette entry: `Show DeepSeek V4 Context Window`

A **webview panel** opened from `deepseekv4.showContextWindow`. The
original draft of this doc said QuickPick, but during implementation
the user asked for "1:1 visual parity with Copilot's native
ChatContextUsageDetails popup" (thin progress bar with striped
reserved region, outlined Compact Conversation button, sectioned
breakdown). QuickPick can render label / description / detail strings
only — no progress bar pixels, no styled buttons. Webview wins on
visual fidelity at the cost of a CSS file's worth of code.

The webview renders the latest `ContextUsageSnapshot`:

- header: `X.X K / Y.Y K total · NN.N%` with the percentage right-aligned
- 2-segment progress bar (used + remaining) over the 1M shared window
- "Next response: up to 384K (max_tokens cap)" caption (no longer a
  striped bar segment — the reserved chunk represents the NEXT turn's
  max_tokens slot, painting it as a third segment of "current usage"
  was the visual confusion that drove this design)
- "Last response: N tokens · M reasoning + L visible" row when
  apiCompletionTokens is set
- Breakdown rows for messages / tools (estimate-derived from server
  prompt_tokens × local char-ratio split)
- Stale `updatedAt` row
- Outlined `Compact Conversation` button

Implementation rules:

- Use only VS Code CSS variables (`var(--vscode-progressBar-background)`,
  `var(--vscode-button-border)`, etc.) — no hex colors. Theme
  adaptation is free.
- Render via `createElement` + `textContent`. Never `innerHTML`-with-
  interpolation, so there is no XSS surface even though all data is
  extension-controlled.
- CSP `script-src 'nonce-...'`; nonce generated via `randomBytes` from
  `node:crypto`, not `Math.random()`.
- Single panel per workspace via a module-level `currentPanel`
  variable; subsequent calls `reveal()` the existing panel. Explicit
  `disposeContextUsageWebview()` hook pushed into
  `context.subscriptions` for deactivate cleanup.

### 3. Compact bridge: `Compact Copilot Chat` command

`deepseekv4.compactCopilotChat`:

1. `vscode.commands.getCommands(true)` to check whether
   `github.copilot.chat.compact` exists.
2. If yes, execute it. The user gets Copilot's normal `/compact` flow.
3. If no, surface a single information message stating Copilot Chat is
   required.

Wording in command title and message must make clear that this invokes
**Copilot's** compaction. It does not touch our reasoning cache,
balance-anchor, or any DeepSeek-owned state.

Surfaced inside the webview from #2 as the prominent outlined button,
and inside the status-bar tooltip as a markdown link, so users who get
to either surface can act on overflow without leaving.

## Data model

```ts
interface ContextUsageSnapshot {
    modelId: string;
    modelDisplayName: string;
    thinking: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;

    // Local estimate buckets (always available, even before first response).
    // Renamed from estimatedPromptTokens to make clear it's messages-only;
    // server's prompt_tokens covers both messages AND tool definitions.
    estimatedMessageTokens: number;
    estimatedToolTokens: number;

    // Authoritative API-reported values (undefined before the first
    // streaming usage chunk lands).
    apiPromptTokens?: number;
    apiCompletionTokens?: number;
    apiCacheHitTokens?: number;
    apiCacheMissTokens?: number;
    apiReasoningTokens?: number;

    // Convenience derived field: prefers apiPromptTokens, falls back to
    // (estimatedMessageTokens + estimatedToolTokens) so the fallback total
    // is comparable to the API's prompt_tokens.
    usedTokens: number;
    updatedAt: number;
}
```

Note: an earlier draft of this doc carried a `percentage` field on the
snapshot. It was never consumed by any UI surface (all three readers —
status bar, tooltip header, webview header — computed their own
percentage from `(usedTokens + apiCompletionTokens) / totalWindow`)
and was dropped during review #2.

`apiPromptTokens` is what we surface as authoritative. Local estimates
are only shown when no API data exists yet (first turn of a session).
We deliberately do **not** surface a "drift ratio" in the user-facing
UI — it is a calibration metric for the `_charsPerToken` EMA inside
provider.ts, not actionable for the user. If we ever want to tune the
estimator, the existing OutputChannel `[usage]` log already records
both numbers per request.

## Implementation plan

### 1. Add `src/context_usage.ts`

A small service that owns the latest snapshot:

- `getSnapshot(): ContextUsageSnapshot | undefined`
- `updateEstimate(...)` — called before request dispatch
- `updateFromApi(usage: DSUsage, variant: DeepSeekModelVariant)` —
  called when streaming `usage` chunk arrives
- `clear(reason: string)` — called on `clearSession` and on
  `secrets.onDidChange`
- `onDidChange: vscode.Event<void>`

Module is vscode-free except for the event emitter; pure helpers are
unit-testable via the same `out/*.js` pattern we set up for
`shouldWarnCacheBreakdown` and `isValidToolName`.

### 2. Wire `src/provider.ts`

Two small touches, both already adjacent to existing logic:

- Before `fetchWithRetry`, call `contextUsage.updateEstimate(...)` with
  the same numbers that feed today's `inputTokenCount + toolTokenCount`
  overflow guard. No new tokenizer.
- After the final SSE chunk, call
  `contextUsage.updateFromApi(usage, variant)` from the same code
  path that currently writes to `_lastPromptTokens` etc.

Eventually the existing `_lastPromptTokens` family of provider fields
can be removed in favour of reading from `contextUsage` — but that is
a follow-up cleanup, not a prerequisite. Both writers can coexist
during the initial migration.

### 3. Register two commands in `src/extension.ts`

- `deepseekv4.showContextWindow` → opens the webview
- `deepseekv4.compactCopilotChat` → bridge to Copilot's compact

Also push `{ dispose: disposeContextUsageWebview }` into
`context.subscriptions` so the singleton panel tears down explicitly
on extension deactivate (rather than relying on VS Code's implicit
per-extension webview cleanup).

### 4. Wire the tooltip to the same snapshot

`buildTooltip` reads everything from `contextUsage.getSnapshot()` —
no parallel `_lastPromptTokens / _lastMessageTokens / _lastToolTokens`
provider fields. Earlier revisions mirrored snapshot data into those
fields and read them back here; the two-writer pattern was a drift
hazard and review #6 removed it. Provider keeps only cross-turn
state that isn't in the snapshot:

- `_peakCacheHitRate` — running max for cache-breakdown detection
- `_lastCacheWarnTime` — throttle for breakdown warnings
- `_contextNudgeFired` — one-shot per session 95% nudge

Tooltip also surfaces a `Context Details` link near the bottom that
runs `deepseekv4.showContextWindow`, connecting the quick-glance
tooltip to the deep-dive webview.

### 5. Update CHANGELOG

A new `[Unreleased]` entry covering: new commands, new context-usage
service, tooltip "Context Details" link. No version bump in this PR —
version bumps when we cut a release tag.

### Explicitly not in this plan

- No new contribution to `chat/contextUsage/actions` (proposed API).
- No new tokenizer dependency.
- No DeepSeek-owned conversation compaction.
- No re-introduction of per-tier status-bar tinting.

## Error handling

- **No request has run yet.** Webview shows an empty-state row
  ("No data yet — send a chat message to populate context usage")
  plus the Compact Conversation button.
- **API key missing.** Webview still opens; data rows simply show
  the static budget. Sending a message will surface the existing
  API-key walkthrough.
- **Copilot not installed.** `compactCopilotChat` returns a
  single-button information message. No throw, no error popup.
- **DeepSeek omits final usage chunk** (server bug, observed once during
  V4 GA). The snapshot retains the last good API values; the webview
  shows the stale `updatedAt` ("Last update: Xm ago") so the user can
  tell.
- **User switches model variant mid-session.** Snapshot is cleared on
  `secrets.onDidChange` and on `clearSession`. The next request
  re-anchors.

The non-negotiable rule: nothing in the context-usage path is allowed
to throw across the chat completion. Failures degrade silently, log to
the OutputChannel, and never block a request.

## Testing

### Unit (Node ESM, `npm test`)

- `context_usage.updateFromApi` overrides estimate
- `updateEstimate` fallback sums messages + tools (regression for
  review #1, where the old fallback used messages-only and
  under-counted by ~5-15%)
- `clear` resets to undefined
- snapshot survives `updateEstimate` after `updateFromApi`
  (estimate must not clobber more authoritative API values)
- model-variant switch invalidates both prior estimate and prior
  API data

These follow the established pattern of `unit_cache_breakdown.mjs` and
`unit_tool_name_validation.mjs`: pure helpers exported from a vscode-free
module, tests `import` from `out/*.js`.

### Manual smoke

- Run `Show DeepSeek V4 Context Window` before any chat — webview
  renders empty-state row plus Compact button.
- Run after a chat — header tokens / percentage / "Last response"
  row match the OutputChannel `[usage]` log.
- Switch model variant, observe snapshot reset.
- Install / uninstall Copilot Chat, observe `Compact Copilot Chat`
  branches correctly.
- Fill context past 95% — single warning toast appears, dismissing
  it does not re-fire until usage drops below 80%.

## Risks

- **Native widget evolves to a stable API surface.** If VS Code
  eventually stabilises a way for `LanguageModelChatProvider` to report
  authoritative usage to the native context widget, we should switch.
  Tracking issue is `microsoft/vscode#???` (none filed at time of
  writing — see Future Work).
- **`github.copilot.chat.compact` command renames.** It is a Copilot
  internal command, not part of the published extension API. Our bridge
  uses `getCommands` to detect existence; if Copilot renames it, we
  surface the "Copilot Chat is required" path until we update the
  detection string.
- **Tooltip "Open Details" link wording.** `MarkdownString` link text
  is user-facing; needs review for localization once the extension adds
  any localized strings beyond English.

## Non-goals

- Do not contribute into `chat/contextUsage/actions` (proposed API).
- Do not depend on `ChatResponseStream.usage(...)` or any
  `ChatParticipant` surface.
- Do not introduce a webview in v1.
- Do not reintroduce per-tier color on the status-bar item.
- Do not implement DeepSeek-owned conversation compaction.
- Do not surface `driftRatio` in the user UI.

## Future work

If and when VS Code publishes a stable API for
`LanguageModelChatProvider` implementations to report usage directly
into the native widget, we should:

1. Drop the QuickPick in favor of the native widget data path.
2. Move `compactCopilotChat` to be a contributed action inside that
   widget instead of a separate command.

Until then, this design is the most native-feeling layout that is
still Marketplace-publishable.
