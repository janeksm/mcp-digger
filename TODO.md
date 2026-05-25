# mcp-digger — Implementation Progress

> Use `/accept <step>` to finalize a step (commit + mark done).

| Step | Module | Status | Commit | Notes |
|------|--------|--------|--------|-------|
| 1 | `config.ts` | done | b9f5d02 | Config file parsing, env merging, validation, auth strategy |
| 2 | `gitClient.ts` | done | f45eb90 | Git CLI wrappers, hybrid auth (unauthenticated-first + PAT fallback) |
| 3 | `repoManager.ts` | done | 0a7ead6 | Mode A/B logic, ensureReady, discoverPackages for auto repos |
| 4 | `cacheManager.ts` | done | db8549f | Per-repo meta.json, freshness by commit hash, cache read/write |
| 5 | `sourceExtractor.ts` | done | 7680f91 | Overview markdown generation, .cs signature stripping |
| 6 | `tools/digOverview.ts` | done | 4601bf1 | Level 1 MCP tool — package overview |
| 7 | `tools/digSignatures.ts` | done | 10ad449 | Level 2 MCP tool — stripped public signatures |
| 8 | `tools/digFile.ts` | done | 7769990 | Level 3 MCP tool — full file source |
| 9 | `index.ts` | done | 0d86c0a | MCP server entry point, register all tools |
| 11 | `logger.ts` | done | ce6b566 | Debug logging service: file-based, config-driven, singleton |
| 12 | `config.ts` | done | f92833f | .env file loading: env > .env > config defaults, .env.sample template |
| 13 | `gitClient.ts`, `tools/digFile.ts` | done | eda3f53 | Security: PAT redaction in git errors + dig_file path traversal validation. Remaining findings tracked in Phase 2 below |
| 14 | `gitClient.ts` | done | 154e09d | Suppress GCM/credential prompts on auto strategy unauthenticated attempt |
| 15 | `tools/digStatus.ts`, `gitClient.ts` | done | a2ceae8 | dig_status MCP tool, lsRemote() connectivity check, improved auth debug logging, DESIGN.md |
| 16 | `config.ts`, `repoManager.ts`, `tools/digStatus.ts` | done | 5626ef3 | per-repo `auth` (strategy + PAT / PAT-EnvVarName), top-level `localRepos`, drop duplicated env vars, README rewrite with dig_status |
| 17 | `solutionScanner.ts`, `config.ts`, `repoManager.ts`, `tools/*` | done | af6809a | wildcard repo names (`MyCompany.*`), recursive workspace scan (.sln/.slnx/Directory.Packages.props/Directory.Build.props/Directory.Build.targets), per-repo error surfacing, fix packages:[] auto-discover bug |
| 10 | `index.ts` | done | d981129 | DRY version: read from package.json instead of hardcoding in McpServer constructor |

**Statuses:** `—` not started, `in-progress` active, `done` committed, `blocked` waiting on something

---

## Phase 2 — MCP Compliance & Security Hardening

> Review against MCP best practices and security findings.

| # | Task | Importance | Status | Rationale | Files |
|---|------|-----------|--------|-----------|-------|
| 1 | Add `zod` as direct dependency in package.json | Critical | done | Imported in digSignatures + digFile but only available as transitive dep of `@modelcontextprotocol/sdk`. Future SDK update could break builds. | `package.json` |
| 2 | Add complete `annotations` to all four tools | High | done | MCP requires `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Only `dig_status` has partial annotations; other three tools have none. Clients treat unannotated tools as potentially destructive. | `src/tools/digStatus.ts`, `src/tools/digOverview.ts`, `src/tools/digSignatures.ts`, `src/tools/digFile.ts` |
| 3 | Add `.describe()` to Zod input schema parameters | High | done | 615a47b | `src/tools/digSignatures.ts`, `src/tools/digFile.ts`, `src/tools/shared.ts` |
| 4 | Validate package names against safe charset (SEC #4) | High | done | aadb842 | `src/config.ts` |
| 5 | Restrict repo URL schemes to `https:`/`ssh:` (SEC #5) | High | done | 8517ee0 | `src/config.ts` |
| 6 | Cap dig_file + scope dig_overview to single repo + new dig_list tool (SEC #3) | High | done | 9dc7f95 | `src/tools/digFile.ts`, `src/tools/digOverview.ts`, `src/tools/digList.ts`, `src/tools/shared.ts`, `src/index.ts` |
| 7 | Return `isError: true` on error responses | High | done | 2b5a8bd | `src/tools/digFile.ts`, `src/tools/digSignatures.ts`, `src/tools/digOverview.ts`, `src/tools/shared.ts` |
| 8 | Atomic `meta.json` writes + per-repo mutex (SEC #6, #10) | High | done | 1747ebf | `src/cacheManager.ts`, `src/repoManager.ts`, `src/repoLock.ts`, `src/tools/digOverview.ts`, `src/tools/digSignatures.ts`, `src/tools/digFile.ts` |
| 9 | Prototype-pollution hardening on `JSON.parse` (SEC #7) | Medium | done | 130ff1e | `src/config.ts`, `src/cacheManager.ts`, `src/solutionScanner.ts` |
| 10 | Cap fan-out in `discoverPackages` (SEC #8) | Medium | done | 130ff1e | `src/config.ts` |
| 11 | Close SEC #9 — log-file size cap already exists | Done | done | Verified: `MAX_LOG_SIZE = 5 * 1024 * 1024` at `logger.ts:12`, truncation at lines 58-63. Verified in logger.ts. | `src/logger.ts` |
| 12 | Low/info items: defensive filePath in readFile, skip symlinks, confirm SDK Zod enforcement (SEC #11, #12, #13) | Low | done | 130ff1e | `src/gitClient.ts`, `src/config.ts` |
| 13 | Fix stale `dig_overview` references → `dig_list` in user-facing messages | Low | done | 69e51a1 | `src/tools/digStatus.ts`, `src/config.ts` |
| 14 | Replace wildcard repo names with `packageFilter` field | High | done | 1bc6246 | `src/config.ts`, `src/repoManager.ts`, `src/cacheManager.ts`, `src/tools/*`, `DESIGN.md` |
| 15 | Replace `dig_signatures` with `dig_lookup` tool | High | done | ec6760c | `src/tools/digSignatures.ts` → `src/tools/digLookup.ts`, `src/sourceExtractor.ts`, `src/cacheManager.ts`, `src/index.ts`, `DESIGN.md`, `README.md` |
| 16 | Restore `dig_signatures` alongside `dig_lookup` | High | done | cb8bb11 | `src/tools/digSignatures.ts`, `src/sourceExtractor.ts`, `src/cacheManager.ts`, `src/index.ts` |
| 17 | Add `keyword` + `exactMatch` params to `dig_signatures` | High | done | 85a04d4 | `src/tools/digSignatures.ts`, `src/tools/digSignatures.test.ts` |
| 18 | Split `dig_overview` into `dig_repo_overview`, `dig_package_overview`, `dig_package_files` | High | done | 2dd3837 | `src/tools/digRepoOverview.ts`, `src/tools/digPackageOverview.ts`, `src/tools/digPackageFiles.ts`, `src/sourceExtractor.ts`, `src/index.ts` |
| 19 | Add optional `branch` field to repo config | High | done | 9b6fb51 | `src/config.ts`, `src/gitClient.ts`, `src/repoManager.ts`, `src/tools/digStatus.ts` |
| 20 | Add cross-package search to `dig_lookup` | High | done | 81612b3 | `src/tools/digLookup.ts`, `src/tools/digLookup.test.ts`, `DESIGN.md` |
| 21 | Add `implements` + `references` modes to `dig_lookup` | High | done | 09d3e33 | `src/sourceExtractor.ts`, `src/tools/digLookup.ts`, `src/sourceExtractor.test.ts`, `src/tools/digLookup.test.ts`, `DESIGN.md` |

---

## Phase 3 — Signature Output Quality

> Postponed improvements to `dig_signatures` output quality and index coverage.

| # | Task | Notes | Files | Status | Commit |
|---|------|-------|-------|--------|--------|
| 1 | Enhanced type headings with generics + modifiers | `EntityBase (class)` → `EntityBase<TId> (abstract class)` — requires parsing generics from source | `src/tools/digSignatures.ts`, `src/sourceExtractor.ts` | done | 3b599e1 |
| 7 | Clean Code refactoring | Extract shared helpers (error, package lookup, cache lifecycle, repo-ready wrapper), unify cross-package search, consistent error handling | `src/tools/*.ts`, `src/cacheManager.ts`, `CLAUDE.md` | done | 9cea1ff |
| 8 | Signature stripping batch | Strip `public` keyword, boilerplate methods, XML doc comments, private members; expand NOT_METHOD exclusion | `src/sourceExtractor.ts` | done | 92caf9e |
| 9 | Signature output cleanup | Strip namespace/using statements, CompareTo boilerplate, remove generated file headers, drop unused commitHash params | `src/sourceExtractor.ts`, `src/tools/digSignatures.ts`, `src/tools/digPackageOverview.ts` | done | d92068d |

---

## Phase 4 — Token Efficiency & Agent Discovery Speed

> Optimise tool outputs for AI agent consumption. Goal: reduce token waste, eliminate redundant tool calls, and front-load the most useful information so the agent can stop reading early. Based on end-to-end testing of all 8 tools with real data (a NuGet monorepo, 7 packages, ~90 files in SharedKernel).
>
> **Design principle:** Don't split or merge tools — the 8-tool progressive escalation (L1→L2→L3) is the right shape. Instead, make each tool's output denser and more front-loaded. The agent should get what it needs in fewer calls with less noise.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Enrich `dig_list` with one-line package summaries from `.csproj` metadata | P1 | done | e8ed8f0 | Currently `dig_list` returns bare package names, forcing the agent to call `dig_repo_overview` (~900 tokens) just to learn what each package does. The `.csproj` summaries (PackageDescription + PackageTags) are already extracted by `extractPackageSummary()` in `sourceExtractor.ts` — they just aren't surfaced in `dig_list`. Adding them lets the agent go `dig_list` → `dig_lookup` directly, skipping `dig_repo_overview` entirely in most sessions. **Saves ~900 tokens and 1 tool call per session.** | `src/tools/digList.ts`, `src/tools/digList.test.ts` |
| 2 | Smart-filter README sections in `dig_repo_overview` | P2 | done | aee42d3 | Two-layer filter: heading blocklist (install, CI/CD, license, badges, etc.) + content-shape check (>50% noise lines → drop). Keep-by-default, preamble always preserved. | `src/readmeFilter.ts`, `src/readmeFilter.test.ts`, `src/tools/digRepoOverview.ts`, `src/tools/digRepoOverview.test.ts` |
| 6 | Add diagnostic message when wildcard resolves 0 packages | P2 | done | 6f5c29c | When `packageFilter` wildcard mode finds on-disk candidates but no workspace `.sln`/`.slnx` files to cross-reference, `referenced=0` → `matched=0` → "No packages resolved" with zero explanation. Discovered during Inspector testing: the mcp-digger repo itself has no `.sln`, so wildcard always fails. The agent (or user) gets no hint about why. **Fix: when wildcard matches 0 packages AND referenced=0, set a warning on the repo explaining the cause (e.g. "No .sln files found in workspace to cross-reference against packageFilter 'MyCompany.*'. Use explicit `packages` list, or omit `packageFilter` for auto-discovery."). Surface in `dig_list` and `dig_status` output.** | `src/repoManager.ts`, `src/tools/digList.ts`, `src/tools/digStatus.ts` |
| 7 | Wildcard: resolve transitive project references | P1 | done | 60bc6bd | BFS-walk `<ProjectReference>` links in matched packages' `.csproj` files to expand wildcard match set transitively. Handles cycles, prefix filtering, non-candidate exclusion. | `src/repoManager.ts`, `src/repoManager.test.ts` |
| 3 | Add directory summary header to `dig_package_files` | P3 | done | a2209ea | Directory summary header at top of file listing (`Attributes/ (2) · Services/ (1) · 1 root file`). Omitted when all files at root. | `src/tools/digPackageFiles.ts`, `src/tools/digPackageFiles.test.ts` |
| 4 | Add file count to `dig_package_overview` output | P5 | done | 681fcb1 | Knowing "90 source files" vs "3 source files" helps the agent decide its next step — whether to call `dig_package_files` (small package) or go straight to `dig_lookup` (large package). Currently there's no size hint. **Add one line like `*90 source files — use dig_lookup to find specific types.*` at the end of the overview.** This may eliminate a `dig_package_files` call entirely for large packages where `dig_lookup` is the better strategy. Pure additive change, no info loss. | `src/tools/digPackageOverview.ts`, `src/sourceExtractor.ts` |
| 5 | Remove duplicate package listing from `dig_repo_overview` bottom | P6 | done | 0fc5726 | `dig_repo_overview` currently renders the package list twice: once in the README content (rich descriptions, dependency tree) and again as a generated `## Packages` section at the bottom with `.csproj` summaries and tags. **Depends on P4-1:** once `dig_list` includes summaries, this bottom section is fully redundant — the agent already has the same data from its earlier `dig_list` call. Remove the generated section, keep the README content. **Saves ~100 tokens per call. Only safe after P4-1 is implemented.** | `src/tools/digRepoOverview.ts`, `src/tools/digRepoOverview.test.ts` |

---

## Phase 5 — Operational Tools & Error Recovery

> New tools for cache management and improved error messages that guide the agent toward self-recovery.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | `dig_refresh` tool — force-invalidate cache for one or all repos | P1 | done | 0e22b82 | | When `dig_lookup`/`dig_signatures` return "no matches", the agent has no way to force a cache refresh. Auto-refresh only invalidates when commit hash changes — can't recover from corrupt indexes or pick up new extraction logic after server upgrade. New tool: optional `repoName` param, fetches latest (managed) / re-reads HEAD (local), unconditionally invalidates all cache. Custom annotations (`readOnlyHint: false`). | `src/tools/digRefresh.ts`, `src/tools/digRefresh.test.ts`, `src/cacheManager.ts`, `src/index.ts`, `DESIGN.md`, `CLAUDE.md` |
| 2 | Add `dig_refresh` hints to "no matches" error messages | P2 | done | 0e22b82 | | Append ", or call dig_refresh to force a re-index" to all zero-result messages in `dig_lookup` (6 locations) and `dig_signatures` (1 location). Positioned last after existing suggestions. Depends on P5-1. | `src/tools/digLookup.ts`, `src/tools/digSignatures.ts` |

---

## Phase 6 — Parsing Correctness & Consistency

> Fixes found during full tool review (2026-05-09). Focus: index extraction accuracy and error signaling consistency.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Use lexer-aware brace counting in `scanFileForIndex` | P1 | done | 9ff6e18 | `scanFileForIndex` uses naive `countChar("{")` / `countChar("}")` which counts braces inside string literals, interpolated strings, char literals, and inline comments. This corrupts the depth/type stack — methods get attributed to wrong parent types, or phantom types get indexed. Modern C# uses string interpolation (`$"Hello {name}"`) and JSON templates heavily, so this hits real code. **Fix:** replace `countChar` calls with `analyzeLine` (already exists in the same file for `stripCsBody`) or a simplified variant that returns open/close counts while skipping strings, chars, and comments. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 2 | Track block comment state in `scanFileForIndex` | P1 | done | 9ff6e18 | The line-skip check (`trimmed.startsWith("//") \|\| trimmed.startsWith("/*") \|\| trimmed.startsWith("*")`) doesn't track multi-line block comment state. A block comment starting mid-line or spanning multiple lines without `*` prefixes will have its content parsed as real code — type/method declarations inside comments get indexed. **Fix:** add `inBlockComment` state variable (same pattern as `stripCsBody`), carry it across lines via `analyzeLine`'s `endsInComment` return. Likely solved together with P6-1 since both require switching to `analyzeLine`. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 3 | Return `isError: true` from `dig_list` on total failure | P2 | done | f8bc965 | `dig_list` catches `ensureAllReady` errors and appends a footer warning, but never sets `isError: true`. All other data tools signal errors properly. When ALL repos fail, the agent sees a success response and may not escalate to `dig_status`. **Fix:** track whether any repo resolved successfully; if none did and there was an error, return `toolError()` instead of `toolSuccess()`. Requires switching `digList` to use `toCallToolResult`. | `src/tools/digList.ts`, `src/tools/digList.test.ts` |
| 4 | Document stale fallback design in DESIGN.md | P3 | done | e8550b6 | Stale cache fallback is intentionally asymmetric across tools: `dig_lookup` symbol/implements and `dig_signatures` fall back to stale index; `dig_package_overview` falls back to stale overview; `dig_lookup` references has no fallback (reads source directly, no cached artifact); `dig_repo_overview`/`dig_package_files` have no fallback (lightweight, no cached artifact). This looks like an oversight without documentation. **Fix:** add a "Stale Fallback" subsection under Shared Conventions in DESIGN.md explaining the pattern and which tools have it. | `DESIGN.md` |

---

## Phase 7 — Bug Fixes & Hardening

> Issues found during full-repo code review (2026-05-10). Four review agents audited: core modules, tool modules, C# parser (sourceExtractor + readmeFilter), and test coverage.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Handle C# verbatim strings (`@"..."`) in `analyzeLine()` | P1 | done | 20be538 | `analyzeLine()` treats `\` as an escape inside all strings, but in C# verbatim strings (`@"..."`), `\` is literal and `""` is the quote-escape. **Two failures:** (a) `@"path\"` makes the parser skip the closing `"`, leaving it stuck in `inStr` — subsequent braces on the line or next lines are ignored. (b) Multi-line verbatim strings: `inStr` state is NOT propagated across lines (only `inBlockComment` is), so lines 2+ of a multi-line verbatim string are parsed as code — braces inside (common in embedded JSON/SQL/XML) corrupt the depth tracker. Both `stripCsBody` (line 361) and `scanFileForIndex` (line 533) call `analyzeLine`, so this affects **signature stripping and symbol indexing**. **Fix:** detect `@"` prefix → enter a `inVerbatim` state where `\` is literal and `""` is the escaped quote. Propagate string state across lines (add `endsInString` / `endsInVerbatim` to `LineAnalysis` return, similar to `endsInComment`). | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 2 | Handle C# 11 raw string literals (`"""..."""`) in `analyzeLine()` | P1 | done | a02e3f6 | C# 11 raw string literals use 3+ `"` to open and the same count to close. They can span multiple lines and contain arbitrary content including braces. The parser doesn't recognise them — the opening `"""` is parsed as: enter string, exit string, enter string. Any braces inside the raw literal are counted as structural braces. **Fix:** when 3+ consecutive `"` are seen outside a string, enter `inRawString` state and track the opening quote count. Exit only when the same number of consecutive `"` appear. Add `endsInRawString` + `rawQuoteCount` to `LineAnalysis`. Likely solved together with P7-1 since both extend the same state machine. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 3 | Fix cross-package reference file limit not enforced within a single repo | P2 | done | 99fb0fa | In `digLookupReferencesAllPackages`, `totalFiles` is read inside `withRepoLock` (line 539) but only updated after the lock releases (line 551). Within one repo's callback, every package sees the same stale `remaining` value. A repo with N packages could return up to `N × MAX_REFERENCE_FILES` results instead of being capped at `MAX_REFERENCE_FILES`. **Fix:** track a local `localTotal` inside the `withRepoLock` callback and decrement `remaining` between packages: `const remaining = MAX_REFERENCE_FILES - totalFiles - localTotal;`. | `src/tools/digLookup.ts`, `src/tools/digLookup.test.ts` |
| 4 | Fix comment-stripping regex not multiline-aware in base type parsing | P2 | done | 498c9c0 | At line 567: `fullDecl.replace(/\/\*.*?\*\//g, "")` — `fullDecl` can contain newlines (joined from forward-looking loop at line 556), but the regex `.` doesn't match newlines without the `s` flag. A block comment spanning the join boundary won't be stripped, leaving `*/` in the text and corrupting `parseBaseTypes` output. **Fix:** add the `s` flag → `/\/\*.*?\*\//gs`. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 5 | Fix `pendingType` not cleared when exiting block comments | P3 | done | 12844b4 | At line 585: `if (!wasInBlockComment) pendingType = null;` — if a type is set as `pendingType` and then a block comment follows, `pendingType` persists through the entire comment. Methods appearing after the comment ends get attributed to the stale `pendingType` instead of the actual enclosing type. **Fix:** clear `pendingType` unconditionally in the else-branch, or clear it when `wasInBlockComment && !analysis.endsInComment` (exiting a block comment). | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 6 | Add floor check to `parseBaseTypes` angle bracket depth | P3 | done | 6a343fb | At line 620: `else if (ch === ">") angleDepth--;` has no floor check. Malformed or partially-parsed input with an extra `>` sends `angleDepth` negative, so the `:` search condition (`angleDepth === 0`) can never match again — silently dropping all base types for that declaration. **Fix:** `else if (ch === ">" && angleDepth > 0) angleDepth--;`. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
| 7 | Add test coverage for `dig_refresh` tool | P3 | done | 089f7b1 | `digRefresh.ts` handles fetch, hash comparison, and cache clearing across repos. Tests shipped with P5-1: 8 tests covering happy path (single + all repos), error path, hash change detection, unknown repo, cache cleared, idempotent. | `src/tools/digRefresh.test.ts` |
| 8 | Add test coverage for `searchReferences` / `countReferences` | P4 | done | b1ebd35 | These are exported public APIs in `sourceExtractor.ts` used by `dig_lookup` references mode. Currently only tested indirectly through tool-level tests. **Add unit tests for:** basic keyword match with word boundaries, case sensitivity, files with zero/multiple occurrences, binary/non-text file handling, and the `maxFiles` cap parameter. | `src/sourceExtractor.test.ts` |
| 9 | Remove dead `safeRepoSlug` cleanup code | P5 | done | 47a631a | `cacheManager.ts:187-189`: `safeRepoSlug()` strips trailing `*` and `.` characters, but config validation already rejects repo names with these characters (`config.ts` lines 445-449). The cleanup is dead code that gives a false sense of safety — if validation were ever bypassed, two different repo names could silently collide in the cache. **Fix:** remove the regex replacements and add an assertion instead: `if (/[*.]$/.test(repoName)) throw new Error(...)`. | `src/cacheManager.ts`, `src/cacheManager.test.ts` |
| 10 | Document `.env` inline comment stripping limitation | P5 | done | 3cbb44e | `config.ts:212-220`: the `.env` parser strips ` #` (space-hash) as inline comments, which truncates values containing ` #` such as URLs with fragment identifiers (`https://example.com/#section`). Not a code bug (this is standard `.env` behaviour), but undocumented. **Fix:** add a note to `.env.sample` or README that values containing ` #` should be quoted. | `.env.sample` or `README.md` |

---

## Phase 8 — Agent Guidance & Output Quality

> Improvements inspired by [claude-os](https://github.com/brobertsaz/claude-os) patterns: confidence scoring, contextual routing hints, token-efficient output, and dependency-graph importance ranking. Goal: reduce tool calls per session, help the agent stop reading early, and surface the most relevant results first.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Add comparative cost hints to tool descriptions | P1 | done | 1b981a8 | Tool descriptions don't tell the agent *which tool is cheaper*. The agent must reason about escalation cost from scratch every time. **Fix:** append relative cost/size hints to each tool's description string — e.g. `dig_signatures`: "Cheaper than dig_file — use when you need API shape, not implementation detail." `dig_lookup`: "Fastest search — index-based, no source reading. Use before dig_signatures." `dig_file`: "Most expensive — full source. Use only when implementation detail is needed." This eliminates a decision step for the agent on every tool selection. **Ref:** claude-os writes tool descriptions verb-first with explicit output structure and cost comparisons for AI discoverability (see repo README tool registry patterns). | `src/tools/digLookup.ts`, `src/tools/digSignatures.ts`, `src/tools/digFile.ts`, `src/tools/digPackageOverview.ts`, `src/tools/digPackageFiles.ts`, `src/tools/digRepoOverview.ts`, `DESIGN.md` |
| 2 | Add contextual next-step hints to successful tool results | P1 | done | 6729030 | Tools currently embed routing hints only on *errors* (e.g. "try dig_refresh"). Successful results give no guidance — the agent must reason about what to do next from tool descriptions alone. **Fix:** append 1-line contextual hints based on result shape: `dig_lookup` finds an interface → "Found interface — use `dig_lookup(keyword, mode: "implements")` to find implementations"; `dig_lookup` returns 1 result → "Single match — use `dig_signatures` for API surface or `dig_file` for implementation"; `dig_lookup` returns 50+ → "Many matches — narrow with `exactMatch: true` or specify `packageName`"; `dig_signatures` returns a type → "Use `dig_file` for full implementation." Each hint is conditional, not boilerplate. **Ref:** claude-os tools embed routing hints in output based on what was found, enabling tool chaining without agent reasoning overhead. | `src/tools/digLookup.ts`, `src/tools/digSignatures.ts`, `src/tools/digPackageOverview.ts`, `src/tools/digPackageFiles.ts` |
| 3 | Add structured summary block atop `dig_signatures` output | P2 | done | 69ac5c8 | `dig_signatures` returns raw stripped C# — valid but not optimized for LLM consumption. The agent must parse the entire fenced code block to answer "what methods does this type have?" **Fix:** prepend a compact summary block before each type's code block: `Type: OrderService (sealed class) · Implements: IOrderService, IDisposable · Methods: 4 public, 2 protected · Key: GetOrderAsync(int) → Task<Order>, CreateOrderAsync(Order) → Task<int>`. The agent can answer many questions from the ~50-token summary without reading the full ~500-token stripped source. Pure additive — existing code block output unchanged. **Ref:** claude-os converts structured metadata to "RAG-friendly" readable text form before indexing (see `agent_os_parser.py` — YAML→readable text for semantic clarity). | `src/tools/digSignatures.ts`, `src/sourceExtractor.ts` |
| 4 | Add result ranking to `dig_lookup` and `dig_signatures` | P2 | done | 9e07ce2 | Results are returned in file-system order — exact name matches, substring matches, and weak partial matches are interleaved. The agent must scan the full list to find the best hit. **Fix:** score each result: exact name match (case-insensitive) = 1.0, exact substring at word boundary = 0.8, substring anywhere = 0.6. Sort descending. In cross-package mode, group by repo but sort within each group. For `dig_signatures`, apply same ranking to select which files to strip first. Visual indicator optional (results are implicitly ranked by position). **Ref:** claude-os uses graduated confidence scoring (0.9+ explicit, 0.7-0.8 inferred, <0.7 discard) for all search results, enabling the agent to trust the top result and stop reading early. | `src/tools/digLookup.ts`, `src/tools/digSignatures.ts`, `src/sourceExtractor.ts` |
| 5 | Add index completeness stats to `dig_status` | P3 | done | 4688adf | `dig_status` reports connectivity and config but not index health. The agent (and user) can't tell if results are complete or if files were skipped. **Fix:** per-repo section adds: `Indexed: 87/90 files (3 skipped: generated) · Symbols: 342 types, 1,204 methods · Cache age: 2h14m · Commit: abc1234`. Requires reading `meta.json` + `index.dat` stats. Helps the agent trust results ("index is complete") or escalate ("index is stale/incomplete"). **Ref:** claude-os reports health metrics: embedding coverage %, document age, similar pairs, actionable recommendations — all surfaced in the health check endpoint. | `src/tools/digStatus.ts`, `src/cacheManager.ts` |
| 6 | Add dependency-graph importance scoring to symbol index | P4 | done | 0f4cfd7 | All indexed symbols are treated as equally important. A base class used by 40 types ranks the same as a helper used by 1. **Fix:** during `scanFileForIndex`, track incoming references per type (count how many other indexed types extend/implement/reference it). Store as an additional field in `index.dat`. Use the count as a tiebreaker in P8-4 ranking — "hub types" float to the top. Enables future features: `dig_lookup` with `sort: "importance"`, `dig_package_overview` highlighting the most-connected types. **Ref:** claude-os uses NetworkX PageRank on dependency graphs to identify important symbols, then prioritizes these for indexing and semantic embedding (Phase 1 structural → Phase 2 selective, 80% cost reduction by embedding only top 20% of files by importance). | `src/sourceExtractor.ts`, `src/cacheManager.ts`, `src/tools/digLookup.ts` |

---

## Phase 9 — Startup UX & Bootstrapping

> Graceful behavior when no config exists. Server stays alive, offers setup tools.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Graceful unconfigured mode + `dig_init` bootstrapping tool | P1 | done | a29f7b9 | Server crashes with exit 1 when no `.digger/config.json` exists, making MCP unavailable. Logger creates `.digger/` as side effect. **Fix:** `loadConfig()` returns null on ENOENT, server starts in unconfigured mode with only `dig_status` + `dig_init` registered. No directories created. `dig_init` creates starter config with atomic write. | `src/config.ts`, `src/index.ts`, `src/logger.ts`, `src/tools/digStatus.ts`, `src/tools/digInit.ts`, `src/tools/digInit.test.ts` |

---

## Phase 10 — V1 Release Hardening

> Findings from senior-dev code review (2026-05-15). Four parallel review agents audited: core infrastructure, C# parser, tool modules, and release readiness. Original 14 items merged into 5 batched tasks (2026-05-16) to reduce typecheck/lint/test cycles and commit churn.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| M1 | Server lifecycle hardening (was P10-1 + P10-3) | P1 | done | 022bfa6 | Crash protection: `process.on("uncaughtException")` / `process.on("unhandledRejection")` log to stderr + error.log; wrap top-level `await server.connect(transport)` in try-catch. Graceful shutdown: SIGINT/SIGTERM handlers call `server.close()` then `process.exit(0)`. Without these, unhandled rejections kill the process silently (MCP client sees nothing) and signal kills interrupt pending git/file ops mid-write. | `src/index.ts` |
| M2 | C# parser raw-string completion (was P10-7 + P10-8) | P1 | done | 44d9311 | `sourceExtractor.ts:657` — `analyzeLine(next, fwdInBC, fwdInVerbatim)` omits `startsInRawString` / `rawQuoteCount`, so base-type parsing breaks when declarations span into raw string continuation. `parseBaseTypes` at line 673 only strips block comments, not raw string content — braces inside `"""..."""` corrupt parsing. **Fix:** propagate `fwdInRawString` + `fwdRawQuoteCount` through forward scan; strip raw strings before passing to `parseBaseTypes`. Same state machine, one file. | `src/sourceExtractor.ts` |
| M3 | Stale-fallback + defensive guards (was P10-2 + P10-6 + P10-11 + P10-14) | P2 | done | 7673c75 | Four cross-cutting defensive fixes batched as one commit: (a) wrap `parseIndex()` calls inside stale-fallback catch blocks in their own try-catch — corrupted `index.dat` currently throws past the tool boundary, violating tools-never-throw. (b) `gitClient.ts:48-50` reads `e.status` which doesn't exist on `ExecFileException` — change to `typeof e.code === "number" ? e.code : null`. (c) `cacheManager.ts:90` `Promise.all` on `fs.rm()` aborts remaining deletes on first failure — switch to `Promise.allSettled`. (d) `config.ts:365` iterates `repos` without `Array.isArray` guard. | `src/tools/digLookup.ts`, `src/tools/digSignatures.ts`, `src/gitClient.ts`, `src/cacheManager.ts`, `src/config.ts` |
| M4 | V1 release prep (was P10-4 + P10-5 + P10-9 + P10-12 + P10-13) | P2 | done | f218281 | Non-code release artifacts batched: `prepublishOnly` script (`typecheck && lint && test && build`) to block stale `dist/` shipping; bump `0.7.0 → 1.0.0` in package.json + LICENSE; `npm audit fix` for 5 transitive vulns (1 high `fast-uri` via MCP SDK → ajv); update README tool count `8 → 10` to include `dig_init` + `dig_refresh`; create `CHANGELOG.md` with v1 release notes. | `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md`, `package-lock.json`, `.gitignore`, `src/releaseMetadata.test.ts` |
| M5 | Test coverage for entry point + shared helpers (was P10-10) | P4 | done | 4058ad8 | Extracted registration logic from `src/index.ts` into `src/bootstrap.ts` for testability. New tests: `src/bootstrap.test.ts` (6 tests — configured vs unconfigured registration, warnings, tool count) and `src/tools/shared.test.ts` (18 tests — toolSuccess/Error, toCallToolResult, extractErrorMessage, requirePackage, withRepoReady, constants). | `src/bootstrap.ts`, `src/bootstrap.test.ts`, `src/tools/shared.test.ts`, `src/index.ts` |

---

## Phase 11 — Java / JVM Package Support

> Extend mcp-digger to expose Maven/Gradle package source the same way it exposes .NET NuGet packages. Single binary, plugin-based language dispatch — `gitClient`, `cacheManager`, `repoLock`, `logger`, `bootstrap`, MCP tool surface stay shared. Java parser + discovery scanner are the only language-specific pieces.
>
> **Design principle:** Keep tool API identical across languages. The MCP client never branches on language — `dig_lookup`, `dig_signatures`, `dig_file` work the same for a Maven artifact as for a NuGet package. Language is a per-repo config field, resolved at discovery time.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Design `LanguagePlugin` interface | P1 | — | | Define the minimal interface every language must implement: `validateRepo(rootPath) → ValidationResult`, `discoverPackages(rootPath, filter?) → PackageInfo[]`, `extractPackageOverview(pkgPath) → string`, `scanFileForIndex(filePath, content) → SymbolEntry[]`, `stripSignatures(filePath, content) → string`, `extractPackageSummary(manifestPath) → string`. Sketch on paper first — leaky interface (Java-specific fields bleeding through) is the main failure mode. Validate by listing every place `sourceExtractor.ts` / `repoValidation.ts` / `solutionScanner.ts` is called and confirming each touch-point is covered. | `src/languagePlugin.ts` (new), `src/sourceExtractor.ts`, `src/repoValidation.ts`, `src/solutionScanner.ts` |
| 2 | Extract C# implementation behind the plugin interface | P1 | — | | Move existing `sourceExtractor.ts`, `solutionScanner.ts`, `repoValidation.ts` logic into `src/plugins/csharp/*.ts` implementing `LanguagePlugin`. Pure refactor — no behaviour changes, no new features. All 694 existing tests must pass unchanged. Adds `language: "csharp"` default to config schema (back-compat: omitted → csharp). | `src/plugins/csharp/*.ts` (new), `src/config.ts`, `src/repoManager.ts`, `src/tools/*` |
| 3 | Add `language` field to repo config + dispatch | P1 | — | | Accept `language: "csharp" \| "java"` per-repo in `.digger/config.json`. Validation: known values only. Dispatch in `repoManager.ensureReady` and all tool entry points selects the matching plugin. Default to `"csharp"` if omitted (back-compat — existing configs untouched). | `src/config.ts`, `src/repoManager.ts`, `src/bootstrap.ts` |
| 4 | Java discovery scanner — Maven | P1 | — | | Walk `pom.xml` files: parent POM `<modules>` element drives multi-module discovery. Each `<artifactId>` = one package. Use lightweight XML parser (no full Maven model — just tag scrape). Skip `target/`, `.git`, `.idea`, `node_modules`. Equivalent of `solutionScanner.ts` for Maven. `packageFilter` matches against `artifactId` (or `groupId:artifactId` — TBD). | `src/plugins/java/mavenScanner.ts` (new), `src/plugins/java/mavenScanner.test.ts` |
| 5 | Java discovery scanner — Gradle | P2 | — | | Parse `settings.gradle` / `settings.gradle.kts` `include` directives for multi-project layouts. Each included sub-project is one package. Trickier than Maven — Groovy/Kotlin DSL, both flat and hierarchical paths. Start with regex-based `include 'foo'` / `include(":foo")` extraction; full AST parsing only if real fixtures fail. | `src/plugins/java/gradleScanner.ts` (new), `src/plugins/java/gradleScanner.test.ts` |
| 6 | Java repo validation gate | P1 | — | | Mirror `repoValidation.ts` — accept repos containing `pom.xml` OR `build.gradle` / `build.gradle.kts`. Reject if neither found (parallel to current `.csproj` rule). Used by `ensureReady` and `dig_status`. | `src/plugins/java/repoValidation.ts` (new), tests |
| 7 | Java parser — lexer state machine | P1 | — | | Java equivalent of `analyzeLine` in `sourceExtractor.ts`. Must handle: regular strings (`"..."` with `\` escapes), char literals (`'x'`), text blocks (`"""..."""`, Java 15+, multi-line — analogous to C# raw strings), line comments (`//`), block comments (`/* */`), JavaDoc (`/** */`, treat same as block comment for brace counting). Propagate `endsInString` / `endsInTextBlock` / `endsInComment` across lines. Re-test all the edge cases from Phase 6 (P6-1, P6-2) and Phase 7 (P7-1, P7-2) — they exist in Java too. | `src/plugins/java/parser.ts` (new), `src/plugins/java/parser.test.ts` |
| 8 | Java symbol index extraction | P1 | — | | Equivalent of `scanFileForIndex` for Java: identify `class`/`interface`/`enum`/`record`/`@interface` declarations, `extends`/`implements` clauses (vs C# `:` syntax), method signatures, modifiers (`public`/`protected`/`private`/`abstract`/`sealed`/`final`/`static`). Map to same `SymbolEntry` shape used by `dig_lookup`/`dig_signatures`. Brace counting via plugin's `analyzeLine`. | `src/plugins/java/indexer.ts` (new), tests |
| 9 | Java signature stripping | P2 | — | | Equivalent of `stripCsBody` for Java. Strip method bodies → `{ ... }`, preserve JavaDoc (`/** */`), drop generated/private members per existing rules. Re-apply Phase 3 batch (strip `public` keyword, boilerplate methods, etc.) translated to Java idioms. | `src/plugins/java/signatureStripper.ts` (new), tests |
| 10 | Java package summary extraction | P2 | — | | Equivalent of `extractPackageSummary` — read `<description>` and `<name>` from `pom.xml` (or Gradle equivalent: `description = "..."` in `build.gradle`). One-line summary for `dig_list`. | `src/plugins/java/summary.ts` (new), tests |
| 11 | Java README discovery + filtering | P3 | — | | `dig_repo_overview` reads `README.md` already — language-agnostic for repo root. Per-package README discovery (`dig_package_overview`) needs the plugin to know where docs live (Maven artifact root vs. `src/main/java/.../package-info.java`). Reuse existing `readmeFilter.ts`. | `src/plugins/java/docFinder.ts` (new), tests |
| 12 | Java fixture corpus + plugin-level tests | P1 | — | | Build minimal Java fixture repos in `src/plugins/java/__fixtures__/` (or via `initRepo` helpers): single-module Maven, multi-module Maven, single-project Gradle, multi-project Gradle. Mirror `src/testHelpers.ts` pattern with `initJavaMavenRepo` / `initJavaGradleRepo` / `createBareNonJvmRepo`. Each plugin test (4, 5, 6, 7, 8, 9) exercises real fixtures. | `src/plugins/java/__fixtures__/*`, `src/testHelpers.ts` |
| 13 | End-to-end tool tests with mixed-language config | P2 | — | | Verify `dig_list`, `dig_lookup`, `dig_signatures`, `dig_file`, `dig_status`, `dig_refresh` all work with a config containing both `language: "csharp"` and `language: "java"` repos. Cross-language `dig_lookup` (omit `packageName`) must search both — output groups by repo as today. | `src/tools/*.test.ts`, `src/bootstrap.test.ts` |
| 14 | README + DESIGN.md + CHANGELOG updates | P2 | — | | Rewrite framing from ".NET only" to "polyglot — .NET + JVM, plugin-based". Document `language` config field. Update validation gate description in DESIGN.md (Shared Conventions). Add v1.1.0 (or v2.0.0 if breaking) entry to CHANGELOG. | `README.md`, `DESIGN.md`, `CHANGELOG.md`, `package.json` |

---

## Phase 12 — Parser Engine Migration (Tree-sitter)

> Replace the hand-written line-state-machine parser (`sourceExtractor.ts` — `analyzeLine`, `stripCsBody`, `scanFileForIndex`, `parseBaseTypes`) with `web-tree-sitter` (WASM) plus per-language grammars. Tree-sitter handles string variants (verbatim `@""`, raw `"""..."""`, Java text blocks), comments, brace counting, generics, and attributes by construction — eliminating the bug class that drove Phases 6, 7, and P10-M2.
>
> **Strategic timing:** Do NOT migrate just for better C# correctness — current parser passes 697 tests post-Phase-10 fixes. ROI only kicks in when adding a second language (Phase 11). Adopt tree-sitter at the same time as Phase 11.1 (`LanguagePlugin` interface design) so C# and Java share one engine instead of having two hand parsers to maintain.
>
> **Engine choice:** `web-tree-sitter` (WASM), not native `tree-sitter`. Reasons: no native compile / `node-pre-gyp` per-platform builds, no `.node` binaries shipped to sandboxed MCP clients, pure-JS portability. Cost: 3-5× slower than native bindings — still faster than the current hand parser, and parsing is not the hot path (cache hits dominate).
>
> **Decision rule:** if Phase 11 is parked indefinitely, skip Phase 12 — current parser is fine. If Phase 11 starts, fold this in as a prerequisite to P11-1.

### POC Findings (2026-05-25)

Ran tree-sitter native (`tree-sitter` + `tree-sitter-c-sharp@0.23.5`) against a fixture (`parser-poc/fixtures.cs`) containing every edge case that drove Phases 6, 7, and P10-M2. Native binding chosen over WASM only because POC is throwaway — production migration would use `web-tree-sitter`.

**Result: all 8 edge-case checks pass with zero parse errors.**

| Check | Hand-parser ticket | Tree-sitter result |
|---|---|---|
| Multi-line verbatim string with braces | P7-1 | ✓ class boundary correct, content opaque |
| C# 11 raw string literal `"""..."""` | P7-2, P10-7/8 | ✓ embedded `{` `}` ignored, span correct |
| Block comment spanning lines, fake decls inside | P6-2 | ✓ only real method extracted, 0 phantoms |
| Interpolated string with escaped `{{ }}` | P6-1 | ✓ class boundary unaffected |
| Generic with multi-constraint `where T : ... new()` | P7-6 | ✓ no angle-depth underflow |
| Abstract generic class with `: IOrderService where T : Order` | P10-7/8 | ✓ bases=[`IOrderService`] extracted |
| `public sealed record OrderId(int Value);` | — | ✓ dedicated `record_declaration` node + `parameter_list` |
| `public readonly struct Money` | — | ✓ modifiers exposed as `modifier` child nodes |

**Grammar AST shape (relevant for Phase 12 P12-3/4 design):**

- Modifiers (`public`, `abstract`, `sealed`, `readonly`, `static`) appear as repeated `modifier` child nodes — not a field. Walk by `child.type === "modifier"`.
- Type name is a field: `node.childForFieldName("name")`.
- Base types are exposed as a `base_list` **child type** (NOT a field) — walk children looking for `child.type === "base_list"`, then iterate its `namedChildren` for individual base types. The colon is included in `base_list.text` (`: IOrderService`) but stripped from named children.
- Method bodies in a `declaration_list` field named `"body"`. Each method = `method_declaration` named child with `name`, `type`, `parameters` fields.
- Generic parameters in `type_parameter_list` (child type). Constraints in `type_parameter_constraints_clause` (child type, may repeat).
- Records carry `parameter_list` as a child (positional record params) — must NOT be confused with method `parameters`.

**Design implication for P12-3 (`Parser` plugin contract):** the C# walker is type-driven, not field-driven. The plugin interface should expose `walkChildren(node, predicate)` rather than `getField(node, name)` — fields are a minority of the useful traversal patterns in this grammar.

**Concern surfaced — type-based AST traversal:** `tree-sitter-c-sharp` exposes most structural data as child **types** rather than named **fields**. Example: `base_list` lives at `node.children[i].type === "base_list"` — there is no `node.childForFieldName("bases")`. The POC's first attempt used field-based lookup and silently returned empty base-types for every class (one of the 8 checks failed until traversal was rewritten to walk by type). Implications: (a) plugin code is more verbose than a field-only API would be; (b) any grammar revision could rename node types and break the walker — pin `tree-sitter-c-sharp` to an exact version and add a grammar-version regression test; (c) AST shape must be documented next to the parser implementation, not assumed.

**Risk surface:** the POC fixture only covers parser edge cases. Phase 12 P12-2 (grammar coverage audit) still required before commit — test against C# 12 collection expressions, primary constructors, `required` members, file-scoped namespaces, etc.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | POC: parse Phase 6/7/10 fixtures with `web-tree-sitter` + `tree-sitter-c-sharp` | P1 | done | (local, not committed — `parser-poc/` gitignored) | All 8 edge-case checks pass with zero parse errors against tree-sitter native + `tree-sitter-c-sharp@0.23.5`. AST shape captured above. Native binding used for speed; production migration would use WASM. | `parser-poc/fixtures.cs`, `parser-poc/run.mjs`, `parser-poc/inspect.mjs` |
| 2 | Grammar coverage audit — modern C# features | P1 | — | | Confirm `tree-sitter-c-sharp` grammar handles: collection expressions (`[1, 2, 3]`), primary constructors, file-scoped namespaces, `required` members, `init` accessors, generic attributes, ref structs, `using` directives in any position, top-level statements. Test against curated `.cs` files using each feature. If gaps found, evaluate forking the grammar vs falling back to hand parser per-feature. | `parser-poc/grammar-audit.test.ts` |
| 3 | Design `Parser` plugin contract | P1 | — | | Define a parser plugin interface separate from (but consumed by) `LanguagePlugin`: `parseFile(content) → SyntaxTree`, `walkSymbols(tree) → SymbolEntry[]`, `walkSignatures(tree) → StrippedSignature[]`, `walkReferences(tree, keyword) → MatchSpan[]`. Lets the plugin pick tree-sitter, hand parser, or other engines without changing `LanguagePlugin` callers. | `src/parsing/parser.ts` (new) |
| 4 | C# tree-sitter implementation behind `Parser` interface | P1 | — | | Replace `analyzeLine`, `stripCsBody`, `scanFileForIndex`, `parseBaseTypes` with AST-driven equivalents. Grammar bundled as `.wasm` file in `dist/` (or downloaded on first use). All 160 `sourceExtractor` tests must pass. Phase 6/7/10/M2 regression tests stay green. | `src/parsing/csharp.ts`, `src/parsing/csharp.test.ts` |
| 5 | Java tree-sitter implementation | P1 | — | | Same shape as C# implementation using `tree-sitter-java` grammar. Pairs with Phase 11 P11-7/8/9 — replaces those hand-parser tasks with grammar-driven equivalents. Reduces Phase 11 scope by ~4 tasks. | `src/parsing/java.ts`, `src/parsing/java.test.ts` |
| 6 | Performance + binary size measurement | P2 | — | | Benchmark parse time vs current parser on a real `SharedKernel` package (~90 files). Measure npm tarball delta after grammar `.wasm` files added. Document trade-off in `DESIGN.md`. Acceptance gate: parse time ≤ 5× current, total package ≤ 25 MB. | `bench/parser.bench.ts` (new), `DESIGN.md` |
| 7 | Decommission hand parser code paths | P3 | — | | Once tree-sitter parser passes all tests in production for one minor release, delete `analyzeLine`, `stripCsBody`, `scanFileForIndex`, `parseBaseTypes` and their tests. Keep the file `sourceExtractor.ts` if it still contains non-parser utilities (overview generation, README processing), otherwise delete. | `src/sourceExtractor.ts`, `src/sourceExtractor.test.ts` |
