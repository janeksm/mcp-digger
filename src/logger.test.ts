import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "./testHelpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-logger-test-"));
  vi.resetModules();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function logFilePath(): string {
  return path.join(tmpDir, ".digger", "debug.log");
}

function errorLogPath(): string {
  return path.join(tmpDir, ".digger", "error.log");
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

describe("error()", () => {
  it("writes to stderr before initLogger and does not create .digger", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { error } = await loadLogger();
      error("startup", "config broke");

      expect(stderrSpy).toHaveBeenCalledOnce();
      const written = stderrSpy.mock.calls[0]![0] as string;
      expect(written).toContain("[startup]");
      expect(written).toContain("config broke");

      const diggerDir = path.join(tmpDir, ".digger");
      expect(fs.existsSync(diggerDir)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("writes to error.log after initLogger (debug disabled)", async () => {
    const { error, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: false });
    error("digOverview", "repo failed");

    const content = fs.readFileSync(errorLogPath(), "utf-8");
    expect(content).toContain("[digOverview]");
    expect(content).toContain("repo failed");
  });

  it("writes to error.log after initLogger (debug enabled)", async () => {
    const { error, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: true });
    error("digFile", "not found");

    const content = fs.readFileSync(errorLogPath(), "utf-8");
    expect(content).toContain("[digFile]");
    expect(content).toContain("not found");
  });

  it("does not write to debug.log", async () => {
    const { error, initLogger } = await loadLogger();

    initLogger({ workspaceRoot: tmpDir, debug: true });
    error("test", "error only");

    const debugContent = fs.readFileSync(logFilePath(), "utf-8");
    expect(debugContent).not.toContain("error only");
  });

  it("truncates error.log when over 5 MB", async () => {
    const errPath = errorLogPath();
    fs.mkdirSync(path.dirname(errPath), { recursive: true });
    fs.writeFileSync(errPath, "x".repeat(6 * 1024 * 1024));

    const { error, initLogger } = await loadLogger();
    initLogger({ workspaceRoot: tmpDir, debug: false });
    error("test", "after truncate");

    const content = fs.readFileSync(errPath, "utf-8");
    expect(content).toContain("after truncate");
    expect(content.length).toBeLessThan(1024);
  });
});

describe("criticalError()", () => {
  it("writes to stderr before initLogger and does not create .digger", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { criticalError } = await loadLogger();
      criticalError("uncaughtException", "boom");

      expect(stderrSpy).toHaveBeenCalledOnce();
      const written = stderrSpy.mock.calls[0]![0] as string;
      expect(written).toContain("[uncaughtException]");
      expect(written).toContain("boom");

      const diggerDir = path.join(tmpDir, ".digger");
      expect(fs.existsSync(diggerDir)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("writes to BOTH stderr and error.log after initLogger", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { criticalError, initLogger } = await loadLogger();
      initLogger({ workspaceRoot: tmpDir, debug: false });

      criticalError("shutdown", "signal SIGTERM");

      const writes = stderrSpy.mock.calls.map((c) => c[0] as string);
      const stderrLine = writes.find((w) => w.includes("[shutdown]") && w.includes("signal SIGTERM"));
      expect(stderrLine).toBeDefined();

      const fileContent = fs.readFileSync(errorLogPath(), "utf-8");
      expect(fileContent).toContain("[shutdown]");
      expect(fileContent).toContain("signal SIGTERM");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("formats line with ISO timestamp and bracketed tag", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { criticalError } = await loadLogger();
      criticalError("fmt", "check format");

      const written = stderrSpy.mock.calls[0]![0] as string;
      expect(written).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[fmt\] check format\n$/,
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("does not throw when file write fails", async () => {
    // Force appendFileSync to fail by pre-creating error.log as a directory.
    fs.mkdirSync(path.join(tmpDir, ".digger", "error.log"), { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { criticalError, initLogger } = await loadLogger();
      initLogger({ workspaceRoot: tmpDir, debug: false });

      expect(() => criticalError("crash", "still alive")).not.toThrow();

      const writes = stderrSpy.mock.calls.map((c) => c[0] as string);
      expect(writes.some((w) => w.includes("[crash]") && w.includes("still alive"))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
