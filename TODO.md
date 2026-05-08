# mcp-digger — Implementation Progress

> Tracks step-by-step progress for the implementation plan defined in [INIT_PLAN.md](INIT_PLAN.md).
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
| 13 | `gitClient.ts`, `tools/digFile.ts` | done | eda3f53 | Security: PAT redaction in git errors + dig_file path traversal validation. Remaining findings tracked in [TODO.SEC.md](TODO.SEC.md) |
| 14 | `gitClient.ts` | done | 154e09d | Suppress GCM/credential prompts on auto strategy unauthenticated attempt |
| 15 | `tools/digStatus.ts`, `gitClient.ts` | done | a2ceae8 | dig_status MCP tool, lsRemote() connectivity check, improved auth debug logging, DESIGN.md |
| 16 | `config.ts`, `repoManager.ts`, `tools/digStatus.ts` | done | 5626ef3 | per-repo `auth` (strategy + PAT / PAT-EnvVarName), top-level `localRepos`, drop duplicated env vars, README rewrite with dig_status |
| 17 | `solutionScanner.ts`, `config.ts`, `repoManager.ts`, `tools/*` | done | af6809a | wildcard repo names (`MyCompany.*`), recursive workspace scan (.sln/.slnx/Directory.Packages.props/Directory.Build.props/Directory.Build.targets), per-repo error surfacing, fix packages:[] auto-discover bug |
| 10 | `index.ts` | done | d981129 | DRY version: read from package.json instead of hardcoding in McpServer constructor |

**Statuses:** `—` not started, `in-progress` active, `done` committed, `blocked` waiting on something

---

## Phase 2 — MCP Compliance & Security Hardening

> Review against MCP best practices and security findings from [TODO.SEC.md](TODO.SEC.md).

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
| 11 | Close SEC #9 — log-file size cap already exists | Done | done | Verified: `MAX_LOG_SIZE = 5 * 1024 * 1024` at `logger.ts:12`, truncation at lines 58-63. Update TODO.SEC.md. | `TODO.SEC.md` |
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

> Optimise tool outputs for AI agent consumption. Goal: reduce token waste, eliminate redundant tool calls, and front-load the most useful information so the agent can stop reading early. Based on end-to-end testing of all 8 tools with real data (BSF.NuGet, 7 packages, ~90 files in SharedKernel).
>
> **Design principle:** Don't split or merge tools — the 8-tool progressive escalation (L1→L2→L3) is the right shape. Instead, make each tool's output denser and more front-loaded. The agent should get what it needs in fewer calls with less noise.

| # | Task | Priority | Status | Commit | Rationale | Files |
|---|------|----------|--------|--------|-----------|-------|
| 1 | Enrich `dig_list` with one-line package summaries from `.csproj` metadata | P1 | done | e8ed8f0 | Currently `dig_list` returns bare package names, forcing the agent to call `dig_repo_overview` (~900 tokens) just to learn what each package does. The `.csproj` summaries (PackageDescription + PackageTags) are already extracted by `extractPackageSummary()` in `sourceExtractor.ts` — they just aren't surfaced in `dig_list`. Adding them lets the agent go `dig_list` → `dig_lookup` directly, skipping `dig_repo_overview` entirely in most sessions. **Saves ~900 tokens and 1 tool call per session.** | `src/tools/digList.ts`, `src/tools/digList.test.ts` |
| 7 | Wildcard: resolve transitive project references | P1 | done | 60bc6bd | BFS-walk `<ProjectReference>` links in matched packages' `.csproj` files to expand wildcard match set transitively. Handles cycles, prefix filtering, non-candidate exclusion. | `src/repoManager.ts`, `src/repoManager.test.ts` |
| 2 | Smart-filter README sections in `dig_repo_overview` | P2 | — | | The full repo README is dumped verbatim (~60 lines for BSF.NuGet), including `dotnet add package` install commands, CI/CD pipeline docs, versioning/release instructions, and "Claude Code Skill" sections. None of this helps the agent understand code architecture. However, some sections ARE valuable: the package dependency tree, package groupings (Core vs Infrastructure), and architectural descriptions. **Fix: strip sections matching known non-code patterns (install blocks, versioning, CI/CD, release notes) while preserving architectural content.** Don't blindly truncate — different READMEs have different structures, so pattern-match on section headings and content shapes. **Saves ~500 tokens per call.** | `src/tools/digRepoOverview.ts`, `src/sourceExtractor.ts` |
| 3 | Add directory summary header to `dig_package_files` | P3 | — | | For large packages (SharedKernel has 90 files), the flat file list burns tokens. However, **don't group files or hide individual paths** — the agent needs exact file paths for `dig_file` calls. Instead, add a directory summary header at the top: `Attributes/ (14) · Cqrs/ (4) · Extensions/ (15) · Interfaces/ (17) · Primitives/ (11) · ...5 root files`. The agent can use this to orient itself and stop reading the full list once it finds the relevant directory section. Full paths remain below for copy-paste into `dig_file`. **Saves reading time without losing data. ~400 tokens of effective savings through early termination.** | `src/tools/digPackageFiles.ts` |
| 4 | Add file count to `dig_package_overview` output | P5 | — | | Knowing "90 source files" vs "3 source files" helps the agent decide its next step — whether to call `dig_package_files` (small package) or go straight to `dig_lookup` (large package). Currently there's no size hint. **Add one line like `*90 source files — use dig_lookup to find specific types.*` at the end of the overview.** This may eliminate a `dig_package_files` call entirely for large packages where `dig_lookup` is the better strategy. Pure additive change, no info loss. | `src/tools/digPackageOverview.ts`, `src/sourceExtractor.ts` |
| 5 | Remove duplicate package listing from `dig_repo_overview` bottom | P6 | — | | `dig_repo_overview` currently renders the package list twice: once in the README content (rich descriptions, dependency tree) and again as a generated `## Packages` section at the bottom with `.csproj` summaries and tags. **Depends on P4-1:** once `dig_list` includes summaries, this bottom section is fully redundant — the agent already has the same data from its earlier `dig_list` call. Remove the generated section, keep the README content. **Saves ~100 tokens per call. Only safe after P4-1 is implemented.** | `src/tools/digRepoOverview.ts`, `src/sourceExtractor.ts` |
| 6 | Add diagnostic message when wildcard resolves 0 packages | P2 | — | | When `packageFilter` wildcard mode finds on-disk candidates but no workspace `.sln`/`.slnx` files to cross-reference, `referenced=0` → `matched=0` → "No packages resolved" with zero explanation. Discovered during Inspector testing: the mcp-digger repo itself has no `.sln`, so wildcard always fails. The agent (or user) gets no hint about why. **Fix: when wildcard matches 0 packages AND referenced=0, set a warning on the repo explaining the cause (e.g. "No .sln files found in workspace to cross-reference against packageFilter 'BSF.*'. Use explicit `packages` list, or omit `packageFilter` for auto-discovery."). Surface in `dig_list` and `dig_status` output.** | `src/repoManager.ts`, `src/tools/digList.ts`, `src/tools/digStatus.ts` |
