import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { formatUnknownPackageInRepo, formatUnknownRepo } from "../config.js";
import { listFiles } from "../gitClient.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { filterCsFiles } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Lists all C# source files in a package (excluding generated files).
Use this to see what files exist before calling dig_file for full source.`;

// ── Public API ──

export function registerDigPackageFiles(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_package_files",
    {
      title: "Dig Package Files",
      description: DESCRIPTION,
      inputSchema: {
        repoName: z.string().describe("Name of the repository (as shown by dig_list)"),
        packageName: PACKAGE_NAME_PARAM,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ repoName, packageName }) =>
      toCallToolResult(await digPackageFiles(config, repoName, packageName)),
  );
}

export async function digPackageFiles(
  config: DiggerConfig,
  repoName: string,
  packageName: string,
): Promise<ToolResult> {
  debug("digPackageFiles", "called for", repoName, packageName);

  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return toolError(formatUnknownRepo(config, repoName));

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);

      if (result.error) {
        error("digPackageFiles", `repo '${repo.name}':`, result.error);
        return toolError(`Repo '${repo.name}': ${result.error}`);
      }

      const pkg = repo.packages.find((p) => p.name === packageName);
      if (!pkg) return toolError(formatUnknownPackageInRepo(repo.name, packageName, repo.packages));

      const allFiles = await listFiles(result.sourcePath, pkg.pathInRepo + "/");
      const csFiles = filterCsFiles(allFiles);

      if (csFiles.length === 0) {
        return toolSuccess(`# ${pkg.name} — Source Files\n\n*No C# source files found.*`);
      }

      const lines: string[] = [];
      lines.push(`# ${pkg.name} — Source Files\n`);

      for (const f of csFiles.sort()) {
        const relPath = f.slice(pkg.pathInRepo.length + 1);
        lines.push(`- ${relPath}`);
      }

      lines.push("");
      lines.push(`*${csFiles.length} file${csFiles.length === 1 ? "" : "s"}*`);

      return toolSuccess(lines.join("\n").trimEnd());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digPackageFiles", `repo '${repo.name}':`, msg);
      return toolError(`Repo '${repo.name}': ${msg}`);
    }
  });
}
