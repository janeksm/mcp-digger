import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "./bootstrap.js";
import type { DiggerConfig } from "./config.js";
import { makeConfig, makeLocalRepo, makePkg } from "./testHelpers.js";

interface RegisterCall {
  name: string;
  schema: { description?: string; annotations?: Record<string, boolean> };
}

function makeFakeServer(): { server: McpServer; calls: RegisterCall[] } {
  const calls: RegisterCall[] = [];
  const fake = {
    registerTool(name: string, schema: RegisterCall["schema"]): void {
      calls.push({ name, schema });
    },
  };
  return { server: fake as unknown as McpServer, calls };
}

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stderrLines: string[];
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-bootstrap-"));
  stderrLines = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBootstrapConfig(): DiggerConfig {
  const cacheDir = path.join(tmpDir, "cache");
  const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
  const repo = makeLocalRepo("myrepo", path.join(tmpDir, "repo-does-not-exist"), [pkg], tmpDir);
  return makeConfig([repo], tmpDir, cacheDir);
}

describe("bootstrap", () => {
  it("registers all nine tools when config is present", () => {
    const { server, calls } = makeFakeServer();

    bootstrap(server, makeBootstrapConfig(), "/ignored");

    const names = calls.map((c) => c.name).sort();
    expect(names).toEqual([
      "dig_file",
      "dig_list",
      "dig_lookup",
      "dig_package_files",
      "dig_package_overview",
      "dig_refresh",
      "dig_repo_overview",
      "dig_signatures",
      "dig_status",
    ]);
  });

  it("does not register dig_init in configured mode", () => {
    const { server, calls } = makeFakeServer();

    bootstrap(server, makeBootstrapConfig(), "/ignored");

    expect(calls.map((c) => c.name)).not.toContain("dig_init");
  });

  it("emits stderr warnings for each config warning", () => {
    const { server } = makeFakeServer();
    const config = makeBootstrapConfig();
    config.warnings = ["warning A", "warning B"];

    bootstrap(server, config, "/ignored");

    expect(stderrLines.some((l) => l.includes("warning: warning A"))).toBe(true);
    expect(stderrLines.some((l) => l.includes("warning: warning B"))).toBe(true);
  });

  it("registers only dig_status and dig_init in unconfigured mode", () => {
    const { server, calls } = makeFakeServer();

    bootstrap(server, null, "/some/path/config.json");

    const names = calls.map((c) => c.name).sort();
    expect(names).toEqual(["dig_init", "dig_status"]);
  });

  it("writes unconfigured-mode message to stderr when config is null", () => {
    const { server } = makeFakeServer();

    bootstrap(server, null, "/some/path/config.json");

    const joined = stderrLines.join("");
    expect(joined).toContain("no config found");
    expect(joined).toContain("unconfigured mode");
  });

  it("each registered tool has a description and annotations", () => {
    const { server, calls } = makeFakeServer();

    bootstrap(server, makeBootstrapConfig(), "/ignored");

    for (const call of calls) {
      expect(call.schema.description).toBeTruthy();
      expect(call.schema.annotations).toBeDefined();
    }
  });
});
