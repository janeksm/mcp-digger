import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractErrorMessage, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { invalidate, readCachedHash } from "../cacheManager.js";
import type { DiggerConfig, RepoConfig } from "../config.js";
import { formatUnknownRepo } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";

// ── Tool description (shown to the MCP client / agent) ──

const DESCRIPTION = `Force-refreshes cached indexes for one or all repositories.
Use when search results seem wrong, after mcp-digger was upgraded,
or when you get "no matches" and want to rule out stale cache.
For managed repos: fetches latest from remote, then clears all cached indexes.
For local repos: re-reads HEAD, then clears all cached indexes.
Subsequent tool calls (dig_lookup, dig_signatures, etc.) rebuild indexes lazily.`;

const REFRESH_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ── Public API ──

export function registerDigRefresh(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_refresh",
    {
      title: "Dig Refresh",
      description: DESCRIPTION,
      inputSchema: {
        repoName: z.string().optional().describe(
          "Name of the repository to refresh (as shown by dig_list). Omit to refresh all repos.",
        ),
      },
      annotations: REFRESH_ANNOTATIONS,
    },
    async ({ repoName }) =>
      toCallToolResult(await digRefresh(config, repoName)),
  );
}

export async function digRefresh(
  config: DiggerConfig,
  repoName: string | undefined,
): Promise<ToolResult> {
  if (repoName !== undefined) {
    const repo = config.repos.find((r) => r.name === repoName);
    if (!repo) return toolError(formatUnknownRepo(config, repoName));
    const result = await refreshRepo(repo, config);
    return toolSuccess(formatSummary([result]));
  }

  const results: RepoRefreshResult[] = [];
  for (const repo of config.repos) {
    results.push(await refreshRepo(repo, config));
  }
  return toolSuccess(formatSummary(results));
}

// ── Internal ──

interface RepoRefreshResult {
  repoName: string;
  mode: "local" | "managed";
  oldHash: string | undefined;
  newHash: string | undefined;
  packageCount: number;
  error?: string;
}

async function refreshRepo(
  repo: RepoConfig,
  config: DiggerConfig,
): Promise<RepoRefreshResult> {
  return withRepoLock(repo.name, async () => {
    const oldHash = await readCachedHash(config.cacheDir, repo.name);

    try {
      debug("digRefresh", "refreshing", repo.name);
      const ready = await ensureReady(repo, config);

      if (ready.error) {
        return {
          repoName: repo.name,
          mode: ready.mode,
          oldHash,
          newHash: ready.currentHash || undefined,
          packageCount: repo.packages.length,
          error: ready.error,
        };
      }

      await invalidate(config.cacheDir, repo.name, repo.packages);

      debug("digRefresh", repo.name, "cache invalidated",
        "old=" + (oldHash?.slice(0, 8) ?? "none"),
        "new=" + ready.currentHash.slice(0, 8));

      return {
        repoName: repo.name,
        mode: ready.mode,
        oldHash,
        newHash: ready.currentHash,
        packageCount: repo.packages.length,
      };
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digRefresh", `repo '${repo.name}':`, msg);
      return {
        repoName: repo.name,
        mode: repo.localPath ? "local" : "managed",
        oldHash,
        newHash: undefined,
        packageCount: repo.packages.length,
        error: msg,
      };
    }
  });
}

function formatSummary(results: RepoRefreshResult[]): string {
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  const lines: string[] = [];
  lines.push("# dig_refresh");
  lines.push("");

  if (ok.length > 0) {
    const totalPkgs = ok.reduce((sum, r) => sum + r.packageCount, 0);
    lines.push(
      `Refreshed ${ok.length} repo${ok.length === 1 ? "" : "s"} (${totalPkgs} package${totalPkgs === 1 ? "" : "s"}). ` +
      "Indexes will rebuild on next tool call.",
    );
  }

  if (failed.length > 0 && ok.length > 0) {
    lines.push(`${failed.length} repo${failed.length === 1 ? "" : "s"} failed (see below).`);
  } else if (failed.length > 0 && ok.length === 0) {
    lines.push("All repos failed to refresh.");
  }

  for (const r of ok) {
    lines.push("");
    lines.push(`## ${r.repoName} (${r.mode})`);
    lines.push("");
    lines.push(`- Packages: ${r.packageCount}`);

    const oldLabel = r.oldHash?.slice(0, 8) ?? "none";
    const newLabel = r.newHash!.slice(0, 8);
    if (oldLabel === newLabel) {
      lines.push(`- Commit: ${newLabel} (unchanged — forced re-index)`);
    } else {
      lines.push(`- Commit: ${oldLabel} → ${newLabel}`);
    }

    lines.push("- Cache cleared");
  }

  for (const r of failed) {
    lines.push("");
    lines.push(`## ${r.repoName} (${r.mode})`);
    lines.push("");
    lines.push(`- Error: ${r.error}`);
  }

  return lines.join("\n");
}
