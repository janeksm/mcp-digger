# mcp-digger

Node.js/TypeScript MCP server that gives Claude Code progressive access to internal .NET NuGet shared library source. One health-check tool (`dig_status`) plus three dig levels: overview (markdown summary), signatures (stripped .cs — public API only), file (full source). Claude decides when to escalate based on tool descriptions.

## Claude Rules

- Always use context7 when I need code generation, setup or configuration steps, or library/API documentation.
- Don't combine `cd` with other commands (e.g. `cd /path && git status`). Run commands directly using absolute paths instead (e.g. `git -C /path status`). Compound commands can't be matched against the allowed permissions list, causing unnecessary confirmation prompts.

## Build & Test

```bash
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # vitest run (all tests)
npm run test:watch   # vitest watch
```

After every code change, run all three checks: `npm run typecheck && npm run lint && npm test`.

Tests use `vitest`. Test helpers are in `src/testHelpers.ts` — `initRepo()` creates temp git repos, `makeConfig()`/`makeLocalRepo()`/`makePkg()` build config objects. Logger tests use `vi.resetModules()` + dynamic import for module isolation.

## Architecture

```
src/
  index.ts              ← MCP server entry point (McpServer + StdioServerTransport)
  config.ts             ← .digger/config.json parsing, env var merging, validation
  gitClient.ts          ← git CLI via child_process.execFile (clone, fetch, revParse, readFile, listFiles)
  repoManager.ts        ← Mode A (managed clone) / Mode B (local repo) logic, ensureReady()
  cacheManager.ts       ← per-repo meta.json freshness, overview + signatures cache read/write
  sourceExtractor.ts    ← overview markdown generation, .cs signature stripping (stripCsBody)
  logger.ts             ← debug logging singleton (two-phase init with pre-init buffering)
  testHelpers.ts        ← shared test utilities
  tools/
    digStatus.ts        ← Health check: config summary + lsRemote connectivity per repo
    digOverview.ts      ← Level 1: markdown overview of all packages
    digSignatures.ts    ← Level 2: stripped .cs public signatures for one package
    digFile.ts          ← Level 3: full source of a single file
```

## Key Patterns

- **Config is the single source of truth.** `loadConfig()` resolves the config file, `.env` values, and per-repo auth. Modules receive resolved config — they never read env vars directly.
- **Git auth is per-repo.** Each repo has its own `auth` block with strategy (auto/pat/none) and either inline `PAT` or `PAT-EnvVarName` (env var indirection for secrets). PAT is injected into HTTPS URLs at call time, never persisted to git remote config. `gitClient.ts` never logs credentials.
- **Two repo modes:** Mode A = managed shallow clone in `.digger/source/`. Mode B = developer's local repo (read-only, never fetched), configured via top-level `localRepos` object. Fallback from B→A with warning if local path invalid.
- **Cache invalidation:** single commit hash per repo in `meta.json`. All packages in a repo share freshness state. Stale → regenerate all, then `markFresh`.
- **Tools never throw.** Always return a usable text response, even on errors (stale cache fallback, unavailable messages, valid path listings).
- **Logger singleton:** `debug(tag, ...args)` — buffers before `initLogger()`, writes to `.digger/debug.log` after. Enabled via `"debug": true` in config.

## Config & Env Vars

Config file: `.digger/config.json` (path override: `DIGGER_CONFIG`).

Auth, local-repo paths, and the debug flag all live in the config file — no env vars duplicate them. The `.env` file is only used to supply per-machine secrets referenced by `auth.PAT-EnvVarName`. Precedence: actual environment > `.env` file in workspace root. Values in `.env` only fill in vars not already set in the real environment.

Env vars (optional path overrides only — no secrets):
- `DIGGER_CONFIG` — override config file path (default `.digger/config.json`)
- `MANAGED_SOURCE_DIR` — override managed clone dir (default `.digger/source`)
- `CACHE_DIR` — override cache dir (default `.digger/cache`)

## Implementation Status

Progress tracked in [TODO.md](TODO.md). Steps 1–9 and 11 are done. Step 10 (read version from package.json instead of hardcoding in McpServer constructor) is not started.
