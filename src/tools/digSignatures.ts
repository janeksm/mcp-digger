import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, extractErrorMessage, requirePackage, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readIndex,
  readSignatures,
  writeIndex,
  writeSignature,
} from "../cacheManager.js";
import type { DiggerConfig } from "../config.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { extractIndex, extractSignatures, serializeIndex, parseIndex, formatEntryDisplay, type IndexEntry } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Returns stripped C# signatures filtered by keyword.
Searches the package's type and method index, then returns stripped source
for matching files — type declarations, method signatures, property definitions,
and XML doc comments with method bodies replaced by placeholders.
Call this when you need exact method overloads, generic constraints,
interface members, or return types for specific types.
Call dig_package_overview first, then dig_lookup to locate symbols,
then dig_signatures to see their full public API surface.`;

const KEYWORD_PARAM = z.string().describe(
  "Type name, method name, or keyword to search for (e.g. 'EntityBase', 'GetByIdAsync')",
);

const EXACT_MATCH_PARAM = z.boolean().optional().describe(
  "When true, match only exact symbol names (case-insensitive). Default: false (substring match).",
);

// ── Public API ──

export function registerDigSignatures(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_signatures",
    {
      title: "Dig Signatures",
      description: DESCRIPTION,
      inputSchema: {
        packageName: PACKAGE_NAME_PARAM,
        keyword: KEYWORD_PARAM,
        exactMatch: EXACT_MATCH_PARAM,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ packageName, keyword, exactMatch }) =>
      toCallToolResult(await digSignatures(config, packageName, keyword, exactMatch ?? false)),
  );
}

export async function digSignatures(
  config: DiggerConfig,
  packageName: string,
  keyword: string,
  exactMatch: boolean = false,
): Promise<ToolResult> {
  debug("digSignatures", "called for", packageName, "keyword=", keyword, "exactMatch=", exactMatch);
  const resolved = requirePackage(config, packageName);
  if ("text" in resolved) return resolved;
  const { pkg, repo } = resolved;

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);

      const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);

      if (!fresh) {
        await invalidate(config.cacheDir, repo.name, repo.packages);
      }

      let indexEntries: IndexEntry[] | undefined;
      let indexRaw = fresh ? await readIndex(pkg) : undefined;
      let sigsCached = fresh ? await readSignatures(pkg) : [];

      if (indexRaw === undefined && sigsCached.length === 0) {
        const [idx, extracted] = await Promise.all([
          extractIndex(result.sourcePath, pkg),
          extractSignatures(result.sourcePath, pkg, result.currentHash),
        ]);
        indexEntries = idx;
        indexRaw = serializeIndex(idx);
        await Promise.all([
          writeIndex(pkg, indexRaw),
          ...extracted.map((sig) => writeSignature(pkg, sig.filePath, sig.content)),
        ]);
        sigsCached = extracted;
      } else if (indexRaw === undefined) {
        indexEntries = await extractIndex(result.sourcePath, pkg);
        indexRaw = serializeIndex(indexEntries);
        await writeIndex(pkg, indexRaw);
      } else if (sigsCached.length === 0) {
        const extracted = await extractSignatures(result.sourcePath, pkg, result.currentHash);
        await Promise.all(
          extracted.map((sig) => writeSignature(pkg, sig.filePath, sig.content)),
        );
        sigsCached = extracted;
      }

      if (!fresh) {
        await markFresh(config.cacheDir, repo.name, result.currentHash);
      }

      const entries = indexEntries ?? parseIndex(indexRaw);
      const matchedFiles = searchIndexForFiles(entries, keyword, exactMatch);

      if (matchedFiles.size === 0) {
        return toolSuccess(
          `# ${packageName} — signatures: "${keyword}"\n\n` +
          `No matches for '${keyword}'. Try a broader term or call dig_lookup to see available types.`,
        );
      }

      const matchedSigs = sigsCached.filter((s) => matchedFiles.has(s.filePath));

      if (matchedSigs.length === 0) {
        return toolSuccess(`# ${packageName}\n\nNo .cs source files found.`);
      }

      return toolSuccess(formatSignatures(packageName, keyword, matchedSigs, matchedFiles));
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digSignatures", `package '${packageName}':`, msg);

      const [staleIndex, staleSigs] = await Promise.all([
        readIndex(pkg),
        readSignatures(pkg),
      ]);

      if (staleIndex && staleSigs.length > 0) {
        const entries = parseIndex(staleIndex);
        const matchedFiles = searchIndexForFiles(entries, keyword, exactMatch);
        const matchedSigs = staleSigs.filter((s) => matchedFiles.has(s.filePath));

        if (matchedSigs.length > 0) {
          return toolSuccess(
            formatSignatures(packageName, keyword, matchedSigs, matchedFiles) +
            `\n\n---\n\n> **Warning:** Signatures may be stale. ${msg}`,
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

// ── Internal ──

function searchIndexForFiles(
  entries: IndexEntry[],
  keyword: string,
  exactMatch: boolean,
): Map<string, IndexEntry> {
  const lower = keyword.toLowerCase();
  const matched = new Map<string, IndexEntry>();

  for (const entry of entries) {
    const symbolLower = entry.symbol.toLowerCase();
    const isMatch = exactMatch
      ? symbolLower === lower
      : symbolLower.includes(lower);

    if (!isMatch) continue;

    const existing = matched.get(entry.filePath);
    if (!existing || (entry.kind !== "method" && existing.kind === "method")) {
      matched.set(entry.filePath, entry);
    }
  }

  return matched;
}

function formatSignatures(
  packageName: string,
  keyword: string,
  signatures: Array<{ filePath: string; content: string }>,
  matchedFiles: Map<string, IndexEntry>,
): string {
  const lines: string[] = [];
  lines.push(`# ${packageName} — signatures: "${keyword}"`);
  lines.push("");
  lines.push(`Found ${signatures.length} match${signatures.length === 1 ? "" : "es"}:`);

  for (const sig of signatures) {
    const entry = matchedFiles.get(sig.filePath);
    let heading = sig.filePath;
    if (entry && entry.kind !== "method") {
      const { displayName, kindLabel } = formatEntryDisplay(entry);
      heading = `${displayName} (${kindLabel})`;
    }

    lines.push("");
    lines.push(`## ${heading} — ${sig.filePath}`);
    lines.push("");
    lines.push("```csharp");
    lines.push(sig.content);
    lines.push("```");
  }

  return lines.join("\n");
}
