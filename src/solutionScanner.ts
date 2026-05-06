import * as fs from "node:fs";
import * as path from "node:path";
import { debug } from "./logger.js";

// ── Public types ──

export interface ScanResult {
  /** ISO timestamp when the scan was performed. */
  scannedAt: string;
  /** Absolute path of the scanned workspace root. */
  workspaceRoot: string;
  /** Absolute paths to .sln / .slnx files found anywhere under workspaceRoot. */
  solutionFiles: string[];
  /** Absolute paths to .csproj files discovered via solution references. */
  csprojFiles: string[];
  /** Absolute paths to every Directory.Packages.props found. */
  directoryPackagesProps: string[];
  /** Absolute paths to every Directory.Build.props found. */
  directoryBuildProps: string[];
  /** Absolute paths to every Directory.Build.targets found. */
  directoryBuildTargets: string[];
  /** Sorted, deduped union of every referenced package name. */
  packages: string[];
  /** Non-fatal issues encountered during the scan (e.g. csproj referenced but missing). */
  warnings: string[];
}

// ── Constants ──

const SCAN_CACHE_FILENAME = "solution-scan.json";

const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".digger",
  "node_modules",
  "bin",
  "obj",
  ".vs",
  ".idea",
  "packages",
]);

const SLN_PROJECT_RE =
  /Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gi;
const SLNX_PROJECT_RE = /<Project\s+[^>]*Path\s*=\s*"([^"]+\.csproj)"/gi;
const PACKAGE_REFERENCE_RE =
  /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi;
const PACKAGE_VERSION_RE =
  /<PackageVersion\s+[^>]*Include\s*=\s*"([^"]+)"/gi;

// ── Public API ──

/**
 * Walk the workspace recursively, collecting every `.sln`, `.slnx`,
 * `Directory.Packages.props`, `Directory.Build.props`, and
 * `Directory.Build.targets` file. Parse each for package references and
 * return a deduped union.
 *
 * Never throws — per-file read errors are pushed into `warnings` and the
 * scan continues.
 */
export async function scanWorkspace(workspaceRoot: string): Promise<ScanResult> {
  debug("solutionScanner", "scanWorkspace:", workspaceRoot);

  const collected: WalkCollected = {
    slnFiles: [],
    slnxFiles: [],
    packagesPropsFiles: [],
    buildPropsFiles: [],
    buildTargetsFiles: [],
  };
  const warnings: string[] = [];

  await walkTree(workspaceRoot, collected, warnings);

  const csprojPaths = await collectCsprojPaths(
    collected.slnFiles,
    collected.slnxFiles,
    warnings,
  );

  // Scan per file type in parallel; regexes are distinct per type.
  const [csprojRefs, packagesPropsRefs, buildPropsRefs, buildTargetsRefs] =
    await Promise.all([
      extractFromFiles(Array.from(csprojPaths), [PACKAGE_REFERENCE_RE], warnings),
      extractFromFiles(
        collected.packagesPropsFiles,
        [PACKAGE_VERSION_RE, PACKAGE_REFERENCE_RE],
        warnings,
      ),
      extractFromFiles(
        collected.buildPropsFiles,
        [PACKAGE_REFERENCE_RE],
        warnings,
      ),
      extractFromFiles(
        collected.buildTargetsFiles,
        [PACKAGE_REFERENCE_RE],
        warnings,
      ),
    ]);

  const packages = new Set<string>([
    ...csprojRefs,
    ...packagesPropsRefs,
    ...buildPropsRefs,
    ...buildTargetsRefs,
  ]);

  const result: ScanResult = {
    scannedAt: new Date().toISOString(),
    workspaceRoot,
    solutionFiles: [...collected.slnFiles, ...collected.slnxFiles].sort(),
    csprojFiles: [...csprojPaths].sort(),
    directoryPackagesProps: [...collected.packagesPropsFiles].sort(),
    directoryBuildProps: [...collected.buildPropsFiles].sort(),
    directoryBuildTargets: [...collected.buildTargetsFiles].sort(),
    packages: [...packages].sort(),
    warnings,
  };

  debug(
    "solutionScanner",
    `scan complete: ${result.solutionFiles.length} solution(s),`,
    `${result.csprojFiles.length} csproj,`,
    `${result.directoryPackagesProps.length} packages.props,`,
    `${result.directoryBuildProps.length} build.props,`,
    `${result.directoryBuildTargets.length} build.targets,`,
    `${result.packages.length} package refs`,
  );

  return result;
}

/** Write the scan result to `<cacheDir>/solution-scan.json` atomically. */
export async function writeScanCache(
  cacheDir: string,
  result: ScanResult,
): Promise<string> {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, SCAN_CACHE_FILENAME);
  const tmp = target + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(result, null, 2), "utf-8");
  await fs.promises.rename(tmp, target);
  debug("solutionScanner", "cache written:", target);
  return target;
}

/**
 * Read the cached scan result, if present. Returns null when the file is
 * missing or unreadable — callers should treat that as "no scan yet".
 */
export async function readScanCache(cacheDir: string): Promise<ScanResult | null> {
  const target = path.join(cacheDir, SCAN_CACHE_FILENAME);
  try {
    const raw = await fs.promises.readFile(target, "utf-8");
    const parsed = JSON.parse(raw) as ScanResult;
    return { ...parsed };
  } catch {
    return null;
  }
}

/** Absolute path of the scan-cache file for a given cacheDir. */
export function scanCachePath(cacheDir: string): string {
  return path.join(cacheDir, SCAN_CACHE_FILENAME);
}

// ── Internals ──

interface WalkCollected {
  slnFiles: string[];
  slnxFiles: string[];
  packagesPropsFiles: string[];
  buildPropsFiles: string[];
  buildTargetsFiles: string[];
}

async function collectCsprojPaths(
  slnFiles: string[],
  slnxFiles: string[],
  warnings: string[],
): Promise<Set<string>> {
  const csprojPaths = new Set<string>();
  const all = [
    ...slnFiles.map((f) => ({ path: f, re: SLN_PROJECT_RE })),
    ...slnxFiles.map((f) => ({ path: f, re: SLNX_PROJECT_RE })),
  ];
  const reads = await Promise.all(all.map((f) => safeRead(f.path, warnings)));
  for (let i = 0; i < all.length; i++) {
    const content = reads[i];
    if (content === undefined) continue;
    const dir = path.dirname(all[i]!.path);
    for (const rel of matchAll(all[i]!.re, content)) {
      const normalised = rel.replace(/\\/g, "/");
      csprojPaths.add(path.resolve(dir, normalised));
    }
  }
  return csprojPaths;
}

async function extractFromFiles(
  filePaths: string[],
  regexes: RegExp[],
  warnings: string[],
): Promise<string[]> {
  if (filePaths.length === 0) return [];
  const contents = await Promise.all(
    filePaths.map((p) => safeRead(p, warnings)),
  );
  const names: string[] = [];
  for (const content of contents) {
    if (content === undefined) continue;
    for (const re of regexes) {
      for (const name of matchAll(re, content)) names.push(name);
    }
  }
  return names;
}

async function walkTree(
  dir: string,
  collected: WalkCollected,
  warnings: string[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`cannot read dir ${dir}: ${msg}`);
    debug("solutionScanner", "readdir failed:", dir, msg);
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkTree(full, collected, warnings);
      continue;
    }

    if (!entry.isFile()) continue;

    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".sln")) {
      collected.slnFiles.push(full);
    } else if (lower.endsWith(".slnx")) {
      collected.slnxFiles.push(full);
    } else if (lower === "directory.packages.props") {
      collected.packagesPropsFiles.push(full);
    } else if (lower === "directory.build.props") {
      collected.buildPropsFiles.push(full);
    } else if (lower === "directory.build.targets") {
      collected.buildTargetsFiles.push(full);
    }
  }
}

async function safeRead(
  filePath: string,
  warnings: string[],
): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const detail =
      e.code === "ENOENT"
        ? `file not found: ${filePath}`
        : `cannot read ${filePath}: ${e.message}`;
    warnings.push(detail);
    debug("solutionScanner", "read failed:", filePath, e.message);
    return undefined;
  }
}

function* matchAll(re: RegExp, content: string): Iterable<string> {
  // Defensive reset: module-scoped /g regex can be left mid-iteration after
  // an earlier throw (yield inside the for-of can be interrupted).
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) yield m[1];
  }
}
