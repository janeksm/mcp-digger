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
import { extractIndex, extractSignatures, serializeIndex, parseIndex, formatEntryDisplay, splitRespectingGenerics, scoreSymbolMatch, type IndexEntry } from "../sourceExtractor.js";

// ── Tool description (shown to the MCP client / agent) ──

const DESCRIPTION = `Returns stripped C# signatures filtered by keyword.
Searches the package's type and method index, then returns stripped source
for matching files — type declarations, method signatures, property definitions,
and XML doc comments with method bodies replaced by placeholders.
Call this when you need exact method overloads, generic constraints,
interface members, or return types for specific types.
Call dig_package_overview first, then dig_lookup to locate symbols,
then dig_signatures to see their full public API surface.

Cost: cheaper than dig_file — returns API shape without method bodies. Use when you need signatures, not full implementation.`;

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
          extractSignatures(result.sourcePath, pkg),
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
        const extracted = await extractSignatures(result.sourcePath, pkg);
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
          `No matches for '${keyword}'. Try a broader term, call dig_lookup to see available types, or call dig_refresh to force a re-index.`,
        );
      }

      const matchedSigs = sigsCached.filter((s) => matchedFiles.has(s.filePath));
      sortByScore(matchedSigs, matchedFiles);

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
        try {
          const entries = parseIndex(staleIndex);
          const matchedFiles = searchIndexForFiles(entries, keyword, exactMatch);
          const matchedSigs = staleSigs.filter((s) => matchedFiles.has(s.filePath));
          sortByScore(matchedSigs, matchedFiles);

          if (matchedSigs.length > 0) {
            return toolSuccess(
              formatSignatures(packageName, keyword, matchedSigs, matchedFiles) +
              `\n\n---\n\n> **Warning:** Signatures may be stale. ${msg}`,
            );
          }
        } catch (parseErr) {
          error(
            "digSignatures",
            `stale index parse failed for '${packageName}':`,
            extractErrorMessage(parseErr),
          );
        }
      }
      return toolError(`# ${packageName}\n\nSource unavailable. ${msg}`);
    }
  });
}

// ── Internal ──

interface FileMatch {
  entry: IndexEntry;
  score: number;
}

function searchIndexForFiles(
  entries: IndexEntry[],
  keyword: string,
  exactMatch: boolean,
): Map<string, FileMatch> {
  const lower = keyword.toLowerCase();
  const matched = new Map<string, FileMatch>();

  for (const entry of entries) {
    const score = exactMatch
      ? (entry.symbol.toLowerCase() === lower ? 1.0 : 0)
      : scoreSymbolMatch(entry.symbol, keyword);

    if (score === 0) continue;

    const existing = matched.get(entry.filePath);
    if (!existing) {
      matched.set(entry.filePath, { entry, score });
    } else {
      const bestScore = Math.max(score, existing.score);
      let bestEntry: IndexEntry;
      if (entry.kind !== "method" && existing.entry.kind === "method") {
        bestEntry = entry;
      } else if (existing.entry.kind !== "method" && entry.kind === "method") {
        bestEntry = existing.entry;
      } else {
        bestEntry = score > existing.score ? entry : existing.entry;
      }
      matched.set(entry.filePath, { entry: bestEntry, score: bestScore });
    }
  }

  return matched;
}

function sortByScore(
  sigs: Array<{ filePath: string; content: string }>,
  matchedFiles: Map<string, FileMatch>,
): void {
  sigs.sort((a, b) => {
    const ma = matchedFiles.get(a.filePath);
    const mb = matchedFiles.get(b.filePath);
    return (mb?.score ?? 0) - (ma?.score ?? 0)
      || (mb?.entry.refCount ?? 0) - (ma?.entry.refCount ?? 0)
      || a.filePath.localeCompare(b.filePath);
  });
}

// ── Summary block ──

interface MethodInfo {
  name: string;
  returnType: string;
  params: string;
  access: "public" | "protected" | "internal";
}

const METHOD_MODIFIERS = /(?:static|async|virtual|abstract|override|new|sealed)\s+/g;
const METHOD_LINE_RE = /^\s*(?:(protected|internal)\s+)?(?:(?:static|async|virtual|abstract|override|new|sealed)\s+)*(.+?)\s+(\w+)(?:<[^>()]+>)?\s*\(([^)]*)\)/;
const AUTO_PROP_RE = /\{\s*(?:(?:(?:private|protected|internal|public)\s+)?(?:get|set|init)\s*;\s*)+\}/;
const TYPE_DECL_COUNT_RE = /^\s*(?:(?:public|protected|internal|private|abstract|sealed|static|partial|readonly|ref|file|unsafe)\s+)*(?:class|interface|struct|enum|record)\b/gm;

const MAX_KEY_METHODS = 3;
const MAX_IMPLEMENTS = 3;

function parseMethodsFromStripped(content: string, typeName: string): MethodInfo[] {
  const typeMatches = content.match(TYPE_DECL_COUNT_RE);
  if (typeMatches && typeMatches.length > 1) return [];

  const results: MethodInfo[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed.startsWith("//")) continue;
    if (AUTO_PROP_RE.test(trimmed)) continue;

    const match = METHOD_LINE_RE.exec(trimmed);
    if (!match) continue;

    const access = match[1] as "protected" | "internal" | undefined;
    const returnType = match[2]!.replace(METHOD_MODIFIERS, "").trim();
    const name = match[3]!;
    const rawParams = match[4]!;

    if (name === typeName) continue;

    results.push({
      name,
      returnType,
      params: formatParamTypes(rawParams),
      access: access ?? "public",
    });
  }

  return results;
}

function formatParamTypes(raw: string): string {
  if (!raw.trim()) return "";
  return splitRespectingGenerics(raw)
    .map((p) => {
      const parts = p.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]!;
    })
    .join(", ");
}

function formatKeyMethod(m: MethodInfo): string {
  const params = m.params ? `(${m.params})` : "()";
  if (m.returnType === "void" || m.returnType === "Task") {
    return `${m.name}${params}`;
  }
  return `${m.name}${params} → ${m.returnType}`;
}

function buildSummaryLine(entry: IndexEntry, content: string): string | undefined {
  if (entry.kind === "method") return undefined;

  const { displayName, kindLabel } = formatEntryDisplay(entry);
  const parts: string[] = [`**${displayName}** (${kindLabel})`];

  if (entry.baseTypes && entry.baseTypes.length > 0) {
    const shown = entry.baseTypes.slice(0, MAX_IMPLEMENTS);
    let impl = shown.join(", ");
    if (entry.baseTypes.length > MAX_IMPLEMENTS) {
      impl += ` +${entry.baseTypes.length - MAX_IMPLEMENTS} more`;
    }
    parts.push(`Implements: ${impl}`);
  }

  if (entry.kind === "enum") {
    return `> ${parts.join(" · ")}`;
  }

  const methods = parseMethodsFromStripped(content, entry.symbol);

  if (methods.length > 0) {
    const pubCount = methods.filter((m) => m.access === "public").length;
    const protCount = methods.filter((m) => m.access === "protected").length;

    if (protCount > 0) {
      parts.push(`Methods: ${pubCount} public, ${protCount} protected`);
    } else {
      parts.push(`Methods: ${pubCount}`);
    }

    const keyMethods = methods
      .sort((a, b) => {
        const aScore = (a.returnType !== "void" && a.returnType !== "Task" ? 2 : 0) + (a.params ? 1 : 0);
        const bScore = (b.returnType !== "void" && b.returnType !== "Task" ? 2 : 0) + (b.params ? 1 : 0);
        return bScore - aScore;
      })
      .slice(0, MAX_KEY_METHODS)
      .map(formatKeyMethod);

    if (keyMethods.length > 0) {
      parts.push(`Key: ${keyMethods.join(", ")}`);
    }
  }

  return `> ${parts.join(" · ")}`;
}

// ── Output formatting ──

function formatSignatures(
  packageName: string,
  keyword: string,
  signatures: Array<{ filePath: string; content: string }>,
  matchedFiles: Map<string, FileMatch>,
): string {
  const lines: string[] = [];
  lines.push(`# ${packageName} — signatures: "${keyword}"`);
  lines.push("");
  lines.push(`Found ${signatures.length} match${signatures.length === 1 ? "" : "es"}:`);

  for (const sig of signatures) {
    const entry = matchedFiles.get(sig.filePath)?.entry;
    let heading = sig.filePath;
    if (entry && entry.kind !== "method") {
      const { displayName, kindLabel } = formatEntryDisplay(entry);
      heading = `${displayName} (${kindLabel})`;
    }

    lines.push("");
    lines.push(`## ${heading} — ${sig.filePath}`);

    if (entry) {
      const summary = buildSummaryLine(entry, sig.content);
      if (summary) {
        lines.push("");
        lines.push(summary);
      }
    }

    lines.push("");
    lines.push("```csharp");
    lines.push(sig.content);
    lines.push("```");
  }

  lines.push("");
  if (signatures.length === 1) {
    lines.push("Use `dig_file` for full implementation.");
  } else {
    lines.push("Use `dig_file` with the specific file path for full implementation.");
  }

  return lines.join("\n");
}
