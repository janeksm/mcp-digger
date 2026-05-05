import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readIndex,
  writeIndex,
} from "../cacheManager.js";
import type { DiggerConfig, PackageConfig } from "../config.js";
import { findPackage, formatUnknownPackage } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureAllReady, ensureReady } from "../repoManager.js";
import { extractIndex, serializeIndex, parseIndex, type IndexEntry } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Searches type and method indexes for a keyword.
Use this when you know a type or method name (or part of it) and need to find
which file contains it. Returns matching symbol declarations with their file paths.
Provide packageName to search within a specific package, or omit it to search
across ALL packages — useful when you don't know which package contains a type.
Call dig_package_overview first to understand a package, then dig_lookup to locate specific
types or methods, then dig_file to read the full source of a matched file.`;

const KEYWORD_PARAM = z.string().describe(
  "Type name, method name, or keyword to search for in the package index (e.g. 'IOrderService', 'GetByIdAsync')",
);

// ── Public API ──

const OPTIONAL_PACKAGE_NAME_PARAM = PACKAGE_NAME_PARAM.optional().describe(
  "Exact name of the internal NuGet package (e.g. 'MyCompany.Core'). Omit to search all packages.",
);

export function registerDigLookup(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_lookup",
    {
      title: "Dig Lookup",
      description: DESCRIPTION,
      inputSchema: {
        packageName: OPTIONAL_PACKAGE_NAME_PARAM,
        keyword: KEYWORD_PARAM,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ packageName, keyword }) =>
      toCallToolResult(await digLookup(config, packageName, keyword)),
  );
}

export async function digLookup(
  config: DiggerConfig,
  packageName: string | undefined,
  keyword: string,
): Promise<ToolResult> {
  if (packageName === undefined) {
    return digLookupAllPackages(config, keyword);
  }

  debug("digLookup", "called for", packageName, "keyword=", keyword);
  const pkg = findPackage(config, packageName);
  if (!pkg) return toolError(formatUnknownPackage(config, packageName));

  const repo = config.repos.find((r) => r.name === pkg.repoName)!;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);

      const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);

      if (!fresh) {
        await invalidate(config.cacheDir, repo.name, repo.packages);
      }

      let indexRaw = fresh ? await readIndex(pkg) : undefined;

      if (indexRaw === undefined) {
        const entries = await extractIndex(result.sourcePath, pkg);

        if (entries.length === 0) {
          if (!fresh) {
            await markFresh(config.cacheDir, repo.name, result.currentHash);
          }
          return toolSuccess(`# ${packageName}\n\nNo .cs source files found.`);
        }

        indexRaw = serializeIndex(entries);
        await writeIndex(pkg, indexRaw);

        if (!fresh) {
          await markFresh(config.cacheDir, repo.name, result.currentHash);
        }
      }

      const entries = parseIndex(indexRaw);
      const matches = searchIndex(entries, keyword);

      if (matches.length === 0) {
        return toolSuccess(
          `# ${packageName} — lookup: "${keyword}"\n\n` +
          `No matches for '${keyword}'. Try a broader term or call dig_package_overview to see available types.`,
        );
      }

      return toolSuccess(formatMatches(packageName, keyword, matches));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `package '${packageName}':`, msg);
      const stale = await readIndex(pkg);
      if (stale) {
        const entries = parseIndex(stale);
        const matches = searchIndex(entries, keyword);
        if (matches.length > 0) {
          return toolSuccess(
            formatMatches(packageName, keyword, matches) +
            `\n\n---\n\n> **Warning:** Index may be stale. ${msg}`,
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

// ── Internal ──

const MAX_CROSS_PACKAGE_MATCHES = 100;

interface PackageMatches {
  packageName: string;
  matches: IndexEntry[];
}

function searchIndex(entries: IndexEntry[], keyword: string): IndexEntry[] {
  const lower = keyword.toLowerCase();
  return entries.filter((e) => e.symbol.toLowerCase().includes(lower));
}

function formatMatches(
  packageName: string,
  keyword: string,
  matches: IndexEntry[],
): string {
  const lines: string[] = [];
  lines.push(`# ${packageName} — lookup: "${keyword}"`);
  lines.push("");
  lines.push(`Found ${matches.length} match${matches.length === 1 ? "" : "es"}:`);
  lines.push("");

  for (const m of matches) {
    lines.push(formatMatchLine(m));
  }

  lines.push("");
  lines.push(`Use dig_file with packageName "${packageName}" and the file path to read full source.`);

  return lines.join("\n");
}

function formatMatchLine(m: IndexEntry): string {
  if (m.kind === "method") {
    return `- **${m.symbol}** (method on ${m.parentType}) — \`${m.filePath}\``;
  }
  return `- **${m.symbol}** (${m.kind}) — \`${m.filePath}\``;
}

async function digLookupAllPackages(
  config: DiggerConfig,
  keyword: string,
): Promise<ToolResult> {
  debug("digLookup", "cross-package search keyword=", keyword);

  const readyResults = await ensureAllReady(config);

  const allResults: PackageMatches[] = [];
  const warnings: string[] = [];
  let totalMatches = 0;
  let capped = false;

  for (const repo of config.repos) {
    const ready = readyResults.get(repo.name);

    if (!ready || ready.error) {
      const errMsg = ready?.error ?? "repo resolution failed";
      warnings.push(`${repo.name}: ${errMsg}`);
      await collectStaleMatches(repo.packages, keyword, allResults);
      continue;
    }

    try {
      const repoMatches = await withRepoLock(repo.name, async () => {
        const fresh = await isFresh(config.cacheDir, repo.name, ready.currentHash);
        if (!fresh) {
          await invalidate(config.cacheDir, repo.name, repo.packages);
        }

        const matches: PackageMatches[] = [];
        for (const pkg of repo.packages) {
          let indexRaw = fresh ? await readIndex(pkg) : undefined;

          if (indexRaw === undefined) {
            const entries = await extractIndex(ready.sourcePath, pkg);
            if (entries.length === 0) continue;
            indexRaw = serializeIndex(entries);
            await writeIndex(pkg, indexRaw);
          }

          const entries = parseIndex(indexRaw);
          const pkgMatches = searchIndex(entries, keyword);
          if (pkgMatches.length > 0) {
            matches.push({ packageName: pkg.name, matches: pkgMatches });
          }
        }

        if (!fresh) {
          await markFresh(config.cacheDir, repo.name, ready.currentHash);
        }

        return matches;
      });

      for (const m of repoMatches) {
        totalMatches += m.matches.length;
        allResults.push(m);
        if (totalMatches >= MAX_CROSS_PACKAGE_MATCHES) {
          capped = true;
          break;
        }
      }
      if (capped) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `repo '${repo.name}':`, msg);
      warnings.push(`${repo.name}: ${msg}`);
      await collectStaleMatches(repo.packages, keyword, allResults);
    }
  }

  if (allResults.length === 0 && warnings.length > 0) {
    return toolError(
      `# Cross-package lookup: "${keyword}"\n\nLookup failed.\n\n` +
      warnings.map((w) => `- ${w}`).join("\n"),
    );
  }

  if (allResults.length === 0) {
    return toolSuccess(
      `# Cross-package lookup: "${keyword}"\n\n` +
      `No matches for '${keyword}' across any package. Try a broader term or call dig_list to see available packages.`,
    );
  }

  return toolSuccess(formatCrossPackageResults(keyword, allResults, totalMatches, capped, warnings));
}

async function collectStaleMatches(
  packages: PackageConfig[],
  keyword: string,
  results: PackageMatches[],
): Promise<void> {
  for (const pkg of packages) {
    const stale = await readIndex(pkg);
    if (stale) {
      const entries = parseIndex(stale);
      const pkgMatches = searchIndex(entries, keyword);
      if (pkgMatches.length > 0) {
        results.push({ packageName: pkg.name, matches: pkgMatches });
      }
    }
  }
}

function formatCrossPackageResults(
  keyword: string,
  results: PackageMatches[],
  totalMatches: number,
  capped: boolean,
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Cross-package lookup: "${keyword}"`);
  lines.push("");

  const countLabel = capped
    ? `first ${MAX_CROSS_PACKAGE_MATCHES} of ${totalMatches}+`
    : String(totalMatches);
  lines.push(
    `Found ${countLabel} match${totalMatches === 1 ? "" : "es"} across ${results.length} package${results.length === 1 ? "" : "s"}:`,
  );

  for (const { packageName, matches } of results) {
    lines.push("");
    lines.push(`## ${packageName}`);
    lines.push("");
    for (const m of matches) {
      lines.push(formatMatchLine(m));
    }
  }

  lines.push("");
  lines.push("Use dig_file or dig_signatures with the specific packageName and file path to read source.");

  if (capped) {
    lines.push("");
    lines.push(`> **Note:** Results capped at ${MAX_CROSS_PACKAGE_MATCHES}. Narrow your keyword or specify a packageName.`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("> **Warnings:**");
    for (const w of warnings) {
      lines.push(`> - ${w}`);
    }
  }

  return lines.join("\n");
}
