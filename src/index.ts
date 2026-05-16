#!/usr/bin/env node

import * as path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "./bootstrap.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
import { criticalError, debug } from "./logger.js";

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
  const configPath = path.resolve(
    process.cwd(),
    process.env.DIGGER_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
  );
  bootstrap(server, config, configPath);
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
