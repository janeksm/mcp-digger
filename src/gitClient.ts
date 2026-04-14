import * as child_process from "node:child_process";
import * as util from "node:util";
import type { GitAuth } from "./config.js";

const execFile = util.promisify(child_process.execFile);

/** Max buffer for git output (10 MB — covers large file listings). */
const MAX_BUFFER = 10 * 1024 * 1024;

// ── Error type ──

export class GitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

// ── Internal helpers ──

async function git(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
  } catch (err) {
    const e = err as child_process.ExecFileException & {
      stdout?: string;
      stderr?: string;
    };
    throw new GitError(
      `git ${args[0]} failed: ${e.stderr?.trim() || e.message}`,
      typeof (e as unknown as Record<string, unknown>).status === "number"
        ? ((e as unknown as Record<string, unknown>).status as number)
        : null,
      e.stderr ?? "",
    );
  }
}

/**
 * Inject PAT into an HTTPS URL: `https://host/path` → `https://oauth2:<pat>@host/path`.
 * Returns undefined for non-HTTPS URLs (SSH, file://, etc.).
 */
export function injectPat(url: string, pat: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  parsed.username = "oauth2";
  parsed.password = pat;
  return parsed.toString();
}

/**
 * Determine whether we should attempt an authenticated retry.
 * Only makes sense for HTTPS URLs when a PAT is available.
 */
function shouldRetryWithPat(
  auth: GitAuth,
  url: string,
): { authUrl: string } | undefined {
  if (auth.strategy === "none") return undefined;
  if (!auth.pat) return undefined;
  const authUrl = injectPat(url, auth.pat);
  if (!authUrl) return undefined;
  return { authUrl };
}

// ── Public API ──

/**
 * Shallow-clone a repo into `targetDir`.
 *
 * Auth behaviour:
 * - `auto`: try unauthenticated, PAT fallback on failure (HTTPS only).
 * - `pat`: inject PAT immediately.
 * - `none`: no credentials injected.
 */
export async function clone(
  url: string,
  targetDir: string,
  auth: GitAuth,
  depth: number = 1,
): Promise<void> {
  const args = ["clone", "--depth", String(depth), "--single-branch"];

  if (auth.strategy === "pat") {
    const authUrl = auth.pat ? injectPat(url, auth.pat) : undefined;
    await git([...args, authUrl ?? url, targetDir]);
    return;
  }

  // strategy "auto" or "none": try unauthenticated first
  try {
    await git([...args, url, targetDir]);
    return;
  } catch (firstErr) {
    const retry = shouldRetryWithPat(auth, url);
    if (!retry) throw firstErr;
    await git([...args, retry.authUrl, targetDir]);
  }
}

/**
 * Fetch latest from origin (shallow).
 *
 * Uses explicit URL for PAT retry so the token is never persisted in remote config.
 */
export async function fetch(
  repoDir: string,
  auth: GitAuth,
  remoteUrl?: string,
): Promise<void> {
  const baseArgs = ["-C", repoDir, "fetch", "--depth", "1", "origin"];

  if (auth.strategy === "pat" && auth.pat && remoteUrl) {
    const authUrl = injectPat(remoteUrl, auth.pat);
    if (authUrl) {
      // Fetch using explicit auth URL instead of the configured remote
      await git(["-C", repoDir, "fetch", "--depth", "1", authUrl, "HEAD"]);
      return;
    }
  }

  // strategy "auto" or "none": try unauthenticated first
  try {
    await git(baseArgs);
    return;
  } catch (firstErr) {
    if (!remoteUrl) throw firstErr;
    const retry = shouldRetryWithPat(auth, remoteUrl);
    if (!retry) throw firstErr;
    await git(["-C", repoDir, "fetch", "--depth", "1", retry.authUrl, "HEAD"]);
  }
}

/** Get the commit hash for a ref (e.g. "HEAD", "FETCH_HEAD"). */
export async function revParse(repoDir: string, ref: string): Promise<string> {
  const { stdout } = await git(["-C", repoDir, "rev-parse", ref]);
  return stdout.trim();
}

/** Check whether `dirPath` is inside a valid git repository. */
export async function isValidRepo(dirPath: string): Promise<boolean> {
  try {
    await git(["-C", dirPath, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Read a file from the committed HEAD of a repo (not the working tree). */
export async function readFile(
  repoDir: string,
  filePath: string,
): Promise<string> {
  const { stdout } = await git(["-C", repoDir, "show", `HEAD:${filePath}`]);
  return stdout;
}

/**
 * List tracked files in the repo, optionally filtered by a pathspec pattern.
 * Returns repo-relative paths using forward slashes.
 */
export async function listFiles(
  repoDir: string,
  pattern?: string,
): Promise<string[]> {
  const args = ["-C", repoDir, "ls-files"];
  if (pattern) args.push(pattern);
  const { stdout } = await git(args);
  return stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.length > 0);
}
