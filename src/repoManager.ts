import * as fs from "node:fs";
import type { DiggerConfig, PackageConfig, RepoConfig } from "./config.js";
import { discoverPackages } from "./config.js";
import * as gitClient from "./gitClient.js";
import { debug } from "./logger.js";
import { withRepoLock } from "./repoLock.js";
import {
  scanCachePath,
  scanWorkspace,
  writeScanCache,
  type ScanResult,
} from "./solutionScanner.js";

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
  /**
   * Non-fatal per-repo error. Set when a wildcard repo ends up with zero
   * matched packages. Tools should surface this text verbatim instead of
   * (or alongside) rendering the repo's contents.
   */
  error?: string;
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
 *
 * For repos with `discoveryMode === "wildcard"`, intersects on-disk candidates with
 * workspace-scanned package references filtered by `namePrefix`. If the scan has
 * not been provided (solo `ensureReady` call), it is performed inline for the
 * current workspace.
 */
export async function ensureReady(
  repoConfig: RepoConfig,
  config: DiggerConfig,
  scanResult?: ScanResult,
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

  // Wildcard: intersect on-disk candidates with solution-referenced packages
  if (repoConfig.discoveryMode === "wildcard") {
    const candidates = await discoverPackages(
      result.sourcePath,
      repoConfig,
      config.cacheDir,
    );
    const scan = scanResult ?? (await scanAndCache(config));
    applyWildcardMatch(repoConfig, result, scan, config, candidates);
  }

  return result;
}

/**
 * Ensure all repos in config are ready. Processes repos sequentially to avoid
 * concurrent git operations competing for network/disk.
 *
 * If any repo has `discoveryMode === "wildcard"`, scans the workspace once
 * up-front and shares the result across all repos — and writes it to the
 * cache file so other tools (e.g. `dig_status`) can read it without re-scanning.
 *
 * Per-repo failures are captured as `error` on the returned result rather than
 * thrown, so a single bad repo cannot break downstream tools for the others.
 */
export async function ensureAllReady(
  config: DiggerConfig,
): Promise<Map<string, RepoReadyResult>> {
  const needsScan = config.repos.some((r) => r.discoveryMode === "wildcard");
  const scan = needsScan ? await scanAndCache(config) : undefined;

  const results = new Map<string, RepoReadyResult>();
  for (const repo of config.repos) {
    try {
      results.set(repo.name, await withRepoLock(repo.name, () => ensureReady(repo, config, scan)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug("repoManager", repo.name, "ensureReady threw:", msg);
      results.set(repo.name, {
        sourcePath: "",
        currentHash: "",
        mode: repo.localPath ? "local" : "managed",
        error: msg,
      });
    }
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

async function scanAndCache(config: DiggerConfig): Promise<ScanResult> {
  const scan = await scanWorkspace(config.workspaceRoot);
  await writeScanCache(config.cacheDir, scan);
  return scan;
}

function applyWildcardMatch(
  repoConfig: RepoConfig,
  result: RepoReadyResult,
  scan: ScanResult,
  config: DiggerConfig,
  candidates: PackageConfig[],
): void {
  // namePrefix is always set when discoveryMode === "wildcard" (loadConfig).
  const prefix = repoConfig.namePrefix!;
  const referenced = new Set(scan.packages);

  const matched = candidates.filter(
    (c) => referenced.has(c.name) && c.name.startsWith(prefix),
  );
  repoConfig.packages = matched;

  debug(
    "repoManager",
    repoConfig.name,
    `wildcard: referenced=${referenced.size}`,
    `candidates=${candidates.length}`,
    `matched=${matched.length}`,
  );

  if (matched.length === 0) {
    result.error = buildWildcardEmptyError(
      repoConfig,
      scan,
      candidates.length,
      config,
    );
  }
}

function buildWildcardEmptyError(
  repoConfig: RepoConfig,
  scan: ScanResult,
  candidateCount: number,
  config: DiggerConfig,
): string {
  const prefix = repoConfig.namePrefix!;
  const cachePath = scanCachePath(config.cacheDir);
  return (
    `Wildcard repo '${repoConfig.name}' (prefix '${prefix}') matched zero packages.\n` +
    `Workspace scan found ${scan.packages.length} referenced package(s) ` +
    `across ${scan.solutionFiles.length} solution file(s), ` +
    `${scan.directoryPackagesProps.length} Directory.Packages.props, ` +
    `${scan.directoryBuildProps.length} Directory.Build.props, ` +
    `${scan.directoryBuildTargets.length} Directory.Build.targets.\n` +
    `Intersected with ${candidateCount} package(s) discovered in the repo → 0 matches.\n` +
    `Fix: either add an explicit 'packages' list to this repo in ${config.configPath}, ` +
    `or verify the solution / props files at ${scan.workspaceRoot} reference the expected packages.\n` +
    `Scan details cached at ${cachePath}.`
  );
}
