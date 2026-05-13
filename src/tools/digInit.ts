import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toCallToolResult, toolError, toolSuccess, type ToolResult } from "./shared.js";

const DESCRIPTION = `Bootstrap mcp-digger by creating a starter config file. Only available when no
config exists. After running, edit the generated template with your repository
details, then restart the MCP server to activate all tools.`;

const SAMPLE_CONFIG = {
  repos: [
    {
      name: "MyRepo",
      url: "https://dev.azure.com/org/project/_git/repo",
      packages: ["MyCompany.Core", "MyCompany.Domain"],
    },
  ],
};

export function registerDigInit(
  server: McpServer,
  configPath: string,
): void {
  server.registerTool(
    "dig_init",
    {
      title: "Dig Init",
      description: DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => toCallToolResult(digInit(configPath)),
  );
}

export function digInit(configPath: string): ToolResult {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    let fd: number | undefined;
    try {
      fd = fs.openSync(configPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(SAMPLE_CONFIG, null, 2) + "\n");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        return toolError(`Config already exists at ${configPath}. Delete it first if you want to regenerate.`);
      }
      throw e;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    return toolSuccess(
      `Config created at ${configPath}.\n\n` +
      "Edit the repos array with your repository details, then restart the MCP server to activate all tools.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to create config: ${msg}`);
  }
}
