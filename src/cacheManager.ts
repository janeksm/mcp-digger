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
const SIGNATURES_DIR = "signatures";

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
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
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
 * Write a stripped .cs signature file to a package's cache.
 * `relPath` is the repo-relative path (e.g. "src/MyLib/Class1.cs").
 */
export async function writeSignature(
  pkg: PackageConfig,
  relPath: string,
  content: string,
): Promise<void> {
  const sigPath = path.join(pkg.cachePath, SIGNATURES_DIR, relPath);
  await fs.promises.mkdir(path.dirname(sigPath), { recursive: true });
  await fs.promises.writeFile(sigPath, content);
}

/**
 * Read all cached signature files for a package.
 * Returns an array of { filePath, content } sorted by path.
 */
export async function readSignatures(
  pkg: PackageConfig,
): Promise<Array<{ filePath: string; content: string }>> {
  const sigDir = path.join(pkg.cachePath, SIGNATURES_DIR);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sigDir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const fileEntries = entries.filter((e) => e.isFile());
  const results = await Promise.all(
    fileEntries.map(async (entry) => {
      const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
      const content = await fs.promises.readFile(fullPath, "utf-8");
      const relPath = path.relative(sigDir, fullPath).replace(/\\/g, "/");
      return { filePath: relPath, content };
    }),
  );

  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
}

// ── Internal ──

function metaFilePath(cacheDir: string, repoName: string): string {
  return path.join(cacheDir, "meta", `${repoName}.json`);
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
