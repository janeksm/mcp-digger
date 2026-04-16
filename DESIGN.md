# mcp-digger — MCP Design

> MCP server exposing four tools over stdio transport. Claude Code discovers tools via their descriptions and decides when to call each one.

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
| Annotations | `readOnlyHint: true`, `destructiveHint: false` |

**Purpose:** Validates config and tests git connectivity for all configured repos. Call first to diagnose setup issues before digging.

**Output:** Markdown report with config summary (auth strategy, PAT status, repo count, warnings) and per-repo checks (local path validation, remote connectivity via `git ls-remote`). Rich error context on failure: auth attempts made, exact error, actionable hints.

### `dig_overview` — Level 1: Package Overview

| Field | Value |
|-------|-------|
| File | `src/tools/digOverview.ts` |
| Input | *(none)* |
| Annotations | *(none)* |

**Purpose:** Returns a markdown overview of all configured packages — purpose, key public types/interfaces, architectural conventions, usage patterns. Call this first before working with internal packages.

**Output:** Concatenated markdown sections per package. Falls back to stale cache or "unavailable" message when a repo is unreachable.

### `dig_signatures` — Level 2: Public API Signatures

| Field | Value |
|-------|-------|
| File | `src/tools/digSignatures.ts` |
| Input | `packageName: string` |
| Annotations | *(none)* |

**Purpose:** Returns stripped C# source — public type declarations, method signatures, property definitions, XML doc comments. Method bodies replaced with placeholder. Call when the overview isn't enough (exact overloads, generics, constraints).

**Output:** Markdown with stripped `.cs` file contents per package. Cached per commit hash.

### `dig_file` — Level 3: Full Source

| Field | Value |
|-------|-------|
| File | `src/tools/digFile.ts` |
| Input | `packageName: string`, `filePath: string` |
| Annotations | *(none)* |

**Purpose:** Full source of a single file. Call only when implementation detail is needed — tracing behaviour, understanding algorithms, debugging. Avoid speculative calls.

**Output:** Full file content with language hint. On invalid path, lists valid files under the package directory.

## Tool Interaction Pattern

Claude Code follows a progressive disclosure pattern — escalating detail only as needed:

```
dig_status  →  dig_overview  →  dig_signatures  →  dig_file
(health)       (what exists)    (public API)       (implementation)
```

Each tool's description guides Claude on when to escalate to the next level.

## Shared Conventions

- **Never throws.** All tools return a usable text response on every error path (stale cache fallback, unavailable messages, valid path listings).
- **Content format.** All tools return `{ content: [{ type: "text", text }] }` — standard `CallToolResult`.
- **Config-driven.** Tools receive resolved `DiggerConfig` at registration time. They never read env vars directly.
- **Cache-aware.** Overview and signatures tools use commit-hash-based cache invalidation. File tool reads directly from git.
- **Sequential repo processing.** Tools process repos sequentially to avoid concurrent git operations competing for network/disk.
