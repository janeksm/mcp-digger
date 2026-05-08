import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FILE_CHAR_LIMIT, PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, extractErrorMessage, requirePackage, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { GitError, listFiles, readFile } from "../gitClient.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Digs to the deepest level — full source of a single file from a package.
Call this only when you need to understand the actual implementation — for example
to trace specific behaviour, understand a complex algorithm, or debug an unexpected
result. Provide both package name and file path (relative path as shown by
dig_lookup or dig_package_files). Avoid calling this speculatively — prefer dig_lookup
to find the right file first, then dig_file only for the specific file you need.`;

// ── Public API ──

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
        packageName: PACKAGE_NAME_PARAM,
        filePath: z.string().describe("File path relative to the package root, as shown by dig_lookup or dig_package_files (e.g. 'Services/FooService.cs')"),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ packageName, filePath }) =>
      toCallToolResult(await digFile(config, packageName, filePath)),
  );
}

/** Never throws — returns a usable error message on every failure path. */
export async function digFile(
  config: DiggerConfig,
  packageName: string,
  filePath: string,
): Promise<ToolResult> {
  debug("digFile", "called for", packageName, filePath);
  const resolved = requirePackage(config, packageName);
  if ("text" in resolved) return resolved;
  const { pkg, repo } = resolved;

  const safeFilePath = normalizeFilePath(filePath);
  if (!safeFilePath) {
    return toolError(`# ${packageName} — ${filePath}\n\nInvalid file path. Paths must be relative to the package root and cannot escape it (no absolute paths, '..' segments, backslashes, or null bytes).`);
  }

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      const fullPath = `${pkg.pathInRepo}/${safeFilePath}`;

      try {
        const content = await readFile(result.sourcePath, fullPath);
        if (content.length > FILE_CHAR_LIMIT) {
          return toolError(`# ${packageName} — ${filePath}\n\nFile too large (${content.length.toLocaleString()} chars, limit ${FILE_CHAR_LIMIT.toLocaleString()}). Use dig_lookup to find specific types or methods, or view this file in your editor.`);
        }
        return toolSuccess(formatFile(packageName, filePath, content));
      } catch (err) {
        if (err instanceof GitError) {
          // File not found — list valid paths
          const validPaths = await listValidPaths(result.sourcePath, pkg.pathInRepo);
          return toolError(formatInvalidPath(packageName, filePath, validPaths));
        }
        throw err;
      }
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digFile", `package '${packageName}' file '${filePath}':`, msg);
      return toolError(`# ${packageName} — ${filePath}\n\nSource unavailable. ${msg}`);
    }
  });
}

// ── Internal ──

/**
 * Validate and normalize a caller-supplied file path so it cannot escape the
 * package's directory. Rejects absolute paths, `..` escapes, null bytes, and
 * backslashes (git pathspecs use forward slashes; allowing backslash could
 * bypass traversal checks on Windows). Returns the normalized relative path,
 * or undefined if the input is unsafe.
 */
function normalizeFilePath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  if (filePath.includes("\0")) return undefined;
  if (filePath.includes("\\")) return undefined;
  if (path.posix.isAbsolute(filePath)) return undefined;

  const normalized = path.posix.normalize(filePath);
  if (normalized === "." || normalized === "..") return undefined;
  if (normalized.startsWith("../")) return undefined;

  return normalized;
}

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
