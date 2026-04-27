import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "./shared.js";
import type { DiggerConfig } from "../config.js";
import { debug, error } from "../logger.js";
import { ensureAllReady } from "../repoManager.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Lists all configured repositories and their resolved package names.
Call this first to discover what internal NuGet packages are available before
digging into any specific repo or package. Use the repo names with dig_overview,
and the package names with dig_signatures or dig_file.`;

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
  try {
    await ensureAllReady(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error("digList", "ensureAllReady failed:", msg);
    resolveWarning = msg;
  }

  const sections: string[] = ["# Available Packages"];

  for (const repo of config.repos) {
    const header = repo.discoveryMode === "wildcard"
      ? `## ${repo.name} (wildcard)`
      : `## ${repo.name}`;

    if (repo.packages.length === 0) {
      sections.push(`${header}\n\n*No packages resolved.*`);
    } else {
      const listing = repo.packages.map((p) => `- ${p.name}`).join("\n");
      sections.push(`${header}\n\n${listing}`);
    }
  }

  if (resolveWarning) {
    sections.push(`---\n\n**Warning:** Some repos may not have resolved fully: ${resolveWarning}`);
  }

  return sections.join("\n\n");
}
