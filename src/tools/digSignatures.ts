import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS } from "./shared.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readSignatures,
  writeSignature,
} from "../cacheManager.js";
import type { DiggerConfig } from "../config.js";
import { findPackage, formatUnknownPackage } from "../config.js";
import { debug, error } from "../logger.js";
import { ensureReady } from "../repoManager.js";
import { extractSignatures } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Digs one level deeper into a specific internal package.
Returns stripped C# source files containing only public type declarations,
method signatures, property definitions, and XML doc comments.
Method bodies are replaced with a placeholder.
Call this when the overview is not enough to confidently use a type — for example
when you need exact method overloads, generic constraints, interface members,
or return types. Specify the package name.
To dig even deeper into a specific file's implementation, call dig_file.`;

// ── Public API ──

/**
 * Register the dig_signatures tool on an MCP server.
 */
export function registerDigSignatures(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_signatures",
    {
      title: "Dig Signatures",
      description: DESCRIPTION,
      inputSchema: { packageName: PACKAGE_NAME_PARAM },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ packageName }) => ({
      content: [
        { type: "text" as const, text: await digSignatures(config, packageName) },
      ],
    }),
  );
}

/**
 * Generate stripped .cs signatures for a single package.
 *
 * 1. Look up the package and its repo.
 * 2. Ensure the repo is on disk and get the current commit hash.
 * 3. If the cache is stale, invalidate and regenerate all signatures.
 * 4. If the cache is fresh, return cached signatures.
 * 5. Format results as a readable markdown response.
 *
 * Never throws — returns a usable error message if the package is unknown or the repo is unreachable.
 */
export async function digSignatures(
  config: DiggerConfig,
  packageName: string,
): Promise<string> {
  debug("digSignatures", "called for", packageName);
  const pkg = findPackage(config, packageName);
  if (!pkg) return formatUnknownPackage(config, packageName);

  const repo = config.repos.find((r) => r.name === pkg.repoName)!;

  try {
    const result = await ensureReady(repo, config);

    const fresh = await isFresh(config.cacheDir, repo.name, result.currentHash);

    if (!fresh) {
      await invalidate(config.cacheDir, repo.name, repo.packages);
    }

    // Try cached signatures first
    let signatures = fresh ? await readSignatures(pkg) : [];

    if (signatures.length === 0) {
      // Generate and cache
      const extracted = await extractSignatures(
        result.sourcePath,
        pkg,
        result.currentHash,
      );

      await Promise.all(
        extracted.map((sig) => writeSignature(pkg, sig.filePath, sig.content)),
      );
      signatures = extracted;

      if (!fresh) {
        await markFresh(config.cacheDir, repo.name, result.currentHash);
      }
    }

    if (signatures.length === 0) {
      return `# ${packageName}\n\nNo .cs source files found.`;
    }

    return formatSignatures(packageName, signatures);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error("digSignatures", `package '${packageName}':`, msg);
    const stale = await readSignatures(pkg);
    if (stale.length > 0) {
      return (
        formatSignatures(packageName, stale) +
        `\n\n---\n\n> **Warning:** Signatures may be stale. ${msg}`
      );
    }
    return `# ${packageName}\n\nSource unavailable. ${msg}`;
  }
}

// ── Internal ──

function formatSignatures(
  packageName: string,
  signatures: Array<{ filePath: string; content: string }>,
): string {
  const sections = signatures.map(
    (sig) => `### ${sig.filePath}\n\n\`\`\`csharp\n${sig.content}\n\`\`\``,
  );
  return `# ${packageName} — Signatures\n\n${sections.join("\n\n")}`;
}
