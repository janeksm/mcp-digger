import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-logger-test-"));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function logFilePath(): string {
  return path.join(tmpDir, ".digger", "debug.log");
}

async function loadLogger() {
  const mod = await import("./logger.js");
  return mod;
}

describe("logger", () => {
  it("debug() is a no-op when disabled", async () => {
    const { debug, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: false });
    debug("test", "should not appear");

    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("debug() writes to file when enabled", async () => {
    const { debug, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: true });
    debug("myTag", "hello", "world");

    const content = fs.readFileSync(logFilePath(), "utf-8");
    expect(content).toContain("[myTag]");
    expect(content).toContain("hello world");
  });

  it("buffers messages before init and flushes when enabled", async () => {
    const { debug, initLogger } = await loadLogger();

    debug("early", "buffered message");
    initLogger({ workspaceRoot: tmpDir, debug: true });

    const content = fs.readFileSync(logFilePath(), "utf-8");
    expect(content).toContain("[early]");
    expect(content).toContain("buffered message");
  });

  it("discards buffer when disabled", async () => {
    const { debug, initLogger } = await loadLogger();

    debug("early", "should vanish");
    initLogger({ workspaceRoot: tmpDir, debug: false });

    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("writes session header on init", async () => {
    const { initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: true });

    const content = fs.readFileSync(logFilePath(), "utf-8");
    expect(content).toContain("--- mcp-digger session");
  });

  it("truncates log file when over 5 MB", async () => {
    const logPath = logFilePath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Write a >5 MB file
    fs.writeFileSync(logPath, "x".repeat(6 * 1024 * 1024));
    expect(fs.statSync(logPath).size).toBeGreaterThan(5 * 1024 * 1024);

    const { debug, initLogger } = await loadLogger();
    initLogger({ workspaceRoot: tmpDir, debug: true });
    debug("test", "after truncate");

    const content = fs.readFileSync(logPath, "utf-8");
    // Should contain session header and new message, but be much smaller
    expect(content).toContain("--- mcp-digger session");
    expect(content).toContain("after truncate");
    expect(content.length).toBeLessThan(1024);
  });

  it("formats lines with ISO timestamp and bracketed tag", async () => {
    const { debug, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: true });
    debug("fmt", "check format");

    const content = fs.readFileSync(logFilePath(), "utf-8");
    const lines = content.split("\n").filter((l) => l.includes("[fmt]"));
    expect(lines.length).toBe(1);
    // ISO 8601 timestamp pattern
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[fmt\] check format$/);
  });

  it("isDebugEnabled() reflects state", async () => {
    const { isDebugEnabled, initLogger } = await loadLogger();

    expect(isDebugEnabled()).toBe(false);
    initLogger({ workspaceRoot: tmpDir, debug: true });
    expect(isDebugEnabled()).toBe(true);
  });
});
