#!/usr/bin/env node

import * as path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
import { criticalError, debug, initLogger } from "./logger.js";
import { registerDigFile } from "./tools/digFile.js";
import { registerDigInit } from "./tools/digInit.js";
import { registerDigList } from "./tools/digList.js";
import { registerDigLookup } from "./tools/digLookup.js";
import { registerDigRefresh } from "./tools/digRefresh.js";
import { registerDigPackageFiles } from "./tools/digPackageFiles.js";
import { registerDigPackageOverview } from "./tools/digPackageOverview.js";
import { registerDigRepoOverview } from "./tools/digRepoOverview.js";
import { registerDigSignatures } from "./tools/digSignatures.js";
import { registerDigStatus } from "./tools/digStatus.js";

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}

process.on("uncaughtException", (err) => {
  criticalError("uncaughtException", stringifyErr(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  criticalError("unhandledRejection", stringifyErr(reason));
  process.exit(1);
});

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "mcp-digger",
  version,
});

try {
  const config = loadConfig();

  if (config) {
    initLogger({ workspaceRoot: config.workspaceRoot, debug: config.debug });
    debug("index", "mcp-digger starting");

    registerDigList(server, config);
    registerDigLookup(server, config);
    registerDigSignatures(server, config);
    registerDigRepoOverview(server, config);
    registerDigPackageOverview(server, config);
    registerDigPackageFiles(server, config);
    registerDigFile(server, config);
    registerDigRefresh(server, config);
    registerDigStatus(server, config);

    if (config.warnings.length > 0) {
      for (const w of config.warnings) {
        process.stderr.write(`[mcp-digger] warning: ${w}\n`);
      }
    }
  } else {
    const configPath = path.resolve(
      process.cwd(),
      process.env.DIGGER_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
    );
    process.stderr.write(`[mcp-digger] no config found — running in unconfigured mode\n`);
    registerDigStatus(server, null);
    registerDigInit(server, configPath);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-digger] fatal: ${msg}\n`);
  process.exit(1);
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  debug("index", `received ${signal}, shutting down`);
  try {
    await server.close();
  } catch (err) {
    criticalError("shutdown", stringifyErr(err));
  }
  process.exit(0);
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  criticalError("connect", stringifyErr(err));
  process.exit(1);
}
