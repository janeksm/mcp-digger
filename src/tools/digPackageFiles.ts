import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_NAME_PARAM, TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, withRepoReady, type ToolResult } from "./shared.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { formatUnknownPackageInRepo, formatUnknownRepo } from "../config.js";
import { listFiles } from "../gitClient.js";
import { debug } from "../logger.js";
import { filterCsFiles } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const FILE_COUNT_HINT_THRESHOLD = 10;

const DESCRIPTION = `Lists all C# source files in a package (excluding generated files).
Use this to see what files exist before calling dig_file for full source.

Cost: lightweight file listing. For large packages (many files), prefer dig_lookup to find specific types directly.`;

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

  return withRepoReady(repo, config, "digPackageFiles", async (result) => {
    if (result.error) return toolError(`Repo '${repo.name}': ${result.error}`);

    const pkg = repo.packages.find((p) => p.name === packageName);
    if (!pkg) return toolError(formatUnknownPackageInRepo(repo.name, packageName, repo.packages));

    const allFiles = await listFiles(result.sourcePath, pkg.pathInRepo + "/");
    const csFiles = filterCsFiles(allFiles);

    if (csFiles.length === 0) {
      return toolSuccess(`# ${pkg.name} — Source Files\n\n*No C# source files found.*`);
    }

    const lines: string[] = [];
    lines.push(`# ${pkg.name} — Source Files\n`);

    const sortedFiles = csFiles.sort();
    const relPaths = sortedFiles.map((f) => f.slice(pkg.pathInRepo.length + 1));

    const summary = buildDirectorySummary(relPaths);
    if (summary) {
      lines.push(summary);
      lines.push("");
    }

    for (const rel of relPaths) {
      lines.push(`- ${rel}`);
    }

    lines.push("");
    if (csFiles.length > FILE_COUNT_HINT_THRESHOLD) {
      lines.push(`*${csFiles.length} files — use dig_lookup to find specific types instead of browsing.*`);
    } else {
      lines.push(`*${csFiles.length} file${csFiles.length === 1 ? "" : "s"} — use dig_file to read source, or dig_lookup to search by symbol.*`);
    }

    return toolSuccess(lines.join("\n").trimEnd());
  });
}

// ── Helpers ──

export function buildDirectorySummary(relPaths: string[]): string | undefined {
  const dirCounts = new Map<string, number>();
  let rootFiles = 0;

  for (const p of relPaths) {
    const slashIdx = p.indexOf("/");
    if (slashIdx === -1) {
      rootFiles++;
    } else {
      const dir = p.slice(0, slashIdx);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
  }

  if (dirCounts.size === 0) return undefined;

  const parts = [...dirCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, count]) => `${dir}/ (${count})`);

  if (rootFiles > 0) {
    parts.push(`${rootFiles} root file${rootFiles === 1 ? "" : "s"}`);
  }

  return parts.join(" · ");
}
