import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS, toCallToolResult, toolError, toolSuccess, withRepoReady, type ToolResult } from "./shared.js";
import { z } from "zod";
import type { DiggerConfig } from "../config.js";
import { formatUnknownRepo } from "../config.js";
import { GitError, readFile } from "../gitClient.js";
import { debug } from "../logger.js";
import { filterReadmeSections } from "../readmeFilter.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Returns the repo root README.md (architecture, conventions, design docs) when it exists.
Use this to understand a repo's structure and design before digging into specific packages.
Call dig_list first to discover available repos and their packages, then call this with a repo name.

Cost: lightweight — filtered README only. Skip if dig_list already provided enough context.`;

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

  return withRepoReady(repo, config, "digRepoOverview", async (result) => {
    if (result.error) return toolError(`Repo '${repo.name}': ${result.error}`);

    const sections: string[] = [];

    sections.push(`# ${repo.name}\n`);

    if (repo.packages.length === 0) {
      const readme = await readFile(result.sourcePath, "README.md").catch((err) => {
        if (err instanceof GitError) return undefined;
        throw err;
      });
      if (readme) sections.push(filterReadmeSections(readme).trim());
      sections.push("\n*No packages resolved for this repo — see dig_list for details.*");
      return toolSuccess(sections.join("\n").trimEnd());
    }

    const readme = await readFile(result.sourcePath, "README.md").catch((err) => {
      if (err instanceof GitError) return undefined;
      throw err;
    });

    if (readme) {
      sections.push(filterReadmeSections(readme).trim());
    }

    const count = repo.packages.length;
    sections.push(
      `\n*${count} package${count === 1 ? "" : "s"} — see dig_list for the full listing, or dig_package_overview for details.*`,
    );

    if (result.warning) {
      sections.push("\n---\n\n## Warnings\n");
      sections.push(`- ${result.warning}`);
    }

    return toolSuccess(sections.join("\n").trimEnd());
  });
}
