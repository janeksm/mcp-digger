import * as fs from "node:fs";
import * as path from "node:path";

// ── Config file schema (what .digger/config.json contains) ──

export type AuthStrategy = "auto" | "pat" | "none";

export interface RepoDefinition {
  name: string;
  url?: string;
  sourceRoot?: string; // default "src"
  packages?: string[]; // if omitted → auto-discover at runtime
}

export interface ConfigFile {
  authStrategy?: AuthStrategy; // default "auto"
  repos: RepoDefinition[];
}

// ── Resolved config (after merging file + env vars) ──

export interface RepoConfig {
  name: string;
  url?: string;
  /** Absolute path to developer's local clone (Mode B), from MCP_DIGGER_LOCAL_REPOS. */
  localPath?: string;
  /** Absolute target dir for managed clones: `<managedSourceDir>/<repoName>`. */
  managedSourcePath: string;
  /** Relative path within repo where package dirs live (default "src"). */
  sourceRoot: string;
  /** "explicit" = packages listed in config file. "auto" = scan repo on disk. */
  discoveryMode: "explicit" | "auto";
  /** Populated immediately for explicit, lazily (by discoverPackages) for auto. */
  packages: PackageConfig[];
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
  /** Personal Access Token from MCP_DIGGER_PAT. Undefined when not set or strategy is "none". */
  pat?: string;
}

export interface DiggerConfig {
  workspaceRoot: string;
  /** Absolute path to the config file that was read. */
  configPath: string;
  managedSourceDir: string;
  cacheDir: string;
  auth: GitAuth;
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

const DEFAULT_CONFIG_PATH = ".digger/config.json";
const DEFAULT_MANAGED_SOURCE_DIR = ".digger/source";
const DEFAULT_CACHE_DIR = ".digger/cache";
const DEFAULT_SOURCE_ROOT = "src";
const DEFAULT_AUTH_STRATEGY: AuthStrategy = "auto";
const VALID_AUTH_STRATEGIES: ReadonlySet<AuthStrategy> = new Set<AuthStrategy>(["auto", "pat", "none"]);

const TEST_PROJECT_SUFFIXES = [
  ".Tests",
  ".Specs",
  ".Benchmarks",
  ".IntegrationTests",
];

// ── Helpers ──

/**
 * Parse an env var of the form `name1:value1,name2:value2` where the value may
 * itself contain colons. Splits each comma-separated entry on its FIRST colon.
 * Entries with no colon have an empty-string value (treated as malformed by caller).
 */
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

function parseKeyValueList(raw: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      result.set(trimmed, "");
      continue;
    }
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

// ── Phase 1: loadConfig (synchronous, at startup) ──

/**
 * Read `.digger/config.json` (or path from `DIGGER_CONFIG` env var), merge
 * per-machine env vars, and return a validated {@link DiggerConfig}.
 *
 * For repos with explicit `packages` arrays, {@link PackageConfig} entries are
 * built immediately. For repos without (auto-discover), `packages` starts empty
 * and is populated later by {@link discoverPackages} after the repo is on disk.
 *
 * Throws {@link ConfigError} aggregating every validation problem found.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DiggerConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Config file ──
  const configRelPath = env.DIGGER_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  const configPath = path.resolve(cwd, configRelPath);

  let configFile: ConfigFile;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    configFile = JSON.parse(raw) as ConfigFile;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new ConfigError([`Config file not found: ${configPath}`]);
    }
    throw new ConfigError([
      `Failed to parse config file ${configPath}: ${err.message}`,
    ]);
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

  // ── MCP_DIGGER_LOCAL_REPOS (by repo name) ──
  const localRepos = parseKeyValueList(env.MCP_DIGGER_LOCAL_REPOS);
  for (const [name, repoPath] of localRepos) {
    if (!repoPath) {
      errors.push(
        `MCP_DIGGER_LOCAL_REPOS entry '${name}' is malformed (expected 'repoName:path').`,
      );
    }
  }

  // ── Auth strategy + PAT ──
  const rawStrategy = configFile.authStrategy?.trim().toLowerCase();
  const isValidStrategy = (v: string): v is AuthStrategy =>
    VALID_AUTH_STRATEGIES.has(v as AuthStrategy);
  if (rawStrategy && !isValidStrategy(rawStrategy)) {
    errors.push(
      `Invalid authStrategy '${rawStrategy}' in config file. Must be one of: auto, pat, none.`,
    );
  }
  const strategy: AuthStrategy =
    rawStrategy && isValidStrategy(rawStrategy)
      ? rawStrategy
      : DEFAULT_AUTH_STRATEGY;

  const rawPat = env.MCP_DIGGER_PAT?.trim() || undefined;

  if (strategy === "pat" && !rawPat) {
    errors.push(
      "authStrategy is 'pat' but MCP_DIGGER_PAT is not set. Provide a Personal Access Token or change authStrategy to 'auto'.",
    );
  }
  if (strategy === "none" && rawPat) {
    warnings.push(
      "authStrategy is 'none' but MCP_DIGGER_PAT is set — the PAT will be ignored.",
    );
  }

  const auth: GitAuth = {
    strategy,
    pat: strategy === "none" ? undefined : rawPat,
  };

  // ── Build RepoConfig[] ──
  const repos: RepoConfig[] = [];
  const repoNames = new Set<string>();
  const allPackageNames = new Set<string>();
  const noSource: string[] = [];

  for (const repoDef of configFile.repos ?? []) {
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

    const url = repoDef.url?.trim() || undefined;
    const localRaw = localRepos.get(name);
    const localPath = localRaw ? path.resolve(cwd, localRaw) : undefined;

    if (!url && !localPath) {
      noSource.push(name);
    }

    // Mark this repo name as consumed so we can detect orphan LOCAL_REPOS later
    localRepos.delete(name);

    const sourceRoot = repoDef.sourceRoot?.trim() || DEFAULT_SOURCE_ROOT;
    const discoveryMode: "explicit" | "auto" = repoDef.packages
      ? "explicit"
      : "auto";

    // Build PackageConfig[] for explicit repos
    const packages: PackageConfig[] = [];
    if (repoDef.packages) {
      for (const pkgName of repoDef.packages) {
        const trimmed = pkgName.trim();
        if (!trimmed) continue;
        if (allPackageNames.has(trimmed)) {
          errors.push(`Duplicate package name across repos: '${trimmed}'.`);
          continue;
        }
        allPackageNames.add(trimmed);
        packages.push(buildPackageConfig(trimmed, name, sourceRoot, cacheDir));
      }
    }

    repos.push({
      name,
      url,
      localPath,
      managedSourcePath: path.join(managedSourceDir, name),
      sourceRoot,
      discoveryMode,
      packages,
    });
  }

  if (noSource.length > 0) {
    errors.push(
      `Repos with no 'url' and no MCP_DIGGER_LOCAL_REPOS entry: ${noSource.join(", ")}. ` +
        "Every repo must have at least one source configured.",
    );
  }

  // Orphan LOCAL_REPOS warnings
  for (const name of localRepos.keys()) {
    warnings.push(
      `MCP_DIGGER_LOCAL_REPOS contains '${name}' which does not match any repo in config — ignored.`,
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
    auth,
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

  const candidates = entries.filter(
    (e) =>
      e.isDirectory() &&
      !TEST_PROJECT_SUFFIXES.some((s) => e.name.endsWith(s)),
  );

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
  return available.length > 0
    ? `Unknown package '${packageName}'. Available packages:\n${available.map((n) => `- ${n}`).join("\n")}`
    : `Unknown package '${packageName}'. No packages are configured.`;
}
