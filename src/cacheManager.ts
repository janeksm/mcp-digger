import * as fs from "node:fs";
import * as path from "node:path";
import type { PackageConfig } from "./config.js";
import { debug } from "./logger.js";

// ── Meta file schema ──

interface RepoMeta {
  commitHash: string;
  updatedAt: string; // ISO 8601
}

const OVERVIEW_FILE = "overview.md";
const INDEX_FILE = "index.dat";

// ── Public API ──

/**
 * Check whether the cache for a repo is fresh (matches the given commit hash).
 */
export async function isFresh(
  cacheDir: string,
  repoName: string,
  currentHash: string,
): Promise<boolean> {
  const meta = await readMeta(cacheDir, repoName);
  const fresh = meta !== undefined && meta.commitHash === currentHash;
  debug("cacheManager", "isFresh:", repoName,
    "current=" + currentHash.slice(0, 8),
    "cached=" + (meta?.commitHash?.slice(0, 8) ?? "none"),
    "-> " + fresh);
  return fresh;
}

/**
 * Record that a repo's cache is now up to date at the given commit.
 */
export async function markFresh(
  cacheDir: string,
  repoName: string,
  commitHash: string,
): Promise<void> {
  debug("cacheManager", "markFresh:", repoName, commitHash.slice(0, 8));
  const metaPath = metaFilePath(cacheDir, repoName);
  await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
  const meta: RepoMeta = {
    commitHash,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = metaPath + ".tmp";
  await fs.promises.writeFile(tmpPath, JSON.stringify(meta, null, 2));
  await fs.promises.rename(tmpPath, metaPath);
}

/**
 * Invalidate cache for a repo: delete its meta file and all package cache dirs
 * that belong to it.
 */
export async function invalidate(
  cacheDir: string,
  repoName: string,
  packages: readonly PackageConfig[],
): Promise<void> {
  debug("cacheManager", "invalidate:", repoName, packages.length, "packages");
  const metaPath = metaFilePath(cacheDir, repoName);
  await fs.promises.rm(metaPath, { force: true });

  await Promise.all(
    packages
      .filter((p) => p.repoName === repoName)
      .map((p) => fs.promises.rm(p.cachePath, { recursive: true, force: true })),
  );
}

/**
 * Write a package's overview markdown to its cache directory.
 */
export async function writeOverview(
  pkg: PackageConfig,
  content: string,
): Promise<void> {
  await fs.promises.mkdir(pkg.cachePath, { recursive: true });
  await fs.promises.writeFile(path.join(pkg.cachePath, OVERVIEW_FILE), content);
}

/**
 * Read a package's cached overview markdown. Returns undefined if not cached.
 */
export async function readOverview(
  pkg: PackageConfig,
): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path.join(pkg.cachePath, OVERVIEW_FILE), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Write a package's symbol index to its cache directory (atomic).
 */
export async function writeIndex(
  pkg: PackageConfig,
  content: string,
): Promise<void> {
  await fs.promises.mkdir(pkg.cachePath, { recursive: true });
  const target = path.join(pkg.cachePath, INDEX_FILE);
  const tmpPath = target + ".tmp";
  await fs.promises.writeFile(tmpPath, content);
  await fs.promises.rename(tmpPath, target);
}

/**
 * Read a package's cached symbol index. Returns undefined if not cached.
 */
export async function readIndex(
  pkg: PackageConfig,
): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path.join(pkg.cachePath, INDEX_FILE), "utf-8");
  } catch {
    return undefined;
  }
}

// ── Internal ──

function safeRepoSlug(repoName: string): string {
  return repoName.replace(/\*+$/, "").replace(/\.+$/, "");
}

function metaFilePath(cacheDir: string, repoName: string): string {
  return path.join(cacheDir, "meta", `${safeRepoSlug(repoName)}.json`);
}

async function readMeta(cacheDir: string, repoName: string): Promise<RepoMeta | undefined> {
  try {
    const raw = await fs.promises.readFile(metaFilePath(cacheDir, repoName), "utf-8");
    const parsed = JSON.parse(raw) as RepoMeta;
    if (typeof parsed.commitHash === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
