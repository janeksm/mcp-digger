#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { debug, initLogger } from "./logger.js";
import { registerDigFile } from "./tools/digFile.js";
import { registerDigOverview } from "./tools/digOverview.js";
import { registerDigSignatures } from "./tools/digSignatures.js";

const server = new McpServer({
  name: "mcp-digger",
  version: "0.0.1",
});

try {
  const config = loadConfig();

  initLogger({ workspaceRoot: config.workspaceRoot, debug: config.debug });
  debug("index", "mcp-digger starting");

  registerDigOverview(server, config);
  registerDigSignatures(server, config);
  registerDigFile(server, config);

  if (config.warnings.length > 0) {
    for (const w of config.warnings) {
      process.stderr.write(`[mcp-digger] warning: ${w}\n`);
    }
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-digger] fatal: ${msg}\n`);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
