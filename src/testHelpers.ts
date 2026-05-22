import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import type { DiggerConfig, GitAuth, PackageConfig, RepoConfig } from "./config.js";

const execFile = util.promisify(child_process.execFile);

/**
 * Recursively remove a temp dir, tolerating Windows file-handle races where a
 * git child process still holds a handle when cleanup runs. `maxRetries` +
 * `retryDelay` retry the rmdir on EBUSY/ENOTEMPTY for ~500ms total.
 */
export function cleanupTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Init a git repo with one commit containing the given files.
 *
 * `.NET C# repo validation` (added 2026-05-22) requires every resolved repo
 * to contain at least one tracked `.csproj` or it is flagged as
 * "not a .NET C# repository" in `ensureReady()` / `dig_status`. To keep
 * existing fixtures working without per-test backfill, `initRepo` injects
 * a default `.csproj` per distinct two-segment package directory observed
 * in `files` (any path matching `<root>/<pkgDir>/<rest>`, e.g.
 * `src/MyLib/Foo.cs` → adds `src/MyLib/MyLib.csproj`). For flat layouts
 * (`src/b.cs`) no injection happens — those tests don't exercise
 * validation. Tests that intentionally need a non-.NET repo (including the
 * validation tests themselves) should use `initBareRepo` instead, which
 * never injects anything.
 */
export async function initRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  return initRepoCore(tmpDir, withDefaultCsprojes(files));
}

/**
 * Init a git repo WITHOUT injecting a default `.csproj`. Use when the test
 * intentionally needs a non-.NET repo (e.g. validating that mcp-digger
 * surfaces the "not a .NET C# repository" error).
 */
export async function initBareRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  return initRepoCore(tmpDir, files);
}

async function initRepoCore(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  const repoDir = path.join(tmpDir, "repo-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(repoDir, { recursive: true });

  await execFile("git", ["init", repoDir]);
  await execFile("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execFile("git", ["-C", repoDir, "config", "user.name", "Test"]);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  await execFile("git", ["-C", repoDir, "add", "."]);
  await execFile("git", ["-C", repoDir, "commit", "-m", "initial"]);

  return repoDir;
}

function withDefaultCsprojes(
  files: Record<string, string>,
): Record<string, string> {
  // If any file is a .csproj anywhere in the tree, the repo is already valid.
  const hasAnyCsproj = Object.keys(files).some((f) => /\.csproj$/i.test(f));
  if (hasAnyCsproj) return files;

  // Auto-inject only when a recognisable package layout is present
  // (`<root>/<pkgDir>/...`, e.g. `src/MyLib/Foo.cs`). For flat layouts
  // (`a.txt`, `src/b.cs`) the test is not exercising validation, so leave
  // the repo untouched and let `initBareRepo` be the explicit signal when
  // a test intentionally wants a non-.NET repo.
  const dirs = new Set<string>();
  for (const f of Object.keys(files)) {
    const m = /^([^/]+)\/([^/]+)\/[^/]+/.exec(f);
    if (m) {
      dirs.add(`${m[1]}/${m[2]}`);
    }
  }
  if (dirs.size === 0) return files;

  const augmented = { ...files };
  for (const dir of dirs) {
    const baseName = dir.split("/").pop()!;
    augmented[`${dir}/${baseName}.csproj`] = "<Project />";
  }
  return augmented;
}

/** Get the HEAD commit hash of a repo. */
export async function getHeadHash(repoDir: string): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/** Build a PackageConfig for tests. */
export function makePkg(
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

/** Build a RepoConfig pointing to a local repo for tests. */
export function makeLocalRepo(
  name: string,
  localPath: string,
  packages: PackageConfig[],
  tmpDir: string,
  sourceRoot = "src",
  auth: GitAuth = { strategy: "none" },
): RepoConfig {
  return {
    name,
    localPath,
    managedSourcePath: path.join(tmpDir, "source", name),
    sourceRoot,
    discoveryMode: "explicit",
    packages,
    auth,
  };
}

/**
 * Generic RepoConfig factory for tests. Fills in sensible defaults
 * (`sourceRoot: "src"`, `discoveryMode: "explicit"`, empty `packages`,
 * `auth: none`, `managedSourcePath: <tmpDir>/source/<name>`).
 * Use this when you need a URL-only or invalid-localPath repo; for the
 * common happy-path local repo, `makeLocalRepo` is more direct.
 */
export function makeRepoConfig(
  overrides: Partial<RepoConfig> & { name: string },
  tmpDir: string,
): RepoConfig {
  return {
    managedSourcePath: path.join(tmpDir, "source", overrides.name),
    sourceRoot: "src",
    discoveryMode: "explicit",
    packages: [],
    auth: { strategy: "none" },
    ...overrides,
  };
}

/** Build a DiggerConfig for tests. */
export function makeConfig(
  repos: RepoConfig[],
  tmpDir: string,
  cacheDir?: string,
): DiggerConfig {
  return {
    workspaceRoot: tmpDir,
    configPath: path.join(tmpDir, ".digger/config.json"),
    managedSourceDir: path.join(tmpDir, "source"),
    cacheDir: cacheDir ?? path.join(tmpDir, "cache"),
    debug: false,
    repos,
    warnings: [],
  };
}

/**
 * Create a bare git repo (cloneable remote) with one commit. Like
 * `initRepo`, this injects a default `.csproj` so the repo passes .NET C#
 * validation. Use `createBareNonNetRepo` for the explicit non-.NET case.
 */
export async function createBareRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  return createBareRepoCore(tmpDir, await initRepo(tmpDir, files));
}

/** Like `createBareRepo` but does NOT inject a default `.csproj`. */
export async function createBareNonNetRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  return createBareRepoCore(tmpDir, await initBareRepo(tmpDir, files));
}

async function createBareRepoCore(tmpDir: string, workDir: string): Promise<string> {
  const bareDir = path.join(tmpDir, "bare-" + Math.random().toString(36).slice(2) + ".git");
  await execFile("git", ["clone", "--bare", workDir, bareDir]);
  return bareDir;
}

/** Create a bare repo with both default branch and a named branch with different content. */
export async function createBareRepoWithBranch(
  tmpDir: string,
  defaultFiles: Record<string, string>,
  branchName: string,
  branchFiles: Record<string, string>,
): Promise<string> {
  const workDir = await initRepo(tmpDir, defaultFiles);
  await execFile("git", ["-C", workDir, "checkout", "-b", branchName]);
  for (const [filePath, content] of Object.entries(branchFiles)) {
    const fullPath = path.join(workDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  await execFile("git", ["-C", workDir, "add", "."]);
  await execFile("git", ["-C", workDir, "commit", "-m", `commit on ${branchName}`]);
  await execFile("git", ["-C", workDir, "checkout", "-"]);
  const bareDir = path.join(tmpDir, "bare-" + Math.random().toString(36).slice(2) + ".git");
  await execFile("git", ["clone", "--bare", workDir, bareDir]);
  return bareDir;
}

// ── Solution-scanner test fixtures ──

/**
 * Write a minimal valid classic `.sln` referencing the given .csproj paths.
 * Paths are written with Windows-style backslashes to mirror how `.sln` files
 * are typically authored on Windows.
 */
export function writeSlnFile(
  dir: string,
  name: string,
  csprojRelPaths: string[],
): string {
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    "Microsoft Visual Studio Solution File, Format Version 12.00",
  ];
  for (const rel of csprojRelPaths) {
    const winPath = rel.replace(/\//g, "\\");
    const projName = path.basename(rel, ".csproj");
    const guid = "{" + Math.random().toString(36).slice(2, 10).toUpperCase() + "-0000-0000-0000-000000000000}";
    lines.push(
      `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${projName}", "${winPath}", "${guid}"`,
    );
    lines.push("EndProject");
  }
  const slnPath = path.join(dir, name);
  fs.writeFileSync(slnPath, lines.join("\r\n") + "\r\n");
  return slnPath;
}

/** Write a minimal `.slnx` (XML solution) referencing the given .csproj paths. */
export function writeSlnxFile(
  dir: string,
  name: string,
  csprojRelPaths: string[],
): string {
  fs.mkdirSync(dir, { recursive: true });
  const body = csprojRelPaths
    .map((rel) => `  <Project Path="${rel.replace(/\//g, "\\")}" />`)
    .join("\n");
  const slnxPath = path.join(dir, name);
  fs.writeFileSync(slnxPath, `<Solution>\n${body}\n</Solution>\n`);
  return slnxPath;
}

/** Write a minimal `.csproj` with `<PackageReference>` entries. */
export function writeCsprojFile(
  absPath: string,
  packageRefs: string[],
): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const refs = packageRefs
    .map((name) => `    <PackageReference Include="${name}" Version="1.0.0" />`)
    .join("\n");
  fs.writeFileSync(
    absPath,
    `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${refs}\n  </ItemGroup>\n</Project>\n`,
  );
}

/** Write a minimal `Directory.Packages.props` with `<PackageVersion>` (CPM) entries. */
export function writeDirectoryPackagesProps(
  dir: string,
  packageVersions: string[],
  packageRefs: string[] = [],
): string {
  fs.mkdirSync(dir, { recursive: true });
  const versions = packageVersions
    .map((name) => `    <PackageVersion Include="${name}" Version="1.0.0" />`)
    .join("\n");
  const refs = packageRefs
    .map((name) => `    <PackageReference Include="${name}" />`)
    .join("\n");
  const parts = [versions, refs].filter((s) => s.length > 0).join("\n");
  const target = path.join(dir, "Directory.Packages.props");
  fs.writeFileSync(
    target,
    `<Project>\n  <ItemGroup>\n${parts}\n  </ItemGroup>\n</Project>\n`,
  );
  return target;
}

/** Write a minimal `Directory.Build.props` with `<PackageReference>` entries. */
export function writeDirectoryBuildProps(
  dir: string,
  packageRefs: string[],
): string {
  fs.mkdirSync(dir, { recursive: true });
  const refs = packageRefs
    .map((name) => `    <PackageReference Include="${name}" Version="1.0.0" />`)
    .join("\n");
  const target = path.join(dir, "Directory.Build.props");
  fs.writeFileSync(
    target,
    `<Project>\n  <ItemGroup>\n${refs}\n  </ItemGroup>\n</Project>\n`,
  );
  return target;
}

/** Write a minimal `Directory.Build.targets` with `<PackageReference>` entries. */
export function writeDirectoryBuildTargets(
  dir: string,
  packageRefs: string[],
): string {
  fs.mkdirSync(dir, { recursive: true });
  const refs = packageRefs
    .map((name) => `    <PackageReference Include="${name}" Version="1.0.0" />`)
    .join("\n");
  const target = path.join(dir, "Directory.Build.targets");
  fs.writeFileSync(
    target,
    `<Project>\n  <ItemGroup>\n${refs}\n  </ItemGroup>\n</Project>\n`,
  );
  return target;
}

/**
 * Build a filtered (wildcard) RepoConfig for tests. The returned config has
 * `discoveryMode: "wildcard"` and an empty `packages` list (populated by `ensureReady`).
 */
export function makeWildcardRepo(
  name: string,
  tmpDir: string,
  overrides: Partial<RepoConfig> & { packageFilter: string },
): RepoConfig {
  if (!overrides.packageFilter.endsWith("*")) {
    throw new Error("makeWildcardRepo: packageFilter must end with '*'");
  }
  const { packageFilter, ...rest } = overrides;
  return {
    name,
    packageFilter,
    managedSourcePath: path.join(tmpDir, "source", name),
    sourceRoot: "src",
    discoveryMode: "wildcard",
    packages: [],
    auth: { strategy: "none" },
    ...rest,
  };
}
