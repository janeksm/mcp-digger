import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { formatUnknownRepo } from "../config.js";
import { GitError, readFile } from "../gitClient.js";
import { debug, error } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady } from "../repoManager.js";
import { extractPackageSummary } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Lists all packages in a repository with one-line summaries from .csproj metadata,
plus the repo root README.md when it exists. Use this to decide which package to
zoom into with dig_package_overview.
Call dig_list first to discover available repos, then call this with a repo name.`;

// ── Public API ──

export function registerDigRepoOverview(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_repo_overview",
    {
      title: "Dig Repo Overview",
      description: DESCRIPTION,
      inputSchema: {
        repoName: z.string().describe("Name of the repository to overview (as shown by dig_list)"),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ repoName }) =>
      toCallToolResult(await digRepoOverview(config, repoName)),
  );
}

export async function digRepoOverview(
  config: DiggerConfig,
  repoName: string,
): Promise<ToolResult> {
  debug("digRepoOverview", "called for repo", repoName);

  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return toolError(formatUnknownRepo(config, repoName));

  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);

      if (result.error) {
        error("digRepoOverview", `repo '${repo.name}':`, result.error);
        return toolError(`Repo '${repo.name}': ${result.error}`);
      }

      const sections: string[] = [];

      sections.push(`# ${repo.name}\n`);

      if (repo.packages.length === 0) {
        // Still try to read repo root README
        try {
          const readme = await readFile(result.sourcePath, "README.md");
          sections.push(readme.trim());
          sections.push("\n---\n");
        } catch (err) {
          if (!(err instanceof GitError)) throw err;
        }
        sections.push("## Packages\n");
        sections.push("*No packages resolved for this repo.*");
        return toolSuccess(sections.join("\n").trimEnd());
      }

      const [readme, summaries] = await Promise.all([
        readFile(result.sourcePath, "README.md").catch((err) => {
          if (err instanceof GitError) return undefined;
          throw err;
        }),
        Promise.all(
          repo.packages.map(async (pkg) => {
            try {
              const summary = await extractPackageSummary(result.sourcePath, pkg);
              return { name: pkg.name, summary };
            } catch {
              return { name: pkg.name, summary: undefined };
            }
          }),
        ),
      ]);

      if (readme) {
        sections.push(readme.trim());
        sections.push("\n---\n");
      }

      sections.push("## Packages\n");

      for (const { name, summary } of summaries) {
        if (summary) {
          sections.push(`- **${name}** — ${summary}`);
        } else {
          sections.push(`- **${name}**`);
        }
      }

      sections.push("");
      const count = repo.packages.length;
      sections.push(
        `*${count} package${count === 1 ? "" : "s"} — call dig_package_overview for full details.*`,
      );

      if (result.warning) {
        sections.push("\n---\n\n## Warnings\n");
        sections.push(`- ${result.warning}`);
      }

      return toolSuccess(sections.join("\n").trimEnd());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error("digRepoOverview", `repo '${repo.name}':`, msg);
      return toolError(`Repo '${repo.name}': ${msg}`);
    }
  });
}
