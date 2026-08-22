# Contributing

Small extension, sharp invariants. Most of the risk here is not "does the
code work" but "does the wire stay stable" — a live user base's prompt-cache
economics and persisted state depend on details that no type system checks.
Read this before touching the protocol layer. `ARCHITECTURE.md` explains
*why* these invariants exist; this file is the checklist form.

## Hard red lines

Things that must survive every change. Breaking one is not a style issue —
it silently costs users money or orphans their persisted state.

1. **The serialized request body is byte-stable for text-only
   conversations.** DeepSeek's server prompt cache keys on the request
   prefix (cache-miss input is priced far above cache-hit), and the
   reasoning-cache fingerprints are computed over the same converted
   messages. Key insertion order, `undefined`-vs-absent, and number shapes
   all matter. Mechanically enforced by the golden test
   (`test/unit_request_body.mjs`) — if it fails, you either made a
   deliberate, CHANGELOG-worthy wire change or you have a bug. There is no
   third option.
2. **Frozen identifiers.** `vendor: "deepseek-v4"`, the model ids
   (`deepseek-v4-pro::thinking`, …), settings keys (`deepseekv4.*`),
   command ids, the SecretStorage key (`deepseekv4.apiKey`), and the
   globalState keys (`deepseekv4.reasoningCache`, `deepseekv4.welcomeShown`)
   are user-visible or user-persisted. Renaming any of them breaks model
   picker selections, keybindings, or stored state on upgrade.
3. **Frozen algorithms.** The reasoning-fingerprint algorithm
   (`fingerprintAssistantTurn`) and the tool-name wire-aliasing algorithm
   (`toWireName`) key persisted cache entries that survive extension
   upgrades. Changing either orphans every user's cache (guaranteed misses
   + cache-breakdown popups — issue #19's failure mode). Both are pinned by
   frozen-literal unit tests; a change must be a versioned, deliberate
   decision.
4. **SSE parsing stays bug-compatible, not spec-compliant.** `\n`-only line
   splitting, the exact `data: ` prefix, exact `[DONE]` matching,
   only-JSON.parse-errors-are-malformed. A "spec-correct" SSE parser is a
   silent protocol change. Pinned by `test/unit_sse.mjs`.
5. **Zero runtime dependencies.** The package ships ~130 KB with no
   supply-chain surface. Don't add a runtime dep to save twenty lines.
6. **No telemetry, no third-party routing.** The only network peer is
   `api.deepseek.com`. Images are never proxied through another model; the
   README's privacy section is a commitment, not a description.

## House pattern: pure modules + thin vscode adapters

Logic that can be vscode-free lives in leaf modules (`sse.ts`,
`request_body.ts`, `image_content.ts`, `tool_payload.ts`, `tool_names.ts`,
`model_catalog.ts`, `api_client.ts`, …) and is unit-tested from the
compiled output (`test/unit_*.mjs` import `../out/*.js` in plain Node — no
vscode mock). provider.ts keeps the host-coupled seams: progress emission,
dialogs, config reads, the stream reader loop, the `finally`-path reasoning
persist. When you add logic, put the decision in a pure module and the
side effect in the adapter, and never import a vscode-tainted module (like
`utils.ts`) from a pure one — it breaks the test import chain.

## Verification matrix

Run all of it before pushing; CI runs the same set:

```bash
npm run compile        # tsc
npm run lint           # eslint
npm test               # all unit suites (compiled output)
npx prettier --check . # formatting is CI-enforced; prettier is pinned
npx @vscode/vsce package -o /tmp/x.vsix   # packaging sanity
```

Integration tests hit the live API and need a funded key — they are NOT in
CI and are the final word on protocol questions:

```bash
DEEPSEEK_API_KEY=sk-... node test/integration_tools_present.mjs  # reasoning round-trip rules (reports how strict the server is today)
DEEPSEEK_API_KEY=sk-... node test/integration_vision.mjs         # multimodal wire shape
DEEPSEEK_API_KEY=sk-... node test/integration_vision_multiturn.mjs # vision + tools + reasoning over three turns; records image prompt-cache hits
```

Manual pass in the Extension Development Host (F5) before a release:
picker shows all variants, a thinking turn streams, an agent turn
tool-calls across two rounds, a Vision variant sees an attached image.

## Release & revert notes

- Releases: bump `package.json` version + move the CHANGELOG `[Unreleased]`
  entries under the new version, commit as `release: x.y.z - <summary>`,
  tag `vx.y.z`, push the tag — `release.yml` verifies tag == package.json
  and publishes to the Marketplace and OpenVSX.
- The repo-wide prettier reformat commit is listed in
  `.git-blame-ignore-revs`; keep that file updated if another mass-format
  ever happens (locally:
  `git config blame.ignoreRevsFile .git-blame-ignore-revs`).
- Structural commits that touch the same files (e.g. an extraction followed
  by a change to the extracted module) revert as a suffix — revert the
  newest first — not as independent cherry-picks.
- Docs discipline: every user-facing change lands with its CHANGELOG entry
  in the same commit; ARCHITECTURE.md and README/README.zh-CN sync when
  behavior or user surface changes (the PR template has a checkbox).
