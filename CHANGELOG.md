# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
