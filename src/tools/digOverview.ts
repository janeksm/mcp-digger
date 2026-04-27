import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { z } from "zod";
import {
  invalidate,
  isFresh,
  markFresh,
  readOverview,
  writeOverview,
} from "../cacheManager.js";
import type { DiggerConfig, PackageConfig } from "../config.js";
import { formatUnknownRepo } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { extractOverview } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Digs the surface of a single repository's internal NuGet shared libraries.
Returns a markdown overview including: purpose of each package, key public types
and interfaces (summarised), architectural conventions, and usage patterns.
Call dig_list first to discover available repos, then call this with a repo name.
If you need to dig deeper — precise method signatures, generics, or parameter
types — call dig_signatures instead.`;

// ── Public API ──

export function registerDigOverview(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_overview",
    {
      title: "Dig Overview",
      description: DESCRIPTION,
      inputSchema: {
        repoName: z.string().describe("Name of the repository to overview (as shown by dig_list)"),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ repoName }) =>
      toCallToolResult(await digOverview(config, repoName)),
  );
}

/** Never throws — returns a usable response even when the repo is unreachable. */
export async function digOverview(
  config: DiggerConfig,
  repoName: string,
): Promise<ToolResult> {
  debug("digOverview", "called for repo", repoName);

  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return toolError(formatUnknownRepo(config, repoName));

  return withRepoLock(repo.name, async () => {
    const sections: string[] = [];
    const warnings: string[] = [];
    let hasContent: boolean;

    try {
      const result = await ensureReady(repo, config);
      if (result.warning) warnings.push(result.warning);

      if (result.error) {
        error("digOverview", `repo '${repo.name}':`, result.error);
        warnings.push(`Repo '${repo.name}': ${result.error}`);
        sections.push(
          `## ${repo.name}\n\n*${result.error.split("\n")[0]}*\n\n${result.error}`,
        );
        hasContent = await appendStaleFallback(sections, repo.packages, result.error);
      } else {
        const fresh = await isFresh(
          config.cacheDir,
          repo.name,
          result.currentHash,
        );

        if (!fresh) {
          await invalidate(config.cacheDir, repo.name, repo.packages);
        }

        const overviews = await Promise.all(
          repo.packages.map(async (pkg) => {
            try {
              const cached = fresh ? await readOverview(pkg) : undefined;
              if (cached !== undefined) return cached;

              const overview = await extractOverview(
                result.sourcePath,
                pkg,
                result.currentHash,
              );
              await writeOverview(pkg, overview);
              return overview;
            } catch (pkgErr) {
              const msg = pkgErr instanceof Error ? pkgErr.message : String(pkgErr);
              error("digOverview", `package '${pkg.name}' overview generation failed:`, msg);
              return `## ${pkg.name}\n\n*Error generating overview.* ${msg}\n`;
            }
          }),
        );
        sections.push(...overviews);
        hasContent = true;

        if (!fresh) {
          await markFresh(config.cacheDir, repo.name, result.currentHash);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digOverview", `repo '${repo.name}':`, msg);
      warnings.push(`Repo '${repo.name}': ${msg}`);
      hasContent = await appendStaleFallback(sections, repo.packages, msg);
    }

    if (warnings.length > 0) {
      sections.push("---\n\n## Warnings\n");
      for (const w of warnings) {
        sections.push(`- ${w}`);
      }
      sections.push("");
    }

    const output = sections.join("\n\n").trimEnd();
    if (!output) return toolSuccess(`No packages in repo '${repoName}'.`);
    return hasContent ? toolSuccess(output) : toolError(output);
  });
}

// ── Internal ──

async function appendStaleFallback(
  sections: string[],
  packages: readonly PackageConfig[],
  errorMsg: string,
): Promise<boolean> {
  let foundStale = false;
  for (const pkg of packages) {
    const stale = await readOverview(pkg);
    if (stale) {
      sections.push(stale);
      foundStale = true;
    } else {
      sections.push(
        `## ${pkg.name}\n\n*Source unavailable.* ${errorMsg}\n`,
      );
    }
  }
  return foundStale;
}
