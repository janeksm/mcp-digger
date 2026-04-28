# mcp-digger — MCP Design

> MCP server exposing five tools over stdio transport. Claude Code discovers tools via their descriptions and decides when to call each one.

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

**Output:** Markdown report with config summary (auth strategy, PAT status, repo count, warnings), workspace-scan summary (when any repo uses `packageFilter` — `.sln`/`.slnx`/`Directory.*.props`/`Directory.*.targets` counts, total referenced packages, cache file path), and per-repo checks (discovery mode with filter + matching references, local path validation, remote connectivity via `git ls-remote`). Rich error context on failure: auth attempts made, exact error, actionable hints.

### `dig_list` — Discovery: Available Repos & Packages

| Field | Value |
|-------|-------|
| File | `src/tools/digList.ts` |
| Input | *(none)* |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Lists all configured repositories and their resolved package names. Call first to discover what's available before digging into any specific repo or package.

**Output:** Markdown listing of repos with their package names. Warns if repo resolution was incomplete.

### `dig_overview` — Level 1: Package Overview

| Field | Value |
|-------|-------|
| File | `src/tools/digOverview.ts` |
| Input | `repoName: string` — Name of the repository to overview (as shown by dig_list) |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Returns a markdown overview of a single repo's packages — purpose, key public types/interfaces, architectural conventions, usage patterns. Call dig_list first to discover available repos.

**Output:** Markdown sections per package in the specified repo. Falls back to stale cache or "unavailable" message when a repo is unreachable. Returns unknown-repo message with available repos when name doesn't match.

### `dig_lookup` — Level 2: Symbol Lookup

| Field | Value |
|-------|-------|
| File | `src/tools/digLookup.ts` |
| Input | `packageName: string` — Exact name of the internal NuGet package (e.g. 'MyCompany.Core'); `keyword: string` — Type name, method name, or keyword to search for |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Searches a package's cached type/method index for a keyword. Returns matching symbols with their file paths. Call when you know a type or method name and need to find which file implements it — then use `dig_file` to read that file.

**Output:** Markdown listing matching symbols (type name, kind, file path). Index cached per package as flat pipe-delimited file (`index.dat`), invalidated by commit hash.

### `dig_file` — Level 3: Full Source

| Field | Value |
|-------|-------|
| File | `src/tools/digFile.ts` |
| Input | `packageName: string` — Exact name of the internal NuGet package (e.g. 'MyCompany.Core'); `filePath: string` — File path relative to the package root, as shown by dig_lookup or dig_overview (e.g. 'Services/FooService.cs') |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

**Purpose:** Full source of a single file. Call only when implementation detail is needed — tracing behaviour, understanding algorithms, debugging. Avoid speculative calls. Capped at 1 MB (`FILE_CHAR_LIMIT`).

**Output:** Full file content with language hint. Rejects files exceeding 1 MB with a friendly message. On invalid path, lists valid files under the package directory.

## Tool Interaction Pattern

Claude Code follows a progressive disclosure pattern — escalating detail only as needed:

```
dig_status  →  dig_list  →  dig_overview(repo)  →  dig_lookup(pkg, keyword)  →  dig_file(pkg, file)
(health)       (discover)   (what exists)           (find symbol → file)        (implementation)
```

Each tool's description guides Claude on when to escalate to the next level.

## Shared Conventions

- **Never throws.** All tools return a usable text response on every error path (stale cache fallback, unavailable messages, valid path listings).
- **`isError` on failures.** Tools that can fail (`dig_file`, `dig_lookup`, `dig_overview`) return `isError: true` on error paths so the LLM can distinguish failures from successful-but-empty results. Internally, each tool function returns `ToolResult { text, isError }` using `toolSuccess()`/`toolError()` constructors from `shared.ts`. The `toCallToolResult()` helper converts this to the MCP wire format, spreading `isError` only when true.
- **Content format.** All tools return `{ content: [{ type: "text", text }] }` — standard `CallToolResult`.
- **Config-driven.** Tools receive resolved `DiggerConfig` at registration time. They never read env vars directly.
- **Cache-aware.** Overview and lookup tools use commit-hash-based cache invalidation. File tool reads directly from git.
- **Sequential repo processing.** Tools process repos sequentially to avoid concurrent git operations competing for network/disk.
- **Package filtering.** A `packageFilter` field on a repo (e.g. `"packageFilter": "BSF.*"`) narrows the exposed package list to the intersection of (workspace-referenced packages matching the filter prefix ∩ on-disk `.csproj` directories). The repo `name` is a plain identifier (e.g. `"BSF.NuGet"`); `packages` (explicit list) and `packageFilter` are mutually exclusive. References are collected by a recursive workspace scan over `.sln`, `.slnx`, `Directory.Packages.props`, `Directory.Build.props`, and `Directory.Build.targets` files, skipping `.git`/`.digger`/`node_modules`/`bin`/`obj`/`.vs`/`.idea`/`packages`. The scan runs once per `ensureAllReady()` call and writes its full result to `<cacheDir>/solution-scan.json`. When a filtered repo resolves to zero packages, the per-repo `error` is surfaced by each tool with a recommendation to switch to an explicit `packages` list.
