# Reusable Code Patterns

> Part of [Cave Man Claude Memory (CMCM)](CAVEMAN_CM.md) — single source of truth for all codebase patterns. Reference by name in planning and code review.

## config-is-source-of-truth

When: Modules need configuration values (auth, paths, feature flags)
Shape: `loadConfig()` resolves the config file, `.env` values, and per-repo auth. Modules receive resolved `DiggerConfig` at registration time. They never read env vars directly.
Examples: src/config.ts, src/index.ts, all tool registrations

## git-auth-per-repo

When: Repos need authentication for clone/fetch/ls-remote
Shape: Each repo has its own `auth` block with strategy (auto/pat/none) and either inline `PAT` or `PAT-EnvVarName` (env var indirection for secrets). PAT is injected into HTTPS URLs at call time, never persisted to git remote config. `gitClient.ts` never logs credentials.
Examples: src/config.ts, src/gitClient.ts

## two-repo-modes

When: Resolving a repo for source extraction
Shape: Mode A = managed shallow clone in `.digger/source/`. Mode B = developer's local repo (read-only, never fetched), configured via top-level `localRepos` object. Fallback from B→A with warning if local path invalid.
Examples: src/repoManager.ts, src/config.ts

## cache-by-commit-hash

When: Caching extracted data (overviews, indexes, signatures)
Shape: Single commit hash per repo stored in meta.json. All packages in a repo share freshness state. Hash change → regenerate all cached artifacts, then `markFresh()`. Cache files: overview.md, index.dat, signatures/*.txt
Examples: src/cacheManager.ts, src/repoManager.ts

## tools-never-throw

When: Any tool execution, including error paths
Shape: All tools return a usable text response on every code path. Success uses `toolSuccess()`, errors use `toolError()` (sets `isError: true`). Never throw exceptions from tool handlers. `toCallToolResult()` converts to MCP wire format.
Examples: all src/tools/*.ts, src/tools/shared.ts

## tool-error-with-fallback

When: A tool cannot reach the repo (network failure, missing local path) but has cached data
Shape: Attempt fresh extraction → on failure, read stale cache artifact → if stale results exist, return them with a warning disclaimer → otherwise return `toolError()`. Wrap stale parse/search in its own inner try-catch — corrupt cache artifacts must not throw past the tool boundary (violates [[tools-never-throw]]). On parse failure, log and fall through to the `toolError()` exit.
Examples: src/tools/digPackageOverview.ts, src/tools/digLookup.ts (symbol/implements modes), src/tools/digSignatures.ts

## sequential-repo-processing

When: Tools process multiple repos (cross-package search, refresh all, list)
Shape: Process repos one at a time in a for-loop (not Promise.all). Avoids concurrent git operations competing for network/disk. Use `withRepoLock()` from repoLock.ts for per-repo mutual exclusion within a single repo's operations.
Examples: src/tools/digLookup.ts, src/tools/digRefresh.ts, src/tools/digList.ts, src/repoLock.ts

## logger-singleton

When: Debug logging from any module
Shape: `debug(tag, ...args)` — buffers before `initLogger()`, writes to `.digger/debug.log` after. Enabled via `"debug": true` in config. Two-phase init with pre-init buffering.
Examples: src/logger.ts, used across all modules

## recursive-tree-walk-skip-ignored

When: Walking a repo/workspace tree to collect files or directories matching a predicate
Shape: Depth-first `fs.promises.readdir(..., {withFileTypes: true})`, sort entries alphabetically for determinism, skip symlinks, skip names in shared `IGNORED_DIRS` set (`.git`, `.digger`, `node_modules`, `bin`, `obj`, `.vs`, `.idea`, `packages`), apply per-walk filter (e.g. test-suffix exclusion), recurse into surviving subdirectories. Each call site duplicates its own `IGNORED_DIRS` set with identical contents — kept in lockstep by convention since the workspace scan and source-repo scan must ignore the same noise.
Examples: src/solutionScanner.ts (`walkTree`), src/config.ts (`walkPackageDirs`)

## fetch-resets-managed-clone

When: A managed shallow clone needs to pull upstream changes before disk-walking tools (`fs.readdir`) or HEAD-relative reads (`git show HEAD:path`) consume the new content
Shape: `git fetch --depth 1 origin <branch ?? "HEAD">` followed by `git reset --hard FETCH_HEAD` — same refspec across all auth paths so `FETCH_HEAD` resolves to a single deterministic commit. Reset is OUTSIDE the fetch try/catch so a reset failure isn't misread as a fetch failure and trigger a PAT retry. Mode B (local repos) skip this — user owns the working tree. Managed clones run in detached-HEAD state after first fetch.
Examples: src/gitClient.ts (`fetch`, `resetHardToFetchHead`)
