# Technical Decisions

> Part of [Cave Man Claude Memory (CMCM)](CAVEMAN_CM.md) — append-only log of non-obvious technical decisions.

## 2026-05-26 — Recursive csproj directory scan over solution-file driven discovery (P7-11)

Chose recursive walk of `sourceRoot` (or whole repo if unset) looking for `{name}/{name}.csproj`, over parsing `.sln`/`.slnx` to enumerate projects.
Why: simpler, no `.sln` dependency. Reuses existing `TEST_PROJECT_SUFFIXES` + `IGNORED_DIRS` filters. Sln-driven approach adds parser branches (sln text vs slnx XML, multi-sln ambiguity) without solving the case where a csproj exists in the repo but isn't enrolled in any `.sln`. Considered sln-driven for "matches MSBuild semantics" — rejected because mcp-digger exposes published NuGet content, not build targets.

## 2026-05-26 — Transitive `<ProjectReference>` expansion in explicit mode without opt-in flag (P7-11)

Chose to run `expandProjectReferences` in explicit mode by default, mirroring wildcard mode, over adding an `expandTransitive: true` config flag.
Why: sibling-only filter (target's csproj must exist in the same repo's recursive scan) makes false positives unlikely — references to externally-published NuGet packages never resolve to a candidate. Keeps behaviour consistent across `explicit` / `auto` / `wildcard` modes. Considered opt-in flag for "explicit list stays authoritative" — rejected because the user's reported bug IS that the explicit list isn't authoritative when transitive deps are needed for source browsing; a flag would just relocate the surprise.

## 2026-05-22 — Validate .NET C# repos via tracked `.csproj` presence, not extra file types

Chose `.csproj` (case-insensitive, non-empty stem) as the sole validity signal for repo classification, over also requiring `.cs` files or accepting `.vbproj`/`.fsproj`.
Why: `.csproj` is the unambiguous C# project marker. `.cs`-only repos (empty templates) are still .NET C# repos. `.vbproj`/`.fsproj` are .NET but not C# — mcp-digger's source extractor only handles C# syntax. Counting only `.csproj` matches what the rest of the codebase already assumes (signature stripping, index extraction, sourceExtractor all parse C#). Considered detecting submodule-only `.csproj` for a friendlier error — rejected as MVP scope creep, since mcp-digger doesn't read submodule content for any other tool either.

## 2026-05-22 — Validate in `ensureReady` only, share via `result.error`; `dig_status` validates on-disk trees directly

Chose to run validation inside `ensureReady()` and set `result.error`, while `dig_status` runs the same validator directly on already-on-disk trees (never calling `ensureReady`).
Why: `ensureReady` is the natural place — it's already the resolved-source-path boundary. Reusing the existing `result.error` channel (currently set by `buildWildcardEmptyError`) means every downstream tool surfaces validation errors through the same code paths without changes. For `dig_status`, calling `ensureReady` would trigger a clone during a health check — violates the established "health check must not clone" principle. Instead, `dig_status` validates only what already exists: `localPath` if `isValidRepo` passes, or `managedSourcePath` if cloned, else reports "not checked". Considered cloning during `dig_status` for completeness — rejected because the user's first instinct is to run `dig_status` for diagnostics, and a 30s clone on every health check is the wrong default.

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
