# Changelog

All notable changes to **mcp-digger** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-16

First stable release. Ten progressive-disclosure MCP tools for .NET NuGet source code, ready for production use.

### Added

- **Ten MCP tools** with progressive disclosure (L1 → L2 → L3):
  - `dig_status` — config + connectivity + index health
  - `dig_list` — repos and packages with `.csproj` one-line summaries
  - `dig_repo_overview` — repo README filtered to architectural sections
  - `dig_package_overview` — package docs, key interfaces, abstract classes, file count
  - `dig_package_files` — `.cs` file listing with directory summary header
  - `dig_lookup` — indexed symbol search (`symbol`, `implements`, `references` modes, cross-package)
  - `dig_signatures` — stripped public C# API with structured summary blocks and result ranking
  - `dig_file` — full source (1 MB cap)
  - `dig_refresh` — force cache invalidation (one or all repos)
  - `dig_init` — bootstrap a starter `.digger/config.json` (registered only when unconfigured)
- **Per-repo `auth` block** with strategy (`auto` / `pat` / `none`) and `PAT` or `PAT-EnvVarName` (env-var indirection).
- **Top-level `localRepos`** for Mode B (read-only local checkout).
- **Optional `branch` field** for managed clones, used for both clone and fetch.
- **Wildcard `packageFilter`** (e.g. `MyCompany.*`) with workspace scan over `.sln`/`.slnx`/`Directory.Packages.props`/`Directory.Build.props`/`Directory.Build.targets`. Transitive `<ProjectReference>` walk expands the match set.
- **`dig_lookup` modes:** `symbol` (declaration substring), `implements` (interface/base lookup), `references` (file-level reference scan).
- **`dig_signatures` keyword + `exactMatch`** parameters for narrow API queries.
- **Comparative cost hints** in tool descriptions so agents pick the cheapest tool first.
- **Contextual next-step hints** appended to successful tool results.
- **Structured summary block** atop each `dig_signatures` type result (kind, implements list, method counts, key signatures).
- **Result ranking** in `dig_lookup` and `dig_signatures` (exact > word-boundary > substring, tiebroken by dependency-graph importance).
- **Dependency-graph importance scoring** for symbol index (incoming-reference count surfaces hub types).
- **Index health stats** in `dig_status` (file count, symbol counts, cache age, commit hash).
- **Stale-cache fallback** in `dig_package_overview`, `dig_lookup` (symbol/implements modes), and `dig_signatures` when repos are unreachable.
- **Graceful unconfigured mode** — server starts with only `dig_status` + `dig_init` when no `.digger/config.json` exists; no directories created until configured.
- **Repo-level diagnostic warnings** when wildcard `packageFilter` resolves zero packages.
- **`prepublishOnly` script** chaining `typecheck && lint && test && build` to block stale `dist/` from being published.

### Changed

- **Tool split:** `dig_overview` decomposed into `dig_repo_overview`, `dig_package_overview`, and `dig_package_files` (cleaner cost separation).
- **`dig_file` scoped to a single repo+package** instead of free-form lookup (security hardening).
- **`dig_list` returns `isError: true`** when every configured repo fails (agents now correctly escalate to `dig_status`).
- **README rewritten** around value proposition; added Codex CLI setup and branch-config documentation.
- **Smart README filtering** in `dig_repo_overview` (heading blocklist + content-shape heuristics) drops install/CI/license/badge sections.
- **`dig_package_files`** prepends a directory summary (`Attributes/ (2) · Services/ (1) · 1 root file`).
- **`dig_package_overview`** appends source file count and a hint to use `dig_lookup` for large packages.
- **`dig_repo_overview`** no longer renders a duplicate `## Packages` section (data already in `dig_list`).
- **All tools annotated** with `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.
- **`zod` added as direct dependency** instead of relying on the MCP SDK transitive.

### Fixed

- **Lexer-aware brace counting** in `scanFileForIndex` — strings, char literals, interpolations, and inline comments no longer corrupt the depth/type stack.
- **Block-comment state tracking** in `scanFileForIndex` — multi-line block comments no longer mis-parse their content as code.
- **C# verbatim strings** (`@"..."`) handled in `analyzeLine` (literal `\`, `""` escape, multi-line propagation).
- **C# 11 raw string literals** (`"""..."""`) handled in `analyzeLine` (quote-count tracking, multi-line propagation).
- **Raw-string state propagated** through forward-scan in `parseBaseTypes` so declarations spanning raw strings parse correctly.
- **Comment-stripping regex multiline-aware** in base-type parsing (added `s` flag).
- **`pendingType` cleared** when exiting block comments (no more stale type attribution for methods after a comment).
- **Angle-bracket depth floor** in `parseBaseTypes` and `splitRespectingGenerics` — extra `>` no longer permanently disables base-type detection.
- **Cross-package reference file limit** enforced within a single repo (local counter inside `withRepoLock`).
- **`ExecFileException.code`** read as `number` instead of stale `.status` reference.
- **`fs.rm()` parallel deletes** use `Promise.allSettled` so one cache-clear failure doesn't abort the rest.
- **`repos[]` validation** guards with `Array.isArray` before iteration in config parsing.
- **Stale-cache reads wrapped in their own try-catch** in `dig_lookup` and `dig_signatures` — corrupted `index.dat` no longer throws past the tool boundary.
- **`safeRepoSlug` cleanup replaced with an assertion** (validation already rejects bad chars; cleanup was dead code masking a collision risk).
- **`.env` inline comment stripping limitation** documented in `.env.sample`.

### Security

- **PAT redaction** from all git error output and debug logs.
- **Path traversal** blocked in `dig_file` (rejects `..`, absolute paths, symlinks).
- **URL scheme allowlist** — `https:` / `ssh:` only.
- **Package name charset validation** against safe regex.
- **Atomic `meta.json` writes** + per-repo mutex (`withRepoLock`).
- **Prototype-pollution guards** on every `JSON.parse` (config, cache, solution scan).
- **`discoverPackages` fan-out cap** to bound auto-discovery cost.
- **Log file capped** at 5 MB with auto-truncation.
- **`npm audit fix`** clears 5 transitive vulnerabilities — 1 high (`fast-uri` via MCP SDK → ajv) and 4 moderate (`hono`, `ip-address`, `express-rate-limit`, `postcss`).
- **GCM/credential prompts suppressed** on `auto` strategy's unauthenticated probe.

### Hardening

- **Crash handlers** — `process.on("uncaughtException")` / `process.on("unhandledRejection")` log to stderr + `error.log`.
- **Top-level `server.connect` wrapped** in try-catch so the MCP client sees a clean error rather than a silent process exit.
- **Signal handlers** — `SIGINT` / `SIGTERM` call `server.close()` before `process.exit(0)`, avoiding mid-write interruption of git/file operations.
- **Sequential repo processing** across cross-package tools (`dig_lookup`, `dig_refresh`, `dig_list`) to avoid concurrent git contention.
- **Tools never throw** — every error path returns a usable `toolError()` result with `isError: true`.

[1.0.0]: https://github.com/janeksm/mcp-digger/releases/tag/v1.0.0
