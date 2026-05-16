# Technical Decisions

> Part of [Cave Man Claude Memory (CMCM)](CAVEMAN_CM.md) — append-only log of non-obvious technical decisions.

## 2026-05-11 — Cave man knowledge system over embedding-based RAG

Chose markdown files + git over vector DB / embedding pipeline (claude-os approach).
Why: Zero infrastructure overhead. Project knowledge (decisions, patterns, handoff) is small enough to fit in LLM context window. Git provides versioning and diffing for free. No Python server, no Redis, no embedding costs. Portable — copy files to any project and it works.

## 2026-05-16 — New `criticalError` helper for crash logging, not reuse of `error`

Chose adding `criticalError(tag, ...args)` to `logger.ts` over reusing existing `error()` for crash/signal handlers in `src/index.ts` (M1).
Why: `error()` has a mutually-exclusive contract — writes to `error.log` when initialized, falls back to stderr only when not. Tool-level errors want this (avoid polluting MCP stdio with stderr garbage when a file sink exists). Crash handlers need the opposite — stderr is the resilient channel always visible to the MCP client and shell; `error.log` is additive persistence when available. Two different contracts, two functions. Considered overloading `error()` with a boolean flag — rejected as a boolean parameter smell (Clean Code: booleans-as-parameters usually mean the function does two things).

## 2026-05-16 — Inline `prepublishOnly` chain over `verify` script indirection (P10-M4)

Chose inline `"prepublishOnly": "npm run typecheck && npm run lint && npm test && npm run build"` over extracting a `verify` script that `prepublishOnly` would call.
Why: single consumer. `prepublishOnly` only fires on `npm publish`. Adding a `verify` indirection is YAGNI when no other caller exists — the CLAUDE.md "run all three after every change" rule is enforced by the developer/agent invoking the commands separately, not via a script alias. One layer is clearer than two.

## 2026-05-16 — Keep "Hardening" as non-standard CHANGELOG subsection (P10-M4)

Chose subsections `Added / Changed / Fixed / Security / Hardening` over the strict Keep-a-Changelog set (which lacks `Hardening`).
Why: Phase 10 hardening (crash handlers, signal handlers, stale-fallback guards) is distinct from vulnerability remediation. Folding it into `Security` muddies what `Security` means (CVE-class fixes vs. defensive plumbing). Separate subsection makes the V1 release notes scan cleaner. Considered renaming to `Robustness` or folding into `Changed` — rejected because `Changed` implies behaviour deltas users would notice, while hardening is invisible until a crash happens.

## 2026-05-16 — Release-metadata test file named after its scope, not a non-existent module (P10-M4)

Chose `src/releaseMetadata.test.ts` over `src/releaseArtifacts.test.ts`.
Why: existing convention is `foo.test.ts` tests `foo.ts`. There is no `releaseArtifacts.ts` source module — the test asserts on repo-root metadata files (package.json, LICENSE, README, CHANGELOG, lockfile). Naming the test for its scope avoids implying a phantom module. Considered placing the test at repo root — rejected because vitest config and existing test runner expect `src/**/*.test.ts`.
