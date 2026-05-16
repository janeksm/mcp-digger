import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiggerConfig } from "./config.js";
import { debug, initLogger } from "./logger.js";
import { registerDigFile } from "./tools/digFile.js";
import { registerDigInit } from "./tools/digInit.js";
import { registerDigList } from "./tools/digList.js";
import { registerDigLookup } from "./tools/digLookup.js";
import { registerDigPackageFiles } from "./tools/digPackageFiles.js";
import { registerDigPackageOverview } from "./tools/digPackageOverview.js";
import { registerDigRefresh } from "./tools/digRefresh.js";
import { registerDigRepoOverview } from "./tools/digRepoOverview.js";
import { registerDigSignatures } from "./tools/digSignatures.js";
import { registerDigStatus } from "./tools/digStatus.js";

export function bootstrap(
  server: McpServer,
  config: DiggerConfig | null,
  unconfiguredConfigPath: string,
): void {
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

    for (const w of config.warnings) {
      process.stderr.write(`[mcp-digger] warning: ${w}\n`);
    }
    return;
  }

  process.stderr.write(`[mcp-digger] no config found — running in unconfigured mode\n`);
  registerDigStatus(server, null);
  registerDigInit(server, unconfiguredConfigPath);
}
