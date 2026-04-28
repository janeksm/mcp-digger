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
import type { DiggerConfig } from "../config.js";
import { findPackage, formatUnknownPackage } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { extractIndex, serializeIndex, parseIndex, type IndexEntry } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Searches a package's type and method index for a keyword.
Use this when you know a type or method name (or part of it) and need to find
which file contains it. Returns matching symbol declarations with their file paths.
Call dig_overview first to understand the package, then dig_lookup to locate specific
types or methods, then dig_file to read the full source of a matched file.`;

const KEYWORD_PARAM = z.string().describe(
  "Type name, method name, or keyword to search for in the package index (e.g. 'IOrderService', 'GetByIdAsync')",
);

// ── Public API ──

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
        packageName: PACKAGE_NAME_PARAM,
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
  packageName: string,
  keyword: string,
): Promise<ToolResult> {
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
          `No matches for '${keyword}'. Try a broader term or call dig_overview to see available types.`,
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
    if (m.kind === "method") {
      lines.push(`- **${m.symbol}** (method on ${m.parentType}) — \`${m.filePath}\``);
    } else {
      lines.push(`- **${m.symbol}** (${m.kind}) — \`${m.filePath}\``);
    }
  }

  lines.push("");
  lines.push(`Use dig_file with packageName "${packageName}" and the file path to read full source.`);

  return lines.join("\n");
}
