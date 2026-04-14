# mcp-digger — Implementation Progress

> Tracks step-by-step progress for the implementation plan defined in [INIT_PLAN.md](INIT_PLAN.md).
> Use `/accept <step>` to finalize a step (commit + mark done).

| Step | Module | Status | Commit | Notes |
|------|--------|--------|--------|-------|
| 1 | `config.ts` | done | b9f5d02 | Config file parsing, env merging, validation, auth strategy |
| 2 | `gitClient.ts` | done | f45eb90 | Git CLI wrappers, hybrid auth (unauthenticated-first + PAT fallback) |
| 3 | `repoManager.ts` | done | 0a7ead6 | Mode A/B logic, ensureReady, discoverPackages for auto repos |
| 4 | `cacheManager.ts` | done | db8549f | Per-repo meta.json, freshness by commit hash, cache read/write |
| 5 | `sourceExtractor.ts` | — | | Overview markdown generation, .cs signature stripping |
| 6 | `tools/digOverview.ts` | — | | Level 1 MCP tool — package overview |
| 7 | `tools/digSignatures.ts` | — | | Level 2 MCP tool — stripped public signatures |
| 8 | `tools/digFile.ts` | — | | Level 3 MCP tool — full file source |
| 9 | `index.ts` | — | | MCP server entry point, register all tools |

**Statuses:** `—` not started, `in-progress` active, `done` committed, `blocked` waiting on something
