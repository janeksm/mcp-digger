import * as child_process from "node:child_process";
import * as util from "node:util";
import type { GitAuth } from "./config.js";
import { debug } from "./logger.js";

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

/** @param opts.noPrompt Suppress credential helpers (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never) so git fails fast instead of blocking on prompts. */
async function git(
  args: string[],
  cwd?: string,
  opts?: { noPrompt?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      ...(opts?.noPrompt && {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }),
    });
  } catch (err) {
    const e = err as child_process.ExecFileException & {
      stdout?: string;
      stderr?: string;
    };
    throw new GitError(
      `git ${args[0]} failed: ${e.stderr?.trim() || e.message}`,
      typeof e.code === "number" ? e.code : null,
      e.stderr ?? "",
    );
  }
}

/**
 * Run `git()` and, on failure, replace every occurrence of `pat` in the error
 * message and stderr with `[REDACTED-PAT]`. Use for commands that embed a PAT
 * in a URL argument — git's error output routinely echoes the attempted URL,
 * which would otherwise leak the token to callers and logs.
 */
async function gitRedacted(
  args: string[],
  pat: string,
  cwd?: string,
  opts?: { noPrompt?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await git(args, cwd, opts);
  } catch (err) {
    if (pat && err instanceof GitError) {
      const redact = (s: string) => s.replaceAll(pat, "[REDACTED-PAT]");
      throw new GitError(redact(err.message), err.exitCode, redact(err.stderr));
    }
    throw err;
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
): { authUrl: string; pat: string } | undefined {
  if (auth.strategy === "none") return undefined;
  if (!auth.pat) return undefined;
  const authUrl = injectPat(url, auth.pat);
  if (!authUrl) return undefined;
  return { authUrl, pat: auth.pat };
}

/** Human-readable reason why PAT fallback was not attempted. Used in debug logs. */
function noPatFallbackReason(auth: GitAuth, isHttps: boolean): string {
  if (auth.strategy === "none") return "strategy=none";
  if (!auth.pat) return "PAT not configured";
  if (!isHttps) return "URL not HTTPS — cannot inject PAT";
  return "unknown";
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
  branch?: string,
): Promise<void> {
  const isHttps = url.startsWith("https://") || url.startsWith("https:");
  debug("gitClient", "clone ->", targetDir,
    `strategy=${auth.strategy} pat=${auth.pat ? "yes" : "no"} https=${isHttps}` +
    (branch ? ` branch=${branch}` : ""));
  const args = ["clone", "--depth", String(depth), "--single-branch"];
  if (branch) {
    args.push("-b", branch);
  }

  if (auth.strategy === "pat") {
    const authUrl = auth.pat ? injectPat(url, auth.pat) : undefined;
    if (authUrl && auth.pat) {
      await gitRedacted([...args, authUrl, targetDir], auth.pat);
      debug("gitClient", "clone: success (authenticated via PAT)");
    } else {
      await git([...args, url, targetDir]);
      debug("gitClient", "clone: success (PAT strategy but no injection possible)");
    }
    return;
  }

  // strategy "auto" or "none": try unauthenticated first
  try {
    await git([...args, url, targetDir], undefined, { noPrompt: true });
    debug("gitClient", "clone: success (unauthenticated)");
    return;
  } catch (firstErr) {
    const errMsg = firstErr instanceof GitError ? firstErr.message : String(firstErr);
    const retry = shouldRetryWithPat(auth, url);
    if (!retry) {
      debug("gitClient", `clone: unauthenticated failed: ${errMsg}, no PAT fallback (${noPatFallbackReason(auth, isHttps)})`);
      throw firstErr;
    }
    debug("gitClient", `clone: unauthenticated failed: ${errMsg}, retrying with PAT`);
    await gitRedacted([...args, retry.authUrl, targetDir], retry.pat);
    debug("gitClient", "clone: success (authenticated via PAT after retry)");
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
  branch?: string,
): Promise<void> {
  const isHttps = remoteUrl ? (remoteUrl.startsWith("https://") || remoteUrl.startsWith("https:")) : false;
  debug("gitClient", "fetch", repoDir,
    `strategy=${auth.strategy} pat=${auth.pat ? "yes" : "no"} https=${isHttps}` +
    (branch ? ` branch=${branch}` : ""));
  const refspec = branch ?? "HEAD";
  const baseArgs = ["-C", repoDir, "fetch", "--depth", "1", "origin"];
  if (branch) {
    baseArgs.push(branch);
  }

  if (auth.strategy === "pat" && auth.pat && remoteUrl) {
    const authUrl = injectPat(remoteUrl, auth.pat);
    if (authUrl) {
      await gitRedacted(
        ["-C", repoDir, "fetch", "--depth", "1", authUrl, refspec],
        auth.pat,
      );
      debug("gitClient", "fetch: success (authenticated via PAT)");
      return;
    }
  }

  // strategy "auto" or "none": try unauthenticated first
  try {
    await git(baseArgs, undefined, { noPrompt: true });
    debug("gitClient", "fetch: success (unauthenticated)");
    return;
  } catch (firstErr) {
    const errMsg = firstErr instanceof GitError ? firstErr.message : String(firstErr);
    if (!remoteUrl) {
      debug("gitClient", `fetch: unauthenticated failed: ${errMsg}, no remoteUrl for PAT retry`);
      throw firstErr;
    }
    const retry = shouldRetryWithPat(auth, remoteUrl);
    if (!retry) {
      debug("gitClient", `fetch: unauthenticated failed: ${errMsg}, no PAT fallback (${noPatFallbackReason(auth, isHttps)})`);
      throw firstErr;
    }
    debug("gitClient", `fetch: unauthenticated failed: ${errMsg}, retrying with PAT`);
    await gitRedacted(
      ["-C", repoDir, "fetch", "--depth", "1", retry.authUrl, refspec],
      retry.pat,
    );
    debug("gitClient", "fetch: success (authenticated via PAT after retry)");
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
  if (filePath.includes("\0") || /(^|\/)\.\.($|\/)/.test(filePath)) {
    throw new GitError(`unsafe file path: ${filePath}`, null, "");
  }
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

/**
 * List files in the repo at `HEAD`. Unlike {@link listFiles} (which reads the
 * git index and therefore counts staged-but-uncommitted files), this reads
 * the committed tree — matching downstream `git show HEAD:<path>` semantics
 * used by `readFile()`. Use this when validity must be defined against what
 * is committed, not what is staged.
 */
export async function listHeadFiles(repoDir: string): Promise<string[]> {
  const { stdout } = await git(["-C", repoDir, "ls-tree", "-r", "--name-only", "HEAD"]);
  return stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.length > 0);
}

// ── Connectivity check ──

export interface LsRemoteResult {
  reachable: boolean;
  /** Number of branch refs found (only set when reachable). */
  refCount?: number;
  /** Error message when not reachable (PAT-redacted). */
  error?: string;
  /** Which auth methods were attempted, in order. */
  attempts: Array<"unauthenticated" | "pat">;
  /** True when URL is HTTPS (PAT injection possible). */
  isHttps: boolean;
}

/**
 * Lightweight connectivity check via `git ls-remote --heads`.
 *
 * Never throws — returns a result object indicating reachability.
 * Auth behaviour mirrors {@link clone}: auto tries unauthenticated first
 * with PAT fallback, pat injects immediately, none skips credentials.
 */
export async function lsRemote(url: string, auth: GitAuth): Promise<LsRemoteResult> {
  const isHttps = url.startsWith("https://") || url.startsWith("https:");
  const attempts: LsRemoteResult["attempts"] = [];
  debug("gitClient", `lsRemote: checking ${url} strategy=${auth.strategy} pat=${auth.pat ? "yes" : "no"} https=${isHttps}`);

  const countRefs = (stdout: string): number =>
    stdout.trimEnd().split("\n").filter((l) => l.length > 0).length;

  try {
    // strategy "pat": inject PAT immediately
    if (auth.strategy === "pat") {
      const authUrl = auth.pat ? injectPat(url, auth.pat) : undefined;
      if (authUrl && auth.pat) {
        attempts.push("pat");
        const { stdout } = await gitRedacted(
          ["ls-remote", "--heads", authUrl], auth.pat, undefined, { noPrompt: true },
        );
        const refCount = countRefs(stdout);
        debug("gitClient", `lsRemote: reachable, ${refCount} branch refs (authenticated via PAT)`);
        return { reachable: true, refCount, attempts, isHttps };
      }
      // PAT strategy but cannot inject — try without
      attempts.push("unauthenticated");
      const { stdout } = await git(["ls-remote", "--heads", url], undefined, { noPrompt: true });
      const refCount = countRefs(stdout);
      debug("gitClient", `lsRemote: reachable, ${refCount} branch refs (PAT strategy but no injection)`);
      return { reachable: true, refCount, attempts, isHttps };
    }

    // strategy "auto" or "none": try unauthenticated first
    attempts.push("unauthenticated");
    try {
      const { stdout } = await git(["ls-remote", "--heads", url], undefined, { noPrompt: true });
      const refCount = countRefs(stdout);
      debug("gitClient", `lsRemote: reachable, ${refCount} branch refs (unauthenticated)`);
      return { reachable: true, refCount, attempts, isHttps };
    } catch (firstErr) {
      const errMsg = firstErr instanceof GitError ? firstErr.message : String(firstErr);
      const retry = shouldRetryWithPat(auth, url);
      if (!retry) {
        debug("gitClient", `lsRemote: unauthenticated failed: ${errMsg}, no PAT fallback (${noPatFallbackReason(auth, isHttps)})`);
        throw firstErr;
      }
      debug("gitClient", `lsRemote: unauthenticated failed: ${errMsg}, retrying with PAT`);
      attempts.push("pat");
      const { stdout } = await gitRedacted(
        ["ls-remote", "--heads", retry.authUrl], retry.pat, undefined, { noPrompt: true },
      );
      const refCount = countRefs(stdout);
      debug("gitClient", `lsRemote: reachable, ${refCount} branch refs (authenticated via PAT after retry)`);
      return { reachable: true, refCount, attempts, isHttps };
    }
  } catch (err) {
    const errMsg = err instanceof GitError ? err.message : String(err);
    debug("gitClient", `lsRemote: unreachable — ${errMsg}`);
    return { reachable: false, error: errMsg, attempts, isHttps };
  }
}
