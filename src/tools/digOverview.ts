import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readOverview,
  writeOverview,
} from "../cacheManager.js";
import type { DiggerConfig, PackageConfig } from "../config.js";
import { debug } from "../logger.js";
import { ensureAllReady } from "../repoManager.js";
import { extractOverview } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Digs the surface of all configured internal NuGet shared libraries.
Returns a markdown overview including: purpose of each package, key public types
and interfaces (summarised), architectural conventions, and usage patterns.
Call this first before working on any code that uses internal packages.
If you need to dig deeper — precise method signatures, generics, or parameter
types — call dig_signatures instead.`;

// ── Public API ──

/**
 * Register the dig_overview tool on an MCP server.
 */
export function registerDigOverview(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_overview",
    { title: "Dig Overview", description: DESCRIPTION },
    async () => ({
      content: [{ type: "text" as const, text: await digOverview(config) }],
    }),
  );
}

/**
 * Generate the concatenated overview markdown for all configured packages.
 *
 * For each repo:
 * 1. Ensure the repo is on disk and get the current commit hash.
 * 2. If the cache is stale, invalidate and regenerate overviews for all packages.
 * 3. If the cache is fresh but a package overview is missing, generate just that one.
 * 4. Collect all overviews and any warnings into a single markdown response.
 *
 * Never throws — returns a usable response even when repos are unreachable.
 */
export async function digOverview(config: DiggerConfig): Promise<string> {
  debug("digOverview", "called");
  const sections: string[] = [];
  const warnings: string[] = [];

  const results = await ensureAllReady(config);

  for (const repo of config.repos) {
    const result = results.get(repo.name)!;
    if (result.warning) warnings.push(result.warning);

    if (result.error) {
      warnings.push(`Repo '${repo.name}': ${result.error}`);
      sections.push(
        `## ${repo.name}\n\n*${result.error.split("\n")[0]}*\n\n${result.error}`,
      );
      await appendStaleFallback(sections, repo.packages, result.error);
      continue;
    }

    try {
      const fresh = await isFresh(
        config.cacheDir,
        repo.name,
        result.currentHash,
      );

      if (!fresh) {
        await invalidate(config.cacheDir, repo.name, repo.packages);
      }

      // Generate any missing overviews (packages are independent — run in parallel)
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
            return `## ${pkg.name}\n\n*Error generating overview.* ${msg}\n`;
          }
        }),
      );
      sections.push(...overviews);

      if (!fresh) {
        await markFresh(config.cacheDir, repo.name, result.currentHash);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Repo '${repo.name}': ${msg}`);
      await appendStaleFallback(sections, repo.packages, msg);
    }
  }

  if (warnings.length > 0) {
    sections.push("---\n\n## Warnings\n");
    for (const w of warnings) {
      sections.push(`- ${w}`);
    }
    sections.push("");
  }

  const output = sections.join("\n\n").trimEnd();
  return output || "No packages configured.";
}

// ── Internal ──

/** Try reading stale cached overviews; show unavailable message if no cache exists. */
async function appendStaleFallback(
  sections: string[],
  packages: readonly PackageConfig[],
  errorMsg: string,
): Promise<void> {
  for (const pkg of packages) {
    const stale = await readOverview(pkg);
    if (stale) {
      sections.push(stale);
    } else {
      sections.push(
        `## ${pkg.name}\n\n*Source unavailable.* ${errorMsg}\n`,
      );
    }
  }
}
