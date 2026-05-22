import { z } from "zod";
import type { DiggerConfig, PackageConfig, RepoConfig } from "../config.js";
import { findPackage, formatUnknownPackage } from "../config.js";
import { error as logError } from "../logger.js";
import { withRepoLock } from "../repoLock.js";
import { ensureReady, type RepoReadyResult } from "../repoManager.js";

export const PACKAGE_NAME_PARAM = z.string().describe("Exact name of the NuGet package (e.g. 'MyCompany.Core')");

export const FILE_CHAR_LIMIT = 1_000_000;

export interface ToolResult {
  text: string;
  isError: boolean;
}

export function toolSuccess(text: string): ToolResult {
  return { text, isError: false };
}

export function toolError(text: string): ToolResult {
  return { text, isError: true };
}

export function toCallToolResult(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    ...(result.isError && { isError: true }),
  };
}

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function requirePackage(
  config: DiggerConfig,
  packageName: string,
): { pkg: PackageConfig; repo: RepoConfig } | ToolResult {
  const pkg = findPackage(config, packageName);
  if (!pkg) return toolError(formatUnknownPackage(config, packageName));
  const repo = config.repos.find((r) => r.name === pkg.repoName)!;
  return { pkg, repo };
}

export async function withRepoReady(
  repo: RepoConfig,
  config: DiggerConfig,
  toolName: string,
  fn: (result: RepoReadyResult) => Promise<ToolResult>,
): Promise<ToolResult> {
  return withRepoLock(repo.name, async () => {
    try {
      const result = await ensureReady(repo, config);
      if (result.error) {
        // result.error already names the repo — pass through verbatim.
        return toolError(result.error);
      }
      return await fn(result);
    } catch (err) {
      const msg = extractErrorMessage(err);
      logError(toolName, `repo '${repo.name}':`, msg);
      return toolError(`Repo '${repo.name}': ${msg}`);
    }
  });
}
