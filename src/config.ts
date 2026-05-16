import * as fs from "node:fs";
import * as path from "node:path";
import { debug } from "./logger.js";

// ── Config file schema (what .digger/config.json contains) ──

export type AuthStrategy = "auto" | "pat" | "none";

/**
 * Auth config block under a repo. `PAT` and `PAT-EnvVarName` are mutually
 * exclusive — use inline for quick testing, env var indirection for anything
 * that lands in the committed config.
 */
export interface AuthFile {
  strategy?: AuthStrategy;
  PAT?: string;
  "PAT-EnvVarName"?: string;
}

export interface RepoDefinition {
  name: string;
  url?: string;
  branch?: string; // git branch to clone/track (default: repo default branch)
  sourceRoot?: string; // default "src"
  packages?: string[]; // if omitted → auto-discover at runtime
  packageFilter?: string; // e.g. "MyCompany.*" — mutually exclusive with packages
  auth?: AuthFile;
}

export interface ConfigFile {
  debug?: boolean; // default false
  /** Map of repo name → absolute or cwd-relative path to developer's local clone (Mode B). */
  localRepos?: Record<string, string>;
  repos: RepoDefinition[];
}

// ── Resolved config (after merging file + env vars) ──

export interface RepoConfig {
  name: string;
  url?: string;
  /** Git branch to clone/track for managed repos. Undefined = repo default branch. */
  branch?: string;
  /** Absolute path to developer's local clone (Mode B), from `localRepos`. */
  localPath?: string;
  /** Absolute target dir for managed clones: `<managedSourceDir>/<slug>`. */
  managedSourcePath: string;
  /** Relative path within repo where package dirs live (default "src"). */
  sourceRoot: string;
  /**
   * - `"explicit"`: packages listed in config file.
   * - `"auto"`: scan repo on disk for every non-test `.csproj` dir.
   * - `"wildcard"`: driven by `packageFilter` field; intersect (solution-referenced ∩ filter prefix ∩ on-disk candidates).
   */
  discoveryMode: "explicit" | "auto" | "wildcard";
  /**
   * Only set when `packageFilter` is present in config. The raw glob value,
   * e.g. `"MyCompany.*"`. Prefix is derived at point of use via `.slice(0, -1)`.
   */
  packageFilter?: string;
  /** Populated immediately for explicit, lazily (by discoverPackages / wildcard) for auto and wildcard. */
  packages: PackageConfig[];
  /** Resolved git auth for this repo. Never undefined — defaults to `{ strategy: "auto" }`. */
  auth: GitAuth;
}

export interface PackageConfig {
  name: string;
  /** Name of the parent repo (matches RepoConfig.name). */
  repoName: string;
  /** Repo-relative path using forward slashes, e.g. "src/MyCompany.Core". */
  pathInRepo: string;
  /** Absolute cache dir for this package: `<cacheDir>/<packageName>`. */
  cachePath: string;
}

/**
 * Resolved git auth config.
 * - `auto`: try unauthenticated first, fall back to PAT if set and clone fails.
 * - `pat`: always inject PAT into HTTPS URLs (fatal error if PAT not set).
 * - `none`: never use credentials, even if PAT is set.
 */
export interface GitAuth {
  strategy: AuthStrategy;
  /** Resolved Personal Access Token. Undefined when not set or strategy is "none". */
  pat?: string;
}

export interface DiggerConfig {
  workspaceRoot: string;
  /** Absolute path to the config file that was read. */
  configPath: string;
  managedSourceDir: string;
  cacheDir: string;
  debug: boolean;
  repos: RepoConfig[];
  warnings: string[];
}

/** Thrown when configuration is invalid. Aggregates all problems found in one pass. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      "mcp-digger configuration is invalid:\n  - " + problems.join("\n  - "),
    );
    this.name = "ConfigError";
  }
}

// ── Defaults ──

export const DEFAULT_CONFIG_PATH = ".digger/config.json";
const DEFAULT_MANAGED_SOURCE_DIR = ".digger/source";
const DEFAULT_CACHE_DIR = ".digger/cache";
const DEFAULT_SOURCE_ROOT = "src";
const DEFAULT_AUTH_STRATEGY: AuthStrategy = "auto";
const VALID_AUTH_STRATEGIES: ReadonlySet<AuthStrategy> = new Set<AuthStrategy>(["auto", "pat", "none"]);

const MAX_DISCOVERED_PACKAGES = 200;

const TEST_PROJECT_SUFFIXES = [
  ".Tests",
  ".Specs",
  ".Benchmarks",
  ".IntegrationTests",
];

// ── Helpers ──

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_NAME_HINT = "Names must match /^[A-Za-z0-9._-]+$/.";

export function isValidPackageName(name: string): boolean {
  if (name === "." || name === "..") return false;
  return SAFE_NAME_RE.test(name);
}

export function filterPrefix(packageFilter: string): string {
  return packageFilter.slice(0, -1);
}

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export function validateBranchName(branch: string): string | undefined {
  if (!branch.trim()) return "branch name must not be empty.";
  if (branch.startsWith("-")) return "branch name must not start with '-'.";
  if (branch.startsWith("/") || branch.endsWith("/")) return "branch name must not start or end with '/'.";
  if (branch.includes("..")) return "branch name must not contain '..'.";
  if (branch.includes("//")) return "branch name must not contain '//'.";
  if (branch.includes("\\")) return "branch name must not contain backslashes.";
  if (!BRANCH_NAME_RE.test(branch)) return "branch name contains invalid characters. Allowed: letters, digits, '.', '_', '/', '-'.";
  return undefined;
}

const SSH_SHORTHAND_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:.+$/;
const ALLOWED_URL_SCHEMES = new Set(["https:", "ssh:"]);

export function validateRepoUrl(url: string): string | undefined {
  if (SSH_SHORTHAND_RE.test(url)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a valid URL or SSH shorthand (git@host:path).";
  }

  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    return `uses scheme '${parsed.protocol}' which is not allowed. Use https:// or ssh://.`;
  }

  return undefined;
}

function buildPackageConfig(
  name: string,
  repoName: string,
  sourceRoot: string,
  cacheDir: string,
): PackageConfig {
  return {
    name,
    repoName,
    pathInRepo: sourceRoot === "." ? name : `${sourceRoot}/${name}`,
    cachePath: path.join(cacheDir, name),
  };
}

// ── .env file loading ──

/**
 * Parse a `.env` file into key-value pairs.
 * Supports `KEY=VALUE`, `# comments`, blank lines, and optional quoting
 * (single or double quotes stripped from values). Inline comments after
 * unquoted values are supported with ` #`.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trimEnd();
      }
    }

    result.set(key, value);
  }
  return result;
}

/**
 * Load `.env` file from the workspace root and merge into env vars.
 * Actual environment variables take precedence — `.env` only fills in
 * values that are not already set.
 *
 * Returns a new object; the original `env` is not mutated.
 */
function mergeEnvFile(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const envFilePath = path.join(cwd, ".env");
  let content: string;
  try {
    content = fs.readFileSync(envFilePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return env;
    throw err;
  }

  const fileVars = parseEnvFile(content);
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of fileVars) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

// ── Per-repo auth resolution ──

function isValidStrategy(v: string): v is AuthStrategy {
  return VALID_AUTH_STRATEGIES.has(v as AuthStrategy);
}

/**
 * Resolve a repo's `auth` block into a {@link GitAuth}. Applies mutual
 * exclusion checks between inline `PAT` and `PAT-EnvVarName`, env var
 * lookup, and strategy validation.
 *
 * Returns problems alongside the resolved auth so the caller can aggregate
 * across repos without managing shared accumulator arrays.
 */
function resolveRepoAuth(
  authFile: AuthFile | undefined,
  env: NodeJS.ProcessEnv,
  repoName: string,
): { auth: GitAuth; errors: string[]; warnings: string[] } {
  if (!authFile) {
    return { auth: { strategy: DEFAULT_AUTH_STRATEGY }, errors: [], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Strategy
  const rawStrategy = authFile.strategy?.trim().toLowerCase();
  let strategy: AuthStrategy = DEFAULT_AUTH_STRATEGY;
  if (rawStrategy) {
    if (isValidStrategy(rawStrategy)) {
      strategy = rawStrategy;
    } else {
      errors.push(
        `Repo '${repoName}': invalid auth.strategy '${authFile.strategy}'. Must be one of: auto, pat, none.`,
      );
    }
  }

  // PAT / PAT-EnvVarName mutual exclusion
  const inlinePat = authFile.PAT?.trim() || undefined;
  const envVarName = authFile["PAT-EnvVarName"]?.trim() || undefined;

  if (inlinePat && envVarName) {
    errors.push(
      `Repo '${repoName}': auth.PAT and auth.PAT-EnvVarName are mutually exclusive — set only one.`,
    );
  }

  let resolvedPat: string | undefined;
  if (inlinePat) {
    resolvedPat = inlinePat;
  } else if (envVarName) {
    resolvedPat = env[envVarName]?.trim() || undefined;
    if (!resolvedPat && strategy === "pat") {
      errors.push(
        `Repo '${repoName}': auth.strategy is 'pat' but env var '${envVarName}' (auth.PAT-EnvVarName) is not set or empty.`,
      );
    }
  }

  if (strategy === "pat" && !inlinePat && !envVarName) {
    errors.push(
      `Repo '${repoName}': auth.strategy is 'pat' but no PAT or PAT-EnvVarName is configured.`,
    );
  }
  if (strategy === "none" && resolvedPat) {
    warnings.push(
      `Repo '${repoName}': auth.strategy is 'none' but a PAT is configured — it will be ignored.`,
    );
    resolvedPat = undefined;
  }

  const auth: GitAuth = resolvedPat ? { strategy, pat: resolvedPat } : { strategy };
  return { auth, errors, warnings };
}

// ── Phase 1: loadConfig (synchronous, at startup) ──

/**
 * Read `.digger/config.json` (or path from `DIGGER_CONFIG` env var), merge
 * per-machine env vars, and return a validated {@link DiggerConfig}.
 *
 * If a `.env` file exists in `cwd`, its values are loaded as defaults —
 * actual environment variables always take precedence. `.env` is the intended
 * source for per-machine secrets referenced by `auth.PAT-EnvVarName`.
 *
 * For repos with explicit `packages` arrays, {@link PackageConfig} entries are
 * built immediately. For repos without (auto-discover), `packages` starts empty
 * and is populated later by {@link discoverPackages} after the repo is on disk.
 *
 * Throws {@link ConfigError} aggregating every validation problem found.
 * Returns `null` when the config file is absent (ENOENT).
 */
export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DiggerConfig | null {
  const env = mergeEnvFile(rawEnv, cwd);

  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Config file ──
  const configRelPath = env.DIGGER_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  const configPath = path.resolve(cwd, configRelPath);

  let configFile: ConfigFile & { authStrategy?: unknown };
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ConfigFile & { authStrategy?: unknown };
    configFile = { ...parsed };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw new ConfigError([
      `Failed to parse config file ${configPath}: ${err.message}`,
    ]);
  }

  // Reject legacy top-level authStrategy so users get a clear migration error
  if (configFile.authStrategy !== undefined) {
    errors.push(
      "Top-level 'authStrategy' is no longer supported — move it into each repo as 'auth.strategy'.",
    );
  }

  if (
    !configFile.repos ||
    !Array.isArray(configFile.repos) ||
    configFile.repos.length === 0
  ) {
    errors.push("Config file must contain a non-empty 'repos' array.");
  }

  // ── Directory roots ──
  const managedSourceDir = path.resolve(
    cwd,
    env.MANAGED_SOURCE_DIR?.trim() || DEFAULT_MANAGED_SOURCE_DIR,
  );
  const cacheDir = path.resolve(
    cwd,
    env.CACHE_DIR?.trim() || DEFAULT_CACHE_DIR,
  );

  // ── localRepos (from config file) ──
  const localRepos = new Map<string, string>();
  if (configFile.localRepos !== undefined) {
    if (
      typeof configFile.localRepos !== "object" ||
      Array.isArray(configFile.localRepos) ||
      configFile.localRepos === null
    ) {
      errors.push("'localRepos' must be an object mapping repo name → path.");
    } else {
      for (const [name, rawPath] of Object.entries(configFile.localRepos)) {
        if (typeof rawPath !== "string" || !rawPath.trim()) {
          errors.push(
            `localRepos entry '${name}' must be a non-empty string path.`,
          );
          continue;
        }
        localRepos.set(name, rawPath.trim());
      }
    }
  }

  // ── Build RepoConfig[] ──
  const repos: RepoConfig[] = [];
  const repoNames = new Set<string>();
  const allPackageNames = new Set<string>();
  const noSource: string[] = [];

  const repoDefinitions = Array.isArray(configFile.repos)
    ? configFile.repos
    : [];

  for (const repoDef of repoDefinitions) {
    if (!repoDef.name?.trim()) {
      errors.push("A repo entry is missing a 'name' field.");
      continue;
    }
    const name = repoDef.name.trim();

    if (repoNames.has(name)) {
      errors.push(`Duplicate repo name: '${name}'.`);
      continue;
    }
    repoNames.add(name);

    const hasExplicitPackages =
      Array.isArray(repoDef.packages) && repoDef.packages.length > 0;

    if (name.includes("*")) {
      errors.push(
        `Repo '${name}': name must not contain '*'. Use the 'packageFilter' field for wildcard package matching.`,
      );
      continue;
    }
    if (name.endsWith(".")) {
      errors.push(`Repo '${name}': name must not end with '.'.`);
      continue;
    }
    if (!isValidPackageName(name)) {
      errors.push(
        `Repo '${name}': name contains invalid characters. ${SAFE_NAME_HINT}`,
      );
      continue;
    }

    const packageFilter = repoDef.packageFilter?.trim() || undefined;
    if (packageFilter) {
      if (!packageFilter.endsWith("*")) {
        errors.push(
          `Repo '${name}': packageFilter '${packageFilter}' must end with '*'.`,
        );
        continue;
      }
      const filterBase = filterPrefix(packageFilter);
      const filterClean = filterBase.replace(/\.+$/, "");
      if (!filterClean) {
        errors.push(
          `Repo '${name}': packageFilter '${packageFilter}' is too broad — use a prefix like 'MyCompany.*'.`,
        );
        continue;
      }
      if (!isValidPackageName(filterClean)) {
        errors.push(
          `Repo '${name}': packageFilter '${packageFilter}' contains invalid characters. ${SAFE_NAME_HINT}`,
        );
        continue;
      }
      if (hasExplicitPackages) {
        errors.push(
          `Repo '${name}': 'packageFilter' and 'packages' are mutually exclusive — packages are derived from the workspace's .sln / .slnx / props / targets when packageFilter is set.`,
        );
        continue;
      }
    }

    const branch = repoDef.branch?.trim() || undefined;
    if (branch) {
      const branchError = validateBranchName(branch);
      if (branchError) {
        errors.push(`Repo '${name}': ${branchError}`);
      }
    }

    const url = repoDef.url?.trim() || undefined;
    if (url) {
      const urlError = validateRepoUrl(url);
      if (urlError) {
        errors.push(`Repo '${name}': URL ${urlError}`);
      }
    }
    const localRaw = localRepos.get(name);
    const localPath = localRaw ? path.resolve(cwd, localRaw) : undefined;

    if (!url && !localPath) {
      noSource.push(name);
    }

    if (branch && localPath && !url) {
      warnings.push(
        `Repo '${name}': 'branch' is set but repo has no URL (local-only). The branch setting only affects managed clones.`,
      );
    }

    // Mark this repo name as consumed so we can detect orphan localRepos later
    localRepos.delete(name);

    const sourceRoot = repoDef.sourceRoot?.trim() || DEFAULT_SOURCE_ROOT;
    const discoveryMode: "explicit" | "auto" | "wildcard" = packageFilter
      ? "wildcard"
      : hasExplicitPackages
        ? "explicit"
        : "auto";

    // Build PackageConfig[] for explicit repos
    const packages: PackageConfig[] = [];
    if (hasExplicitPackages && repoDef.packages) {
      for (const pkgName of repoDef.packages) {
        const trimmed = pkgName.trim();
        if (!trimmed) continue;
        if (!isValidPackageName(trimmed)) {
          errors.push(
            `Repo '${name}': package name '${trimmed}' contains invalid characters. ${SAFE_NAME_HINT}`,
          );
          continue;
        }
        if (allPackageNames.has(trimmed)) {
          errors.push(`Duplicate package name across repos: '${trimmed}'.`);
          continue;
        }
        allPackageNames.add(trimmed);
        packages.push(buildPackageConfig(trimmed, name, sourceRoot, cacheDir));
      }
    }

    const { auth, errors: authErrors, warnings: authWarnings } = resolveRepoAuth(
      repoDef.auth,
      env,
      name,
    );
    errors.push(...authErrors);
    warnings.push(...authWarnings);

    repos.push({
      name,
      url,
      branch,
      localPath,
      managedSourcePath: path.join(managedSourceDir, name),
      sourceRoot,
      discoveryMode,
      packageFilter,
      packages,
      auth,
    });
  }

  if (noSource.length > 0) {
    errors.push(
      `Repos with no 'url' and no localRepos entry: ${noSource.join(", ")}. ` +
        "Every repo must have at least one source configured.",
    );
  }

  // Orphan localRepos warnings
  for (const name of localRepos.keys()) {
    warnings.push(
      `localRepos contains '${name}' which does not match any repo in config — ignored.`,
    );
  }

  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  return {
    workspaceRoot: cwd,
    configPath,
    managedSourceDir,
    cacheDir,
    debug: configFile.debug === true,
    repos,
    warnings,
  };
}

// ── Phase 2: discoverPackages (async, after repo is on disk) ──

/**
 * Scan a repo on disk to find packages by looking for directories under
 * `{repoPath}/{sourceRoot}/` that contain a matching `.csproj` file.
 *
 * Excludes test projects (`.Tests`, `.Specs`, `.Benchmarks`, `.IntegrationTests`).
 *
 * Call this for repos with `discoveryMode === "auto"` after the repo is cloned
 * or located locally.
 */
export async function discoverPackages(
  repoPath: string,
  repoConfig: RepoConfig,
  cacheDir: string,
): Promise<PackageConfig[]> {
  const searchDir = path.join(repoPath, repoConfig.sourceRoot);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const allCandidates = entries.filter((e) => {
    if (!e.isDirectory() || e.isSymbolicLink()) return false;
    if (TEST_PROJECT_SUFFIXES.some((s) => e.name.endsWith(s))) return false;
    if (!isValidPackageName(e.name)) {
      debug("config", "discoverPackages: skipping directory with invalid name:", e.name);
      return false;
    }
    return true;
  });

  if (allCandidates.length > MAX_DISCOVERED_PACKAGES) {
    debug("config", `discoverPackages: ${allCandidates.length} candidates exceeds cap of ${MAX_DISCOVERED_PACKAGES}, truncating`);
  }
  const candidates = allCandidates.slice(0, MAX_DISCOVERED_PACKAGES);

  const results = await Promise.all(
    candidates.map(async (entry) => {
      const csprojPath = path.join(
        searchDir,
        entry.name,
        `${entry.name}.csproj`,
      );
      try {
        await fs.promises.access(csprojPath);
      } catch {
        return null;
      }
      return buildPackageConfig(
        entry.name,
        repoConfig.name,
        repoConfig.sourceRoot,
        cacheDir,
      );
    }),
  );

  return results.filter((r): r is PackageConfig => r !== null);
}

// ── Lookup helper ──

/** Find a package by name across all repos. */
export function findPackage(
  config: DiggerConfig,
  packageName: string,
): PackageConfig | undefined {
  for (const repo of config.repos) {
    const pkg = repo.packages.find((p) => p.name === packageName);
    if (pkg) return pkg;
  }
  return undefined;
}

/** Find the repo that owns a given package name. */
export function findRepo(
  config: DiggerConfig,
  packageName: string,
): RepoConfig | undefined {
  for (const repo of config.repos) {
    if (repo.packages.some((p) => p.name === packageName)) return repo;
  }
  return undefined;
}

/** Format an error message for an unknown package name. */
export function formatUnknownPackage(
  config: DiggerConfig,
  packageName: string,
): string {
  const available = config.repos
    .flatMap((r) => r.packages)
    .map((p) => p.name);

  const unresolvedWildcards = config.repos.filter(
    (r) => r.discoveryMode === "wildcard" && r.packages.length === 0,
  );

  const lines: string[] = [];
  if (available.length > 0) {
    lines.push(`Unknown package '${packageName}'. Available packages:`);
    for (const n of available) lines.push(`- ${n}`);
  } else {
    lines.push(`Unknown package '${packageName}'. No packages are configured.`);
  }

  if (unresolvedWildcards.length > 0) {
    const names = unresolvedWildcards.map((r) => `'${r.name}' (packageFilter: ${r.packageFilter})`).join(", ");
    lines.push("");
    lines.push(
      `Note: filtered repo(s) ${names} have not resolved any packages. ` +
        `Call dig_list to trigger a workspace scan and repo clone — ` +
        `this usually populates the package list. ` +
        `If the scan still produces no match, add an explicit 'packages' list in ${config.configPath}.`,
    );
  }

  return lines.join("\n");
}

/** Format an error message for an unknown package within a specific repo. */
export function formatUnknownPackageInRepo(
  repoName: string,
  packageName: string,
  packages: readonly PackageConfig[],
): string {
  const available = packages.map((p) => p.name);
  if (available.length > 0) {
    const listing = available.map((n) => `- ${n}`).join("\n");
    return `Unknown package '${packageName}' in repo '${repoName}'. Available packages:\n${listing}`;
  }
  return `Unknown package '${packageName}' in repo '${repoName}'. No packages resolved yet — call dig_list first.`;
}

/** Format an error message for an unknown repo name. */
export function formatUnknownRepo(
  config: DiggerConfig,
  repoName: string,
): string {
  const available = config.repos.map((r) => r.name);
  if (available.length > 0) {
    const listing = available.map((n) => `- ${n}`).join("\n");
    return `Unknown repo '${repoName}'. Available repos:\n${listing}`;
  }
  return `Unknown repo '${repoName}'. No repos are configured.`;
}
