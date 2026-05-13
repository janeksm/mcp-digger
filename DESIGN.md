# mcp-digger — MCP Design

> MCP server exposing nine tools over stdio transport. Claude Code discovers tools via their descriptions and decides when to call each one.

## Server

- **Name:** `mcp-digger`
- **Transport:** `StdioServerTransport` (stdin/stdout JSON-RPC)
- **SDK:** `@modelcontextprotocol/sdk` ^1.29.0
- **Registration:** `McpServer.registerTool()` (non-deprecated API)
- **Entry point:** `src/index.ts`

## Tools

### `dig_status` — Health Check

| Field | Value |
|-------|-------|
| File | `src/tools/digStatus.ts` |
| Input | *(none)* |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Validates config and tests git connectivity for all configured repos. Call first to diagnose setup issues before digging.

**Output:** Markdown report with config summary (auth strategy, PAT status, repo count, warnings), workspace-scan summary (when any repo uses `packageFilter` — `.sln`/`.slnx`/`Directory.*.props`/`Directory.*.targets` counts, total referenced packages, cache file path), and per-repo checks (mode, branch when configured, discovery mode with filter + matching references, local path validation, remote connectivity via `git ls-remote`). Rich error context on failure: auth attempts made, exact error, actionable hints.

### `dig_list` — Discovery: Available Repos & Packages

| Field | Value |
|-------|-------|
| File | `src/tools/digList.ts` |
| Input | *(none)* |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Lists all configured repositories and their resolved package names with one-line summaries from `.csproj` metadata (`<PackageDescription>` + `<PackageTags>`). Call first to discover what's available before digging into any specific repo or package.

**Output:** Markdown listing of repos with their packages in `- **PkgName** — summary` format (falls back to `- **PkgName**` when no `.csproj` metadata). Warns if repo resolution was incomplete.

### `dig_repo_overview` — Level 1: Repo Overview

| Field | Value |
|-------|-------|
| File | `src/tools/digRepoOverview.ts` |
| Input | `repoName: string` — Name of the repository to overview (as shown by dig_list) |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Returns the repo root `README.md` (architecture, conventions, design docs) when it exists. Use to understand a repo's structure and design before digging into specific packages. Call `dig_list` first to discover available repos and their packages.

**Output:** Repo root README (if present, with non-architectural sections filtered out — install commands, CI/CD, badges, license, versioning, etc. are stripped by heading keyword and content-shape heuristics) followed by a package count with redirect to `dig_list` / `dig_package_overview`. Returns unknown-repo message when name doesn't match.

### `dig_package_overview` — Level 1: Package Overview

| Field | Value |
|-------|-------|
| File | `src/tools/digPackageOverview.ts` |
| Input | `repoName: string` — Name of the repository; `packageName: string` — Exact name of the internal NuGet package |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Returns the full overview for a single package — purpose, key public types/interfaces, architectural conventions. Call `dig_repo_overview` first to discover packages.

**Output:** Markdown with package docs (README, CONVENTIONS, ARCHITECTURE), key interfaces, and abstract classes (no file listing). Falls back to stale cache when repo is unreachable. Returns unknown-package message with available packages when name doesn't match.

### `dig_package_files` — Level 1: Package File Listing

| Field | Value |
|-------|-------|
| File | `src/tools/digPackageFiles.ts` |
| Input | `repoName: string` — Name of the repository; `packageName: string` — Exact name of the internal NuGet package |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Lists all C# source files in a package (excluding generated files). Use to see what files exist before calling `dig_file` for full source.

**Output:** Bullet list of `.cs` file paths relative to the package root, with a count footer. Excludes `.g.cs`, `.generated.cs`, `.Designer.cs` files.

### `dig_lookup` — Level 2: Symbol Lookup

| Field | Value |
|-------|-------|
| File | `src/tools/digLookup.ts` |
| Input | `packageName?: string` — Exact name of the internal NuGet package (e.g. 'MyCompany.Core'). Omit to search all packages; `keyword: string` — Type name, method name, or keyword to search for; `mode?: "symbol" \| "implements" \| "references"` — Search mode (default: `"symbol"`) |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Searches type/method indexes for a keyword. Supports three search modes: `"symbol"` (default) matches type/method declarations by name substring; `"implements"` finds classes/structs that implement a given interface or extend a given base class; `"references"` finds files that reference a given type name in source code (word-boundary, case-sensitive). Provide `packageName` to search within a specific package, or omit it to search across all packages. For `implements` mode, omitting `packageName` is recommended since implementations typically live in a different package than the interface.

**Output:** For `symbol` mode: markdown listing matching symbols (type name with generics, kind with modifiers, file path — e.g. `**Entity<TId>** (abstract class)`), grouped by `## PackageName` headings in cross-package mode, capped at 100 total matches. For `implements` mode: matching types with their base type list (e.g. `**SqlRepo<T>** (sealed class) : IRepo, IAuditable`), same grouping and cap. For `references` mode: file paths with occurrence counts (e.g. `` `Services/OrderService.cs` (3 occurrences) ``), capped at 50 files. Index cached per package as flat pipe-delimited file (`index.dat`) with optional base-type, generics, and modifiers fields, invalidated by commit hash. References mode reads source files directly (no cache).

### `dig_signatures` — Level 2: Stripped Signatures

| Field | Value |
|-------|-------|
| File | `src/tools/digSignatures.ts` |
| Input | `packageName: string` — Exact name of the internal NuGet package (e.g. 'MyCompany.Core'); `keyword: string` — Type name, method name, or keyword to search for; `exactMatch?: boolean` — When true, match only exact symbol names (case-insensitive). Default: false (substring match) |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Returns stripped C# signatures filtered by keyword. Searches the package's type and method index, then returns stripped source for matching files — type declarations, method signatures, property definitions, and XML doc comments with method bodies replaced by placeholders. Call when you need exact method overloads, generic constraints, interface members, or return types for specific types.

**Output:** Markdown with fenced C# code blocks per matching file. Headings show symbol name with generics and kind with modifiers for type matches (e.g. `EntityBase<TId> (abstract class)`), or file path for method matches. Each file has a generated header with package name and commit hash. Uses the same index as `dig_lookup` for search and per-file signature cache under `signatures/` directory, both invalidated by commit hash.

### `dig_refresh` — Operational: Cache Refresh

| Field | Value |
|-------|-------|
| File | `src/tools/digRefresh.ts` |
| Input | `repoName?: string` — Name of the repository to refresh (as shown by dig_list). Omit to refresh all repos |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Force-refreshes cached indexes for one or all repositories. Use when search results seem wrong, after mcp-digger was upgraded, or when you get "no matches" and want to rule out stale cache. For managed repos: fetches latest from remote, then clears all cached indexes. For local repos: re-reads HEAD, then clears all cached indexes. Unlike auto-refresh (which only invalidates when commit hash changes), this tool invalidates unconditionally.

**Output:** Markdown summary with per-repo details: mode (local/managed), package count, old → new commit hash, and cache-cleared confirmation. Per-repo errors are captured in the summary (not thrown). Subsequent tool calls rebuild indexes lazily.

### `dig_init` — Bootstrap: Config Creation

| Field | Value |
|-------|-------|
| File | `src/tools/digInit.ts` |
| Input | *(none)* |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |

**Purpose:** Creates a starter `.digger/config.json` with a sample template. Only registered when the server starts in unconfigured mode (no config file found). After running, the user edits the template and restarts the MCP server to activate all tools. Uses atomic file creation (`wx` flag) to avoid overwriting an existing config.

**Output:** Success message with the config file path and instructions to edit and restart. Returns error if config already exists or if file creation fails.

### `dig_file` — Level 3: Full Source

| Field | Value |
|-------|-------|
| File | `src/tools/digFile.ts` |
| Input | `packageName: string` — Exact name of the internal NuGet package (e.g. 'MyCompany.Core'); `filePath: string` — File path relative to the package root, as shown by dig_lookup or dig_package_files (e.g. 'Services/FooService.cs') |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Full source of a single file. Call only when implementation detail is needed — tracing behaviour, understanding algorithms, debugging. Avoid speculative calls. Capped at 1 MB (`FILE_CHAR_LIMIT`).

**Output:** Full file content with language hint. Rejects files exceeding 1 MB with a friendly message. On invalid path, lists valid files under the package directory.

## Tool Interaction Pattern

Claude Code follows a progressive disclosure pattern — escalating detail only as needed:

```
dig_status  →  dig_list  →  dig_repo_overview(repo)    →  dig_package_overview(repo, pkg)  →  dig_lookup(pkg, kw)    →  dig_file(pkg, path)
(health)       (discover)   (README + package listing)    (docs, interfaces, classes)          (symbol → file search)    (full source)
                                                        →  dig_package_files(repo, pkg)      →  dig_signatures(pkg, kw)
                                                           (source file listing)                 (stripped public API)

dig_refresh(repo?)  ← force cache invalidation, suggested by "no matches" messages
(operational)

dig_init            ← only registered when no config exists (unconfigured mode)
(bootstrap)
```

Each tool's description guides Claude on when to escalate to the next level. Tool descriptions include comparative cost hints so the agent can choose the cheapest tool that answers its question: `dig_lookup` (fast indexed symbol/implements lookup; references mode scans source) → `dig_signatures` (stripped API surface) → `dig_file` (full source).

## Shared Conventions

- **Never throws.** All tools return a usable text response on every error path (stale cache fallback, unavailable messages, valid path listings).
- **`isError` on failures.** Tools that can fail (`dig_file`, `dig_lookup`, `dig_package_overview`) return `isError: true` on error paths so the LLM can distinguish failures from successful-but-empty results. Internally, each tool function returns `ToolResult { text, isError }` using `toolSuccess()`/`toolError()` constructors from `shared.ts`. The `toCallToolResult()` helper converts this to the MCP wire format, spreading `isError` only when true.
- **Content format.** All tools return `{ content: [{ type: "text", text }] }` — standard `CallToolResult`.
- **Config-driven.** Tools receive resolved `DiggerConfig` at registration time. They never read env vars directly.
- **Cache-aware.** Overview and lookup tools use commit-hash-based cache invalidation. File tool reads directly from git.
- **Stale fallback.** When a repo becomes unreachable, three tools gracefully degrade by returning stale cached content with a warning disclaimer: `dig_package_overview` falls back to stale `overview.md`, `dig_lookup` (symbol/implements modes) falls back to stale `index.dat`, and `dig_signatures` falls back to stale `index.dat` + per-file signature cache under `signatures/`. The remaining tools have no fallback by design: `dig_lookup` references mode reads source files directly (no cached artifact to fall back to), `dig_repo_overview` and `dig_package_files` perform lightweight git reads with no pre-computed cache, `dig_file` reads source on demand, and the operational/discovery tools (`dig_list`, `dig_status`, `dig_refresh`) don't extract package content. The fallback pattern is: attempt fresh extraction → on failure, read stale cache artifact → if results exist, return them with a stale-content warning → otherwise return error.
- **Sequential repo processing.** Tools process repos sequentially to avoid concurrent git operations competing for network/disk.
- **Unconfigured mode.** When no config file is found (`loadConfig()` returns `null`), the server starts with only `dig_status` and `dig_init` registered. No `.digger/` directory is created, no logger is initialized, and no connections are attempted. `dig_status` reports the unconfigured state with setup instructions. `dig_init` creates a starter config at the resolved config path (respects `DIGGER_CONFIG` env var).
- **Package filtering.** A `packageFilter` field on a repo (e.g. `"packageFilter": "BSF.*"`) narrows the exposed package list to the intersection of (workspace-referenced packages matching the filter prefix ∩ on-disk `.csproj` directories). The repo `name` is a plain identifier (e.g. `"BSF.NuGet"`); `packages` (explicit list) and `packageFilter` are mutually exclusive. References are collected by a recursive workspace scan over `.sln`, `.slnx`, `Directory.Packages.props`, `Directory.Build.props`, and `Directory.Build.targets` files, skipping `.git`/`.digger`/`node_modules`/`bin`/`obj`/`.vs`/`.idea`/`packages`. The scan runs once per `ensureAllReady()` call and writes its full result to `<cacheDir>/solution-scan.json`. When a filtered repo resolves to zero packages, the per-repo `error` is surfaced by each tool with a recommendation to switch to an explicit `packages` list.
- **Branch tracking.** An optional `branch` field on a repo (e.g. `"branch": "develop"`) controls which git branch is cloned and fetched for managed repos. When set, `clone` uses `-b <branch>` and `fetch` fetches the named branch ref instead of `HEAD`. When omitted, the repo's default branch is used. Only meaningful for managed clones (Mode A) — for local repos (Mode B), the user controls the branch themselves. Branch names are validated (no `..`, no leading `-`, no `//`, safe charset).
