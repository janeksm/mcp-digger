import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, extractErrorMessage, requirePackage, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readIndex,
  writeIndex,
} from "../cacheManager.js";
import type { DiggerConfig, PackageConfig } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureAllReady, ensureReady } from "../repoManager.js";
import {
  extractIndex,
  serializeIndex,
  parseIndex,
  searchReferences,
  formatEntryDisplay,
  scoreSymbolMatch,
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
types or methods, then dig_file to read the full source of a matched file.

Cost: symbol/implements modes are the fastest search — cached index, no source reading. References mode scans source files and is heavier. Prefer over dig_signatures when you only need to locate files.`;

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
  "Exact name of the NuGet package (e.g. 'MyCompany.Core'). Omit to search all packages.",
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
    return crossPackageIndexSearch(config, keyword, SYMBOL_SEARCH_OPTS);
  }

  debug("digLookup", "called for", packageName, "keyword=", keyword);
  const resolved = requirePackage(config, packageName);
  if ("text" in resolved) return resolved;
  const { pkg, repo } = resolved;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);
      if (!fresh) await invalidate(config.cacheDir, repo.name, repo.packages);

      const entries = await ensurePackageIndex(result.sourcePath, pkg, fresh);
      if (!fresh) await markFresh(config.cacheDir, repo.name, result.currentHash);

      if (entries.length === 0) {
        return toolSuccess(`# ${packageName}\n\nNo .cs source files found.`);
      }

      const matches = searchIndex(entries, keyword);
      if (matches.length === 0) {
        return toolSuccess(
          `# ${packageName} — lookup: "${keyword}"\n\n` +
          `No matches for '${keyword}'. Try a broader term, call dig_package_overview to see available types, or call dig_refresh to force a re-index.`,
        );
      }

      return toolSuccess(formatMatches(packageName, keyword, matches));
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digLookup", `package '${packageName}':`, msg);
      const stale = await readIndex(pkg);
      if (stale) {
        try {
          const entries = parseIndex(stale);
          const matches = searchIndex(entries, keyword);
          if (matches.length > 0) {
            return toolSuccess(
              formatMatches(packageName, keyword, matches) +
              `\n\n---\n\n> **Warning:** Index may be stale. ${msg}`,
            );
          }
        } catch (parseErr) {
          error(
            "digLookup",
            `stale index parse failed for '${packageName}':`,
            extractErrorMessage(parseErr),
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

// ── Index helpers ──

async function ensurePackageIndex(
  sourcePath: string,
  pkg: PackageConfig,
  fresh: boolean,
): Promise<IndexEntry[]> {
  const indexRaw = fresh ? await readIndex(pkg) : undefined;
  if (indexRaw !== undefined) return parseIndex(indexRaw);

  const entries = await extractIndex(sourcePath, pkg);
  if (entries.length > 0) {
    await writeIndex(pkg, serializeIndex(entries));
  }
  return entries;
}

// ── Search functions ──

const MAX_CROSS_PACKAGE_MATCHES = 100;

interface PackageMatches {
  packageName: string;
  matches: IndexEntry[];
}

function searchIndex(entries: IndexEntry[], keyword: string): IndexEntry[] {
  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreSymbolMatch(entry.symbol, keyword);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || (b.entry.refCount ?? 0) - (a.entry.refCount ?? 0)
    || a.entry.symbol.localeCompare(b.entry.symbol),
  );
  return scored.map((s) => s.entry);
}

function searchIndexForImplementors(entries: IndexEntry[], keyword: string): IndexEntry[] {
  const lower = keyword.toLowerCase();
  return entries.filter(
    (e) => e.baseTypes?.some((bt) => bt.toLowerCase() === lower) ?? false,
  );
}

// ── Contextual hint builders ──

function buildSymbolHints(matches: IndexEntry[], isCrossPackage: boolean): string[] {
  const hints: string[] = [];
  if (matches.some((m) => m.kind === "interface")) {
    hints.push('**Tip:** Found interface — use `dig_lookup` with `mode: "implements"` to find implementations.');
  }
  if (matches.length === 1) {
    hints.push("Single match — use `dig_signatures` for API surface or `dig_file` for full source.");
  } else if (matches.length >= 50) {
    const narrow = isCrossPackage
      ? "specify `packageName` or use a more specific keyword"
      : "use a more specific keyword";
    hints.push(`Many matches — ${narrow}.`);
  } else {
    hints.push("Use `dig_signatures` for API surface or `dig_file` for full source.");
  }
  return hints;
}

function buildImplementsHints(matches: IndexEntry[]): string[] {
  if (matches.length === 1) {
    return ["Single implementor — use `dig_signatures` for API surface or `dig_file` for full source."];
  }
  return ["Use `dig_signatures` for API surface or `dig_file` for full source."];
}

function buildReferencesHints(totalFiles: number): string[] {
  if (totalFiles === 1) {
    return ["Single file — use `dig_file` to read source."];
  }
  return ["Use `dig_file` with the specific packageName and file path to read source."];
}

function buildCrossReferencesHints(totalFiles: number): string[] {
  if (totalFiles === 1) {
    return ["Single file — use `dig_file` with the specific packageName and file path to read source."];
  }
  return ["Use `dig_file` with the specific packageName and file path to inspect each reference."];
}

// ── Single-package formatting ──

function formatMatchLine(m: IndexEntry): string {
  if (m.kind === "method") {
    return `- **${m.symbol}** (method on ${m.parentType}) — \`${m.filePath}\``;
  }
  const { displayName, kindLabel } = formatEntryDisplay(m);
  return `- **${displayName}** (${kindLabel}) — \`${m.filePath}\``;
}

function formatImplementsMatchLine(m: IndexEntry): string {
  const { displayName, kindLabel } = formatEntryDisplay(m);
  const bases = m.baseTypes?.join(", ") ?? "";
  const baseSuffix = bases ? ` : ${bases}` : "";
  return `- **${displayName}** (${kindLabel})${baseSuffix} — \`${m.filePath}\``;
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
  lines.push(...buildSymbolHints(matches, false));

  return lines.join("\n");
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
  lines.push(...buildImplementsHints(matches));
  return lines.join("\n");
}

// ── Cross-package index search (shared by symbol + implements modes) ──

interface CrossPackageIndexOpts {
  modeLabel: string;
  debugLabel: string;
  searchFn: (entries: IndexEntry[], keyword: string) => IndexEntry[];
  formatLineFn: (m: IndexEntry) => string;
  countNoun: string;
  noMatchMsg: (keyword: string) => string;
  buildHints: (allMatches: IndexEntry[]) => string[];
}

const SYMBOL_SEARCH_OPTS: CrossPackageIndexOpts = {
  modeLabel: "lookup",
  debugLabel: "cross-package search",
  searchFn: searchIndex,
  formatLineFn: formatMatchLine,
  countNoun: "match",
  noMatchMsg: (kw) => `No matches for '${kw}' across any package. Try a broader term, call dig_list to see available packages, or call dig_refresh to force a re-index.`,
  buildHints: (allMatches) => buildSymbolHints(allMatches, true),
};

const IMPLEMENTS_SEARCH_OPTS: CrossPackageIndexOpts = {
  modeLabel: "implements",
  debugLabel: "cross-package implements",
  searchFn: searchIndexForImplementors,
  formatLineFn: formatImplementsMatchLine,
  countNoun: "implementor",
  noMatchMsg: (kw) => `No types implementing '${kw}' found across any package. Verify the exact type name or call dig_refresh to force a re-index.`,
  buildHints: (allMatches) => buildImplementsHints(allMatches),
};

async function crossPackageIndexSearch(
  config: DiggerConfig,
  keyword: string,
  opts: CrossPackageIndexOpts,
): Promise<ToolResult> {
  debug("digLookup", opts.debugLabel, "keyword=", keyword);

  const readyResults = await ensureAllReady(config);

  const allResults: PackageMatches[] = [];
  const warnings: string[] = [];
  let totalMatches = 0;
  let capped = false;

  for (const repo of config.repos) {
    const ready = readyResults.get(repo.name);

    if (!ready || ready.error) {
      warnings.push(`${repo.name}: ${ready?.error ?? "repo resolution failed"}`);
      await collectStaleResults(repo.packages, keyword, opts.searchFn, allResults);
      continue;
    }

    try {
      const repoMatches = await withRepoLock(repo.name, async () => {
        const fresh = await isFresh(config.cacheDir, repo.name, ready.currentHash);
        if (!fresh) await invalidate(config.cacheDir, repo.name, repo.packages);

        const matches: PackageMatches[] = [];
        for (const pkg of repo.packages) {
          const entries = await ensurePackageIndex(ready.sourcePath, pkg, fresh);
          const pkgMatches = opts.searchFn(entries, keyword);
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
      const msg = extractErrorMessage(err);
      error("digLookup", `${opts.modeLabel} repo '${repo.name}':`, msg);
      warnings.push(`${repo.name}: ${msg}`);
      await collectStaleResults(repo.packages, keyword, opts.searchFn, allResults);
    }
  }

  if (allResults.length === 0 && warnings.length > 0) {
    return toolError(
      `# Cross-package ${opts.modeLabel}: "${keyword}"\n\nLookup failed.\n\n` +
      warnings.map((w) => `- ${w}`).join("\n"),
    );
  }

  if (allResults.length === 0) {
    return toolSuccess(
      `# Cross-package ${opts.modeLabel}: "${keyword}"\n\n${opts.noMatchMsg(keyword)}`,
    );
  }

  return toolSuccess(formatCrossPackageIndexResults(keyword, allResults, totalMatches, capped, warnings, opts));
}

async function collectStaleResults(
  packages: PackageConfig[],
  keyword: string,
  searchFn: (entries: IndexEntry[], keyword: string) => IndexEntry[],
  results: PackageMatches[],
): Promise<void> {
  for (const pkg of packages) {
    const stale = await readIndex(pkg);
    if (!stale) continue;
    try {
      const entries = parseIndex(stale);
      const pkgMatches = searchFn(entries, keyword);
      if (pkgMatches.length > 0) {
        results.push({ packageName: pkg.name, matches: pkgMatches });
      }
    } catch (parseErr) {
      error(
        "digLookup",
        `stale index parse failed for '${pkg.name}':`,
        extractErrorMessage(parseErr),
      );
    }
  }
}

function formatCrossPackageIndexResults(
  keyword: string,
  results: PackageMatches[],
  totalMatches: number,
  capped: boolean,
  warnings: string[],
  opts: CrossPackageIndexOpts,
): string {
  const lines: string[] = [];
  lines.push(`# Cross-package ${opts.modeLabel}: "${keyword}"`);
  lines.push("");

  const countLabel = capped
    ? `first ${MAX_CROSS_PACKAGE_MATCHES} of ${totalMatches}+`
    : String(totalMatches);
  lines.push(
    `Found ${countLabel} ${opts.countNoun}${totalMatches === 1 ? "" : "s"} across ${results.length} package${results.length === 1 ? "" : "s"}:`,
  );

  const allMatches = results.flatMap((r) => r.matches);

  for (const { packageName, matches } of results) {
    lines.push("");
    lines.push(`## ${packageName}`);
    lines.push("");
    for (const m of matches) lines.push(opts.formatLineFn(m));
  }

  lines.push("");
  lines.push(...opts.buildHints(allMatches));

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

// ── Implements mode ──

async function digLookupImplements(
  config: DiggerConfig,
  packageName: string | undefined,
  keyword: string,
): Promise<ToolResult> {
  if (packageName === undefined) {
    return crossPackageIndexSearch(config, keyword, IMPLEMENTS_SEARCH_OPTS);
  }

  debug("digLookup", "implements mode for", packageName, "keyword=", keyword);
  const resolved = requirePackage(config, packageName);
  if ("text" in resolved) return resolved;
  const { pkg, repo } = resolved;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);
      if (!fresh) await invalidate(config.cacheDir, repo.name, repo.packages);

      const entries = await ensurePackageIndex(result.sourcePath, pkg, fresh);
      if (!fresh) await markFresh(config.cacheDir, repo.name, result.currentHash);

      if (entries.length === 0) {
        return toolSuccess(`# ${packageName} — implements: "${keyword}"\n\nNo .cs source files found.`);
      }

      const matches = searchIndexForImplementors(entries, keyword);
      if (matches.length === 0) {
        return toolSuccess(
          `# ${packageName} — implements: "${keyword}"\n\n` +
          `No types implementing '${keyword}' found. Try omitting packageName to search cross-package, or call dig_refresh to force a re-index.`,
        );
      }

      return toolSuccess(formatImplementsResults(packageName, keyword, matches));
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digLookup", `implements '${packageName}':`, msg);
      const stale = await readIndex(pkg);
      if (stale) {
        try {
          const entries = parseIndex(stale);
          const matches = searchIndexForImplementors(entries, keyword);
          if (matches.length > 0) {
            return toolSuccess(
              formatImplementsResults(packageName, keyword, matches) +
              `\n\n---\n\n> **Warning:** Index may be stale. ${msg}`,
            );
          }
        } catch (parseErr) {
          error(
            "digLookup",
            `stale index parse failed for '${packageName}':`,
            extractErrorMessage(parseErr),
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
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
  const resolved = requirePackage(config, packageName);
  if ("text" in resolved) return resolved;
  const { pkg, repo } = resolved;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const refs = await searchReferences(result.sourcePath, pkg, keyword, MAX_REFERENCE_FILES);

      if (refs.length === 0) {
        return toolSuccess(
          `# ${packageName} — references: "${keyword}"\n\n` +
          `No references to '${keyword}' found. Try omitting packageName to search cross-package, or call dig_refresh to force a re-index.`,
        );
      }

      return toolSuccess(formatReferencesResults(packageName, keyword, refs));
    } catch (err) {
      const msg = extractErrorMessage(err);
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
  lines.push(...buildReferencesHints(refs.length));
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
      warnings.push(`${repo.name}: ${ready?.error ?? "repo resolution failed"}`);
      continue;
    }

    try {
      const repoRefs = await withRepoLock(repo.name, async () => {
        const results: PackageReferences[] = [];
        let localTotal = 0;
        for (const pkg of repo.packages) {
          const remaining = MAX_REFERENCE_FILES - totalFiles - localTotal;
          if (remaining <= 0) break;
          const refs = await searchReferences(ready.sourcePath, pkg, keyword, remaining);
          if (refs.length > 0) {
            localTotal += refs.length;
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
      const msg = extractErrorMessage(err);
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
      `No references to '${keyword}' found across any package. Verify the exact type name or call dig_refresh to force a re-index.`,
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
  lines.push(...buildCrossReferencesHints(totalFiles));

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
