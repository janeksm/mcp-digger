import * as fs from "node:fs";
import * as path from "node:path";

// ── Module-level state (singleton) ──

let initialized = false;
let enabled = false;
let logFilePath: string | undefined;
let errorLogPath: string | undefined;
const buffer: string[] = [];

const MAX_BUFFER = 1000;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Public API ──

/**
 * Write a debug log line. Before `initLogger` is called, messages are buffered.
 * After init, writes synchronously to the log file (or is a no-op if disabled).
 *
 * @param tag Module name shown in brackets, e.g. "gitClient", "repoManager".
 * @param args Values joined with spaces into the log message.
 */
export function debug(tag: string, ...args: unknown[]): void {
  if (initialized) {
    if (!enabled) return;
    writeLine(formatLine(tag, args));
    return;
  }

  if (buffer.length < MAX_BUFFER) {
    buffer.push(formatLine(tag, args));
  }
}

/**
 * Initialize the logger. Must be called once after config is loaded.
 *
 * If enabled, opens the log file (`.digger/debug.log`), applies size-cap
 * truncation, writes a session header, and flushes any buffered messages.
 *
 * Always sets up error.log regardless of the debug flag.
 */
export function initLogger(opts: {
  workspaceRoot: string;
  debug: boolean;
}): void {
  enabled = opts.debug;
  initialized = true;

  const diggerDir = path.join(opts.workspaceRoot, ".digger");
  fs.mkdirSync(diggerDir, { recursive: true });

  errorLogPath = path.join(diggerDir, "error.log");
  applySizeCap(errorLogPath);

  if (!enabled) {
    buffer.length = 0;
    return;
  }

  logFilePath = path.join(diggerDir, "debug.log");
  applySizeCap(logFilePath);

  // Session header
  writeLine(`\n--- mcp-digger session ${new Date().toISOString()} ---\n`);

  // Flush buffer
  for (const line of buffer) {
    writeLine(line);
  }
  buffer.length = 0;
}

/**
 * Write an error log line to `.digger/error.log`.
 *
 * Works before `initLogger()` by falling back to `process.cwd()`.
 * Always writes regardless of the debug flag.
 */
export function error(tag: string, ...args: unknown[]): void {
  const line = formatLine(tag, args);
  if (errorLogPath) {
    try {
      fs.appendFileSync(errorLogPath, line);
    } catch {
      // Best-effort
    }
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    // Best-effort
  }
}

/** Check whether debug logging is currently active. */
export function isDebugEnabled(): boolean {
  return initialized && enabled;
}

// ── Internal ──

function formatLine(tag: string, args: unknown[]): string {
  return `${new Date().toISOString()} [${tag}] ${args.map(String).join(" ")}\n`;
}

function writeLine(line: string): void {
  if (logFilePath) {
    fs.appendFileSync(logFilePath, line);
  }
}

function applySizeCap(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_SIZE) {
      fs.writeFileSync(filePath, "");
    }
  } catch {
    // File doesn't exist yet — fine
  }
}
