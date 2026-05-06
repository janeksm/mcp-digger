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
import {
  extractIndex,
  serializeIndex,
  parseIndex,
  searchReferences,
  formatEntryDisplay,
  type IndexEntry,
  type FileReference,
} from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Searches type and method indexes for a keyword.
Provide packageName to search within a specific package, or omit it to search
across ALL packages — useful when you don't know which package contains a type.

Supports three search modes via the 'mode' parameter:
- "symbol" (default): match type/method declarations by name substring.
- "implements": find classes/structs that implement a given interface or extend a given base class. Recommended: omit packageName to search cross-package since implementations often live in a different package than the interface.
- "references": find files that reference a given type name in source code (word-boundary, case-sensitive).

Call dig_package_overview first to understand a package, then dig_lookup to locate specific
types or methods, then dig_file to read the full source of a matched file.`;

const KEYWORD_PARAM = z.string().describe(
  "Type name, method name, or keyword to search for (e.g. 'IOrderService', 'GetByIdAsync')",
);

const MODE_PARAM = z.enum(["symbol", "implements", "references"]).optional().describe(
  "Search mode: 'symbol' (default) matches type/method names, " +
  "'implements' finds types implementing/extending a given base type, " +
  "'references' finds files referencing a type name in source code",
);

type LookupMode = "symbol" | "implements" | "references";

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
        mode: MODE_PARAM,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ packageName, keyword, mode }) =>
      toCallToolResult(await digLookup(config, packageName, keyword, mode ?? "symbol")),
  );
}

export async function digLookup(
  config: DiggerConfig,
  packageName: string | undefined,
  keyword: string,
  mode: LookupMode = "symbol",
): Promise<ToolResult> {
  if (mode === "implements") return digLookupImplements(config, packageName, keyword);
  if (mode === "references") return digLookupReferences(config, packageName, keyword);

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
  const { displayName, kindLabel } = formatEntryDisplay(m);
  return `- **${displayName}** (${kindLabel}) — \`${m.filePath}\``;
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

// ── Implements mode ──

function searchIndexForImplementors(entries: IndexEntry[], keyword: string): IndexEntry[] {
  const lower = keyword.toLowerCase();
  return entries.filter(
    (e) => e.baseTypes?.some((bt) => bt.toLowerCase() === lower) ?? false,
  );
}

function formatImplementsMatchLine(m: IndexEntry): string {
  const { displayName, kindLabel } = formatEntryDisplay(m);
  const bases = m.baseTypes?.join(", ") ?? "";
  const baseSuffix = bases ? ` : ${bases}` : "";
  return `- **${displayName}** (${kindLabel})${baseSuffix} — \`${m.filePath}\``;
}

async function digLookupImplements(
  config: DiggerConfig,
  packageName: string | undefined,
  keyword: string,
): Promise<ToolResult> {
  if (packageName === undefined) {
    return digLookupImplementsAllPackages(config, keyword);
  }

  debug("digLookup", "implements mode for", packageName, "keyword=", keyword);
  const pkg = findPackage(config, packageName);
  if (!pkg) return toolError(formatUnknownPackage(config, packageName));

  const repo = config.repos.find((r) => r.name === pkg.repoName)!;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);
      if (!fresh) await invalidate(config.cacheDir, repo.name, repo.packages);

      let indexRaw = fresh ? await readIndex(pkg) : undefined;
      if (indexRaw === undefined) {
        const entries = await extractIndex(result.sourcePath, pkg);
        if (entries.length === 0) {
          if (!fresh) await markFresh(config.cacheDir, repo.name, result.currentHash);
          return toolSuccess(`# ${packageName} — implements: "${keyword}"\n\nNo .cs source files found.`);
        }
        indexRaw = serializeIndex(entries);
        await writeIndex(pkg, indexRaw);
        if (!fresh) await markFresh(config.cacheDir, repo.name, result.currentHash);
      }

      const entries = parseIndex(indexRaw);
      const matches = searchIndexForImplementors(entries, keyword);

      if (matches.length === 0) {
        return toolSuccess(
          `# ${packageName} — implements: "${keyword}"\n\n` +
          `No types implementing '${keyword}' found. Try omitting packageName to search cross-package.`,
        );
      }

      return toolSuccess(formatImplementsResults(packageName, keyword, matches));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `implements '${packageName}':`, msg);
      const stale = await readIndex(pkg);
      if (stale) {
        const entries = parseIndex(stale);
        const matches = searchIndexForImplementors(entries, keyword);
        if (matches.length > 0) {
          return toolSuccess(
            formatImplementsResults(packageName, keyword, matches) +
            `\n\n---\n\n> **Warning:** Index may be stale. ${msg}`,
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

function formatImplementsResults(
  packageName: string,
  keyword: string,
  matches: IndexEntry[],
): string {
  const lines: string[] = [];
  lines.push(`# ${packageName} — implements: "${keyword}"`);
  lines.push("");
  lines.push(`Found ${matches.length} implementor${matches.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (const m of matches) lines.push(formatImplementsMatchLine(m));
  lines.push("");
  lines.push(`Use dig_file with packageName "${packageName}" and the file path to read full source.`);
  return lines.join("\n");
}

async function digLookupImplementsAllPackages(
  config: DiggerConfig,
  keyword: string,
): Promise<ToolResult> {
  debug("digLookup", "cross-package implements keyword=", keyword);

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
      await collectStaleImplementors(repo.packages, keyword, allResults);
      continue;
    }

    try {
      const repoMatches = await withRepoLock(repo.name, async () => {
        const fresh = await isFresh(config.cacheDir, repo.name, ready.currentHash);
        if (!fresh) await invalidate(config.cacheDir, repo.name, repo.packages);

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
          const pkgMatches = searchIndexForImplementors(entries, keyword);
          if (pkgMatches.length > 0) {
            matches.push({ packageName: pkg.name, matches: pkgMatches });
          }
        }

        if (!fresh) await markFresh(config.cacheDir, repo.name, ready.currentHash);
        return matches;
      });

      for (const m of repoMatches) {
        totalMatches += m.matches.length;
        allResults.push(m);
        if (totalMatches >= MAX_CROSS_PACKAGE_MATCHES) { capped = true; break; }
      }
      if (capped) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `implements repo '${repo.name}':`, msg);
      warnings.push(`${repo.name}: ${msg}`);
      await collectStaleImplementors(repo.packages, keyword, allResults);
    }
  }

  if (allResults.length === 0 && warnings.length > 0) {
    return toolError(
      `# Cross-package implements: "${keyword}"\n\nLookup failed.\n\n` +
      warnings.map((w) => `- ${w}`).join("\n"),
    );
  }

  if (allResults.length === 0) {
    return toolSuccess(
      `# Cross-package implements: "${keyword}"\n\n` +
      `No types implementing '${keyword}' found across any package. Verify the exact type name.`,
    );
  }

  return toolSuccess(formatCrossPackageImplements(keyword, allResults, totalMatches, capped, warnings));
}

async function collectStaleImplementors(
  packages: PackageConfig[],
  keyword: string,
  results: PackageMatches[],
): Promise<void> {
  for (const pkg of packages) {
    const stale = await readIndex(pkg);
    if (stale) {
      const entries = parseIndex(stale);
      const pkgMatches = searchIndexForImplementors(entries, keyword);
      if (pkgMatches.length > 0) {
        results.push({ packageName: pkg.name, matches: pkgMatches });
      }
    }
  }
}

function formatCrossPackageImplements(
  keyword: string,
  results: PackageMatches[],
  totalMatches: number,
  capped: boolean,
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Cross-package implements: "${keyword}"`);
  lines.push("");

  const countLabel = capped
    ? `first ${MAX_CROSS_PACKAGE_MATCHES} of ${totalMatches}+`
    : String(totalMatches);
  lines.push(
    `Found ${countLabel} implementor${totalMatches === 1 ? "" : "s"} across ${results.length} package${results.length === 1 ? "" : "s"}:`,
  );

  for (const { packageName, matches } of results) {
    lines.push("");
    lines.push(`## ${packageName}`);
    lines.push("");
    for (const m of matches) lines.push(formatImplementsMatchLine(m));
  }

  lines.push("");
  lines.push("Use dig_file or dig_signatures with the specific packageName and file path to read source.");

  if (capped) {
    lines.push("");
    lines.push(`> **Note:** Results capped at ${MAX_CROSS_PACKAGE_MATCHES}. Specify a packageName to narrow search.`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("> **Warnings:**");
    for (const w of warnings) lines.push(`> - ${w}`);
  }

  return lines.join("\n");
}

// ── References mode ──

const MAX_REFERENCE_FILES = 50;

interface PackageReferences {
  packageName: string;
  refs: FileReference[];
  totalOccurrences: number;
}

async function digLookupReferences(
  config: DiggerConfig,
  packageName: string | undefined,
  keyword: string,
): Promise<ToolResult> {
  if (packageName === undefined) {
    return digLookupReferencesAllPackages(config, keyword);
  }

  debug("digLookup", "references mode for", packageName, "keyword=", keyword);
  const pkg = findPackage(config, packageName);
  if (!pkg) return toolError(formatUnknownPackage(config, packageName));

  const repo = config.repos.find((r) => r.name === pkg.repoName)!;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const refs = await searchReferences(result.sourcePath, pkg, keyword, MAX_REFERENCE_FILES);

      if (refs.length === 0) {
        return toolSuccess(
          `# ${packageName} — references: "${keyword}"\n\n` +
          `No references to '${keyword}' found. Try omitting packageName to search cross-package.`,
        );
      }

      return toolSuccess(formatReferencesResults(packageName, keyword, refs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `references '${packageName}':`, msg);
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

function formatReferencesResults(
  packageName: string,
  keyword: string,
  refs: FileReference[],
): string {
  const totalOccurrences = refs.reduce((sum, r) => sum + r.count, 0);
  const lines: string[] = [];
  lines.push(`# ${packageName} — references: "${keyword}"`);
  lines.push("");
  lines.push(`Found ${totalOccurrences} reference${totalOccurrences === 1 ? "" : "s"} in ${refs.length} file${refs.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (const r of refs) {
    const label = r.count === 1 ? "1 occurrence" : `${r.count} occurrences`;
    lines.push(`- \`${r.filePath}\` (${label})`);
  }
  lines.push("");
  lines.push(`Use dig_file with packageName "${packageName}" and the file path to read full source.`);
  return lines.join("\n");
}

async function digLookupReferencesAllPackages(
  config: DiggerConfig,
  keyword: string,
): Promise<ToolResult> {
  debug("digLookup", "cross-package references keyword=", keyword);

  const readyResults = await ensureAllReady(config);

  const allResults: PackageReferences[] = [];
  const warnings: string[] = [];
  let totalFiles = 0;
  let capped = false;

  for (const repo of config.repos) {
    const ready = readyResults.get(repo.name);

    if (!ready || ready.error) {
      const errMsg = ready?.error ?? "repo resolution failed";
      warnings.push(`${repo.name}: ${errMsg}`);
      continue;
    }

    try {
      const repoRefs = await withRepoLock(repo.name, async () => {
        const results: PackageReferences[] = [];
        for (const pkg of repo.packages) {
          const remaining = MAX_REFERENCE_FILES - totalFiles;
          if (remaining <= 0) break;
          const refs = await searchReferences(ready.sourcePath, pkg, keyword, remaining);
          if (refs.length > 0) {
            const totalOcc = refs.reduce((sum, r) => sum + r.count, 0);
            results.push({ packageName: pkg.name, refs, totalOccurrences: totalOcc });
          }
        }
        return results;
      });

      for (const r of repoRefs) {
        totalFiles += r.refs.length;
        allResults.push(r);
        if (totalFiles >= MAX_REFERENCE_FILES) { capped = true; break; }
      }
      if (capped) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digLookup", `references repo '${repo.name}':`, msg);
      warnings.push(`${repo.name}: ${msg}`);
    }
  }

  if (allResults.length === 0 && warnings.length > 0) {
    return toolError(
      `# Cross-package references: "${keyword}"\n\nLookup failed.\n\n` +
      warnings.map((w) => `- ${w}`).join("\n"),
    );
  }

  if (allResults.length === 0) {
    return toolSuccess(
      `# Cross-package references: "${keyword}"\n\n` +
      `No references to '${keyword}' found across any package.`,
    );
  }

  return toolSuccess(formatCrossPackageReferences(keyword, allResults, totalFiles, capped, warnings));
}

function formatCrossPackageReferences(
  keyword: string,
  results: PackageReferences[],
  totalFiles: number,
  capped: boolean,
  warnings: string[],
): string {
  const totalOcc = results.reduce((sum, r) => sum + r.totalOccurrences, 0);
  const lines: string[] = [];
  lines.push(`# Cross-package references: "${keyword}"`);
  lines.push("");

  const fileLabel = capped
    ? `first ${MAX_REFERENCE_FILES} of ${totalFiles}+`
    : String(totalFiles);
  lines.push(
    `Found ${totalOcc} reference${totalOcc === 1 ? "" : "s"} in ${fileLabel} file${totalFiles === 1 ? "" : "s"} across ${results.length} package${results.length === 1 ? "" : "s"}:`,
  );

  for (const { packageName, refs } of results) {
    lines.push("");
    lines.push(`## ${packageName}`);
    lines.push("");
    for (const r of refs) {
      const label = r.count === 1 ? "1 occurrence" : `${r.count} occurrences`;
      lines.push(`- \`${r.filePath}\` (${label})`);
    }
  }

  lines.push("");
  lines.push("Use dig_file or dig_signatures with the specific packageName and file path to read source.");

  if (capped) {
    lines.push("");
    lines.push(`> **Note:** Results capped at ${MAX_REFERENCE_FILES} files. Specify a packageName to narrow search.`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("> **Warnings:**");
    for (const w of warnings) lines.push(`> - ${w}`);
  }

  return lines.join("\n");
}
