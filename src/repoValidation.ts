import * as gitClient from "./gitClient.js";

const CSPROJ_RE = /[^/]+\.csproj$/i;

export interface RepoValidationResult {
  valid: boolean;
  csprojCount: number;
}

/** Resolved-repo mode label used to tailor the error fix-line. */
export type ValidationRepoMode = "local" | "managed";

/**
 * Check whether a resolved repo on disk is a .NET C# repository — i.e. its
 * committed git tree (`HEAD`) contains at least one `*.csproj` file
 * (case-insensitive, non-empty stem). `*.cs` files alone do not count, and
 * `.vbproj`/`.fsproj` do not count (mcp-digger only handles C# syntax).
 *
 * Reads `HEAD` via `git ls-tree` (not the index via `git ls-files`) so a
 * staged-but-uncommitted `.csproj` does NOT make the repo pass validation
 * — every other mcp-digger tool reads from `HEAD` (`git show HEAD:<path>`),
 * so the validity criterion must match downstream behaviour. Working-tree
 * and index-only `.csproj` files are intentionally ignored.
 */
export async function validateNetCSharpRepo(
  repoPath: string,
): Promise<RepoValidationResult> {
  const files = await gitClient.listHeadFiles(repoPath);
  let count = 0;
  for (const f of files) {
    if (CSPROJ_RE.test(f)) count++;
  }
  return {
    valid: count > 0,
    csprojCount: count,
  };
}

/**
 * Build the user-facing error message surfaced when a repo fails .NET C#
 * validation. Includes the repo name, the resolved path that was checked,
 * and a mode-specific fix hint so the user knows whether to inspect their
 * `localPath` or `url`.
 */
export function buildNotNetCSharpError(
  repoName: string,
  checkedPath: string,
  mode: ValidationRepoMode = "managed",
): string {
  const fixHint =
    mode === "local"
      ? "verify the `localPath` configured for this repo points to a .NET C# repository"
      : "verify the configured repo URL points to a .NET C# repository";
  return (
    `Repo '${repoName}' is not a valid .NET C# repository.\n` +
    `mcp-digger only supports .NET C# repositories, but no .csproj file was found in the tracked git tree.\n` +
    `Checked path: ${checkedPath}\n` +
    `Fix: ${fixHint}, and that .csproj files are committed (not untracked).`
  );
}
