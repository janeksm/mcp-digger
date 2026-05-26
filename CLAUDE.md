# mcp-digger

Node.js/TypeScript MCP server that gives Claude Code progressive access to .NET NuGet package source code. One health-check tool (`dig_status`), a discovery tool (`dig_list`), six dig tools: repo overview (package listing with summaries), package overview (docs + key types), package files (source file listing), lookup (symbol-to-file search, supports cross-package), signatures (stripped public API), file (full source), and one operational tool (`dig_refresh` — force cache invalidation). Claude decides when to escalate based on tool descriptions.

## Claude Rules

- Always use context7 when I need code generation, setup or configuration steps, or library/API documentation.
- Use the mcp-builder skill when you need deeper understanding of MCP best practices, protocol concepts, tool design patterns, annotations, input/output schemas, or transport options.
- Don't combine `cd` with other commands (e.g. `cd /path && git status`). Run commands directly using absolute paths instead (e.g. `git -C /path status`). Compound commands can't be matched against the allowed permissions list, causing unnecessary confirmation prompts.

## Clean Code (Pragmatic)

**Before writing, modifying, or reviewing any code, read [CC.md](CC.md).** It contains the full Node.js / TypeScript-specific rule set (async patterns, error handling, module hygiene, testing, security, performance) and complements the language-agnostic principles below.

Follow these principles as defaults, not dogma. Break any rule when it clearly hurts readability or adds unnecessary complexity.

- **Naming is design.** Functions, variables, and types should reveal intent. If you need a comment to explain *what* something does, rename it instead. Avoid abbreviations unless universally understood (`config`, `pkg`, `idx` are fine; `prfx`, `dsc` are not).
- **Functions do one thing.** A function should have a single reason to change. If a function name needs "and" to describe it, split it. Keep functions short enough to read without scrolling — but don't split just to hit an arbitrary line count.
- **One level of abstraction per function.** Don't mix high-level orchestration with low-level string manipulation in the same function body. Extract the lower level into a named helper.
- **Minimal parameters.** Prefer 0–2 parameters. When a function needs 3+, consider grouping related params into an object/config. Booleans as parameters are a smell — they usually mean the function does two things.
- **No side effects unless the name says so.** A function named `getX` or `findX` should not modify state. Functions that mutate should have verbs like `update`, `set`, `write`, `mark`.
- **Early returns over nesting.** Guard clauses at the top, happy path at normal indentation. Avoid `else` after `return`.
- **DRY, but not at the cost of coupling.** Extract duplication only when the duplicated pieces change for the same reason. Three similar lines are better than a premature abstraction that couples unrelated concerns.
- **Boy Scout Rule.** Leave code cleaner than you found it — but only in the area you're already touching. Don't refactor unrelated code in the same change.
- **Tests are documentation.** Test names should read as specifications. Arrange-Act-Assert structure. One logical assertion per test (multiple `expect` calls are fine if they verify one behavior).
- **Error handling is behavior.** Don't ignore errors silently. Return meaningful messages (this project: tools never throw, they return `toolError()`). Handle errors at the right level — where you have enough context to do something useful.

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
  cacheManager.ts       ← per-repo meta.json freshness, overview + signatures + index cache read/write
  sourceExtractor.ts    ← overview markdown generation, signature stripping, symbol index extraction
  logger.ts             ← debug logging singleton (two-phase init with pre-init buffering)
  testHelpers.ts        ← shared test utilities
  tools/
    digStatus.ts        ← Health check: config summary + lsRemote connectivity per repo
    digList.ts          ← Discovery: available repos and their package names
    digRepoOverview.ts  ← Level 1: repo root README + package listing with .csproj summaries
    digPackageOverview.ts ← Level 1: full single-package overview (docs, key interfaces, abstract classes)
    digPackageFiles.ts  ← Level 1: source file listing for a package
    digLookup.ts        ← Level 2: keyword search over type/method index → matching file paths
    digSignatures.ts    ← Level 2: stripped C# signatures filtered by keyword (type declarations, method sigs, XML docs)
    digFile.ts          ← Level 3: full source of a single file
    digRefresh.ts       ← Operational: force-invalidate cache for one or all repos
```

## Key Patterns

See [PATTERNS.md](PATTERNS.md) — single source of truth for all codebase patterns (part of CMCM).

## Cave Man Claude Memory (CMCM)

Cross-session memory via markdown files. Skills read/write them automatically.
See [CAVEMAN_CM.md](CAVEMAN_CM.md) for full system docs, data flow, and rules.

Files: `DECISIONS.md` (decision log) · `PATTERNS.md` (code shapes) · `HANDOFF.md` (session state, .gitignored)

## Config & Env Vars

Config file: `.digger/config.json` (path override: `DIGGER_CONFIG`).

Auth, local-repo paths, and the debug flag all live in the config file — no env vars duplicate them. The `.env` file is only used to supply per-machine secrets referenced by `auth.PAT-EnvVarName`. Precedence: actual environment > `.env` file in workspace root. Values in `.env` only fill in vars not already set in the real environment.

Env vars (optional path overrides only — no secrets):
- `DIGGER_CONFIG` — override config file path (default `.digger/config.json`)
- `MANAGED_SOURCE_DIR` — override managed clone dir (default `.digger/source`)
- `CACHE_DIR` — override cache dir (default `.digger/cache`)

## Implementation Status

Progress tracked in [TODO.md](TODO.md). Phase 1 (steps 1–17) is complete. Phase 2 (MCP compliance & security hardening) is mostly complete (4 remaining). Phase 3 (signature output quality) is in progress.
