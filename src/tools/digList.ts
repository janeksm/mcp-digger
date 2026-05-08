import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS, extractErrorMessage } from "./shared.js";
import type { DiggerConfig } from "../config.js";
import { debug, error } from "../logger.js";
import { ensureAllReady, type RepoReadyResult } from "../repoManager.js";
import { extractPackageSummary } from "../sourceExtractor.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Lists all configured repositories and their resolved package names.
Call this first to discover what NuGet packages are available before
digging into any specific repo or package. Use the repo names with dig_repo_overview,
and the package names with dig_lookup or dig_file.`;

// ── Public API ──

export function registerDigList(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_list",
    {
      title: "Dig List",
      description: DESCRIPTION,
      annotations: TOOL_ANNOTATIONS,
    },
    async () => ({
      content: [{ type: "text" as const, text: await digList(config) }],
    }),
  );
}

export async function digList(config: DiggerConfig): Promise<string> {
  debug("digList", "called");

  let resolveWarning: string | undefined;
  let repoResults: Map<string, RepoReadyResult> | undefined;
  try {
    repoResults = await ensureAllReady(config);
  } catch (err) {
    const msg = extractErrorMessage(err);
    error("digList", "ensureAllReady failed:", msg);
    resolveWarning = msg;
  }

  const sections: string[] = ["# Available Packages"];

  for (const repo of config.repos) {
    const header = `## ${repo.name}`;

    if (repo.packages.length === 0) {
      sections.push(`${header}\n\n*No packages resolved.*`);
      continue;
    }

    const sourcePath = repoResults?.get(repo.name)?.sourcePath;
    const summaries = sourcePath
      ? await Promise.all(
          repo.packages.map(async (pkg) => {
            try {
              return await extractPackageSummary(sourcePath, pkg);
            } catch (err) {
              debug("digList", `summary failed for ${pkg.name}:`, extractErrorMessage(err));
              return undefined;
            }
          }),
        )
      : repo.packages.map(() => undefined);

    const listing = repo.packages
      .map((p, i) => {
        const summary = summaries[i];
        return summary ? `- **${p.name}** — ${summary}` : `- **${p.name}**`;
      })
      .join("\n");
    sections.push(`${header}\n\n${listing}`);
  }

  if (resolveWarning) {
    sections.push(`---\n\n**Warning:** Some repos may not have resolved fully: ${resolveWarning}`);
  }

  return sections.join("\n\n");
}
