import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, extractErrorMessage, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { z } from "zod";
import {
  isFresh,
  readOverview,
  writeOverview,
} from "../cacheManager.js";
import type { DiggerConfig } from "../config.js";
import { formatUnknownPackageInRepo, formatUnknownRepo } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { extractOverview } from "../sourceExtractor.js";

// ── Tool description (shown to the MCP client / agent) ──

const DESCRIPTION = `Returns the full overview for a single package in a repository — purpose,
key public types and interfaces (summarised), architectural conventions, and
usage patterns. Call dig_repo_overview first to discover packages in a repo.
If you need to dig deeper — to find which file contains a specific type or
method — call dig_lookup to search the package index.

Cost: medium on first call, cached afterward. Use for package orientation; use dig_lookup directly when you already have a target symbol.`;

// ── Public API ──

export function registerDigPackageOverview(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_package_overview",
    {
      title: "Dig Package Overview",
      description: DESCRIPTION,
      inputSchema: {
        repoName: z.string().describe("Name of the repository (as shown by dig_list)"),
        packageName: PACKAGE_NAME_PARAM,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ repoName, packageName }) =>
      toCallToolResult(await digPackageOverview(config, repoName, packageName)),
  );
}

export async function digPackageOverview(
  config: DiggerConfig,
  repoName: string,
  packageName: string,
): Promise<ToolResult> {
  debug("digPackageOverview", "called for", repoName, packageName);

  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return toolError(formatUnknownRepo(config, repoName));

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);

      if (result.error) {
        // Per-repo error from ensureReady — surface directly. Stale cache
        // fallback is only appropriate for unreachable repos, not for
        // validation errors (not-a-.NET-repo or wildcard zero-match), where
        // returning stale content would mislead the user about what's wrong.
        error("digPackageOverview", `repo '${repo.name}':`, result.error);
        return toolError(result.error);
      }

      const pkg = repo.packages.find((p) => p.name === packageName);
      if (!pkg) return toolError(formatUnknownPackageInRepo(repo.name, packageName, repo.packages));

      const fresh = await isFresh(
        config.cacheDir,
        repo.name,
        result.currentHash,
      );

      const cached = fresh ? await readOverview(pkg) : undefined;
      if (cached !== undefined) return toolSuccess(cached.trimEnd());

      const overview = await extractOverview(
        result.sourcePath,
        pkg,
      );
      await writeOverview(pkg, overview);

      return toolSuccess(overview.trimEnd());
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digPackageOverview", `repo '${repo.name}':`, msg);

      const pkg = repo.packages.find((p) => p.name === packageName);
      const fallback = await staleFallback(pkg);
      return fallback ?? toolError(`Repo '${repo.name}': ${msg}`);
    }
  });
}

// ── Internal ──

async function staleFallback(
  pkg: import("../config.js").PackageConfig | undefined,
): Promise<ToolResult | undefined> {
  if (!pkg) return undefined;
  const stale = await readOverview(pkg);
  if (!stale) return undefined;
  return toolSuccess(
    stale.trimEnd() + "\n\n---\n\n*Showing stale cached content — repo is currently unreachable.*",
  );
}
