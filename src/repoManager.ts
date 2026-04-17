import * as fs from "node:fs";
import type { DiggerConfig, RepoConfig } from "./config.js";
import { discoverPackages } from "./config.js";
import * as gitClient from "./gitClient.js";
import { debug } from "./logger.js";

// ── Result type ──

export interface RepoReadyResult {
  /** Absolute path to the repo root on disk. */
  sourcePath: string;
  /** Current HEAD commit hash. */
  currentHash: string;
  /** Which mode was used: "local" (Mode B) or "managed" (Mode A). */
  mode: "local" | "managed";
  /** Non-fatal warning (e.g. fallback from local to managed). */
  warning?: string;
}

// ── Public API ──

/**
 * Ensure a repo is on disk and ready to read.
 *
 * - **Mode B (local)**: if `localPath` is set and is a valid git repo, use it read-only.
 *   If `localPath` is set but invalid/missing AND `url` is configured, fall back to Mode A with a warning.
 * - **Mode A (managed)**: clone into `managedSourcePath` if not already there, then fetch.
 *
 * For repos with `discoveryMode === "auto"`, calls `discoverPackages()` after the repo
 * is on disk and mutates `repoConfig.packages` in place.
 */
export async function ensureReady(
  repoConfig: RepoConfig,
  config: DiggerConfig,
): Promise<RepoReadyResult> {
  debug("repoManager", "ensureReady:", repoConfig.name,
    "localPath=" + (repoConfig.localPath ?? "none"),
    "url=" + (repoConfig.url ? "yes" : "none"));
  let result: RepoReadyResult;

  // Try Mode B (local path) first
  if (repoConfig.localPath) {
    const valid = await gitClient.isValidRepo(repoConfig.localPath);
    if (valid) {
      debug("repoManager", repoConfig.name, "using local path");
      const currentHash = await gitClient.revParse(repoConfig.localPath, "HEAD");
      result = {
        sourcePath: repoConfig.localPath,
        currentHash,
        mode: "local",
      };
    } else if (repoConfig.url) {
      debug("repoManager", repoConfig.name, "local path invalid, falling back to managed");
      // Fallback: local path invalid but URL available → Mode A with warning
      result = await ensureManaged(repoConfig);
      result.warning =
        `Local path '${repoConfig.localPath}' for repo '${repoConfig.name}' is not a valid git repo. ` +
        `Falling back to managed clone.`;
    } else {
      throw new Error(
        `Repo '${repoConfig.name}': localPath '${repoConfig.localPath}' is not a valid git repo and no URL is configured for fallback.`,
      );
    }
  } else {
    // No local path → Mode A (managed)
    result = await ensureManaged(repoConfig);
  }

  debug("repoManager", repoConfig.name, "ready hash=" + result.currentHash, "mode=" + result.mode);

  // Auto-discover packages if needed
  if (repoConfig.discoveryMode === "auto" && repoConfig.packages.length === 0) {
    const discovered = await discoverPackages(
      result.sourcePath,
      repoConfig,
      config.cacheDir,
    );
    repoConfig.packages = discovered;
    debug("repoManager", repoConfig.name, "discovered", discovered.length, "packages");
  }

  return result;
}

/**
 * Ensure all repos in config are ready. Processes repos sequentially to avoid
 * concurrent git operations competing for network/disk.
 */
export async function ensureAllReady(
  config: DiggerConfig,
): Promise<Map<string, RepoReadyResult>> {
  const results = new Map<string, RepoReadyResult>();
  for (const repo of config.repos) {
    results.set(repo.name, await ensureReady(repo, config));
  }
  return results;
}

// ── Internal ──

async function ensureManaged(
  repoConfig: RepoConfig,
): Promise<RepoReadyResult> {
  if (!repoConfig.url) {
    throw new Error(
      `Repo '${repoConfig.name}': no URL configured for managed clone.`,
    );
  }

  const targetDir = repoConfig.managedSourcePath;
  const alreadyCloned = await gitClient.isValidRepo(targetDir);

  if (!alreadyCloned) {
    debug("repoManager", repoConfig.name, "cloning to", targetDir);
    // Remove any partial clone remnant (force: true is a no-op if path doesn't exist)
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await gitClient.clone(repoConfig.url, targetDir, repoConfig.auth);
  } else {
    debug("repoManager", repoConfig.name, "fetching updates");
    await gitClient.fetch(targetDir, repoConfig.auth, repoConfig.url);
  }

  // For fresh clones HEAD is already the latest; for fetched repos use FETCH_HEAD
  const ref = alreadyCloned ? "FETCH_HEAD" : "HEAD";
  const currentHash = await gitClient.revParse(targetDir, ref);

  return {
    sourcePath: targetDir,
    currentHash,
    mode: "managed",
  };
}
