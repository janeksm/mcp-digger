import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { findPackage, formatUnknownPackage } from "../config.js";
import { GitError, listFiles, readFile } from "../gitClient.js";
import { debug } from "../logger.js";
import { ensureReady } from "../repoManager.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Digs to the deepest level — full source of a single file from an internal package.
Call this only when you need to understand the actual implementation — for example
to trace specific behaviour, understand a complex algorithm, or debug an unexpected
result. Provide both package name and file path (relative path as listed by
dig_signatures). Avoid calling this speculatively — prefer dig_signatures
unless implementation detail of a specific file is needed.`;

// ── Public API ──

/**
 * Register the dig_file tool on an MCP server.
 */
export function registerDigFile(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_file",
    {
      title: "Dig File",
      description: DESCRIPTION,
      inputSchema: {
        packageName: z.string(),
        filePath: z.string(),
      },
    },
    async ({ packageName, filePath }) => ({
      content: [
        { type: "text" as const, text: await digFile(config, packageName, filePath) },
      ],
    }),
  );
}

/**
 * Read the full source of a single file from an internal package.
 *
 * 1. Look up the package by name.
 * 2. Ensure the repo is on disk via repoManager.
 * 3. Read the file directly from the repo via gitClient.readFile.
 * 4. On invalid path: list valid .cs files under the package directory.
 *
 * Never throws — returns a usable error message if the package is unknown,
 * the repo is unreachable, or the file path is invalid.
 */
export async function digFile(
  config: DiggerConfig,
  packageName: string,
  filePath: string,
): Promise<string> {
  debug("digFile", "called for", packageName, filePath);
  const pkg = findPackage(config, packageName);
  if (!pkg) return formatUnknownPackage(config, packageName);

  const repo = config.repos.find((r) => r.name === pkg.repoName)!;

  try {
    const result = await ensureReady(repo, config);
    const fullPath = `${pkg.pathInRepo}/${filePath}`;

    try {
      const content = await readFile(result.sourcePath, fullPath);
      return formatFile(packageName, filePath, content);
    } catch (err) {
      if (err instanceof GitError) {
        // File not found — list valid paths
        const validPaths = await listValidPaths(result.sourcePath, pkg.pathInRepo);
        return formatInvalidPath(packageName, filePath, validPaths);
      }
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `# ${packageName} — ${filePath}\n\nSource unavailable. ${msg}`;
  }
}

// ── Internal ──

function formatFile(
  packageName: string,
  filePath: string,
  content: string,
): string {
  const lang = filePath.endsWith(".cs") ? "csharp" : detectLang(filePath);
  return `# ${packageName} — ${filePath}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
}

function detectLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    cs: "csharp",
    json: "json",
    xml: "xml",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? (langMap[ext] ?? "text") : "text";
}

async function listValidPaths(
  repoDir: string,
  packagePath: string,
): Promise<string[]> {
  try {
    const allFiles = await listFiles(repoDir, packagePath + "/");
    return allFiles
      .map((f) => f.slice(packagePath.length + 1))
      .filter((f) => f.length > 0)
      .sort();
  } catch {
    return [];
  }
}

function formatInvalidPath(
  packageName: string,
  filePath: string,
  validPaths: string[],
): string {
  const header = `# ${packageName}\n\nFile '${filePath}' not found.`;
  if (validPaths.length === 0) {
    return `${header} No files available in this package.`;
  }
  const listing = validPaths.map((p) => `- ${p}`).join("\n");
  return `${header}\n\nAvailable files:\n${listing}`;
}
