import * as gitClient from "./gitClient.js";

const CSPROJ_RE = /[^/]+\.csproj$/i;

export interface RepoValidationResult {
  valid: boolean;
  csprojCount: number;
  /** Absolute path that was inspected. */
  checkedPath: string;
}

/** Resolved-repo mode label used to tailor the error fix-line. */
export type ValidationRepoMode = "local" | "managed";

/**
 * Check whether a resolved repo on disk is a .NET C# repository — i.e. its
 * tracked git tree contains at least one `*.csproj` file (case-insensitive,
 * non-empty stem). `*.cs` files alone do not count, and `.vbproj`/`.fsproj`
 * do not count (mcp-digger only handles C# syntax).
 *
 * Reads tracked content via `git ls-files` so an uncommitted `.csproj` in
 * the working tree is intentionally ignored — every other mcp-digger tool
 * also reads from `HEAD`, so the validity criterion matches downstream
 * behaviour.
 */
export async function validateNetCSharpRepo(
  repoPath: string,
): Promise<RepoValidationResult> {
  const files = await gitClient.listFiles(repoPath);
  let count = 0;
  for (const f of files) {
    if (CSPROJ_RE.test(f)) count++;
  }
  return {
    valid: count > 0,
    csprojCount: count,
    checkedPath: repoPath,
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
