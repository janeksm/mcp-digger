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
| 10 | `index.ts` | — | | DRY version: read from package.json instead of hardcoding in McpServer constructor |

**Statuses:** `—` not started, `in-progress` active, `done` committed, `blocked` waiting on something
