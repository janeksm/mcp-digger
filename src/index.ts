#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { debug, error, initLogger } from "./logger.js";
import { registerDigFile } from "./tools/digFile.js";
import { registerDigList } from "./tools/digList.js";
import { registerDigLookup } from "./tools/digLookup.js";
import { registerDigOverview } from "./tools/digOverview.js";
import { registerDigSignatures } from "./tools/digSignatures.js";
import { registerDigStatus } from "./tools/digStatus.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "mcp-digger",
  version,
});

try {
  const config = loadConfig();

  initLogger({ workspaceRoot: config.workspaceRoot, debug: config.debug });
  debug("index", "mcp-digger starting");

  registerDigList(server, config);
  registerDigLookup(server, config);
  registerDigSignatures(server, config);
  registerDigOverview(server, config);
  registerDigFile(server, config);
  registerDigStatus(server, config);

  if (config.warnings.length > 0) {
    for (const w of config.warnings) {
      process.stderr.write(`[mcp-digger] warning: ${w}\n`);
    }
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-digger] fatal: ${msg}\n`);
  error("startup", msg);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
