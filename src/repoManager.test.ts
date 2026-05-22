import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "./config.js";
import { ensureAllReady, ensureReady, extractProjectReferenceNames } from "./repoManager.js";
import { scanCachePath } from "./solutionScanner.js";
import {
  cleanupTmpDir,
  createBareNonNetRepo as createBareNonNetRepoHelper,
  createBareRepo as createBareRepoHelper,
  createBareRepoWithBranch as createBareRepoWithBranchHelper,
  initBareRepo as initBareRepoHelper,
  initRepo as initRepoHelper,
  makeConfig as makeConfigHelper,
  makeRepoConfig as makeRepoConfigHelper,
  makeWildcardRepo as makeWildcardRepoHelper,
  writeCsprojFile,
  writeDirectoryPackagesProps,
  writeSlnFile,
  writeSlnxFile,
} from "./testHelpers.js";

const execFile = util.promisify(child_process.execFile);

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-repo-test-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

const initRepo = (files: Record<string, string>) => initRepoHelper(tmpDir, files);
const initBareRepo = (files: Record<string, string>) => initBareRepoHelper(tmpDir, files);
const createBareRepo = (files: Record<string, string>) => createBareRepoHelper(tmpDir, files);
const createBareNonNetRepo = (files: Record<string, string>) => createBareNonNetRepoHelper(tmpDir, files);
const createBareRepoWithBranch = (
  defaultFiles: Record<string, string>,
  branchName: string,
  branchFiles: Record<string, string>,
) => createBareRepoWithBranchHelper(tmpDir, defaultFiles, branchName, branchFiles);
const makeConfig = (repos: RepoConfig[]) => makeConfigHelper(repos, tmpDir);
const makeRepoConfig = (overrides: Partial<RepoConfig> & { name: string }) =>
  makeRepoConfigHelper(overrides, tmpDir);
const makeWildcardRepo = (name: string, overrides: Partial<RepoConfig> & { packageFilter: string }) =>
  makeWildcardRepoHelper(name, tmpDir, overrides);

// ── Mode B (local path) ──

describe("ensureReady — Mode B (local)", () => {
  it("uses local path when it is a valid git repo", async () => {
    const localRepo = await initRepo({ "src/Lib/Lib.csproj": "<Project />" });
    const repo = makeRepoConfig({ name: "mylib", localPath: localRepo });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("local");
    expect(result.sourcePath).toBe(localRepo);
    expect(result.currentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to managed clone when local path is invalid and URL exists", async () => {
    const bareDir = await createBareRepo({
      "readme.md": "hello",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const badLocal = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(badLocal, { recursive: true });

    const repo = makeRepoConfig({
      name: "mylib",
      localPath: badLocal,
      url: bareDir,
    });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(result.warning).toContain("not a valid git repo");
    expect(result.warning).toContain("Falling back");
    expect(result.currentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("throws when local path is invalid and no URL for fallback", async () => {
    const badLocal = path.join(tmpDir, "nowhere");
    const repo = makeRepoConfig({ name: "mylib", localPath: badLocal });
    const config = makeConfig([repo]);

    await expect(ensureReady(repo, config)).rejects.toThrow(
      /not a valid git repo and no URL/,
    );
  });
});

// ── Mode A (managed clone) ──

describe("ensureReady — Mode A (managed)", () => {
  it("clones repo when not yet on disk", async () => {
    const bareDir = await createBareRepo({ "src/Pkg/Pkg.csproj": "<Project />" });
    const repo = makeRepoConfig({ name: "mylib", url: bareDir });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(result.currentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(result.sourcePath, "src", "Pkg", "Pkg.csproj"))).toBe(true);
  });

  it("fetches when clone already exists", async () => {
    const bareDir = await createBareRepo({
      "file.txt": "v1",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const repo = makeRepoConfig({ name: "mylib", url: bareDir });
    const config = makeConfig([repo]);

    // First call: clone
    const first = await ensureReady(repo, config);

    // Push a new commit to bare
    const pushDir = path.join(tmpDir, "pusher");
    await execFile("git", ["clone", bareDir, pushDir]);
    await execFile("git", ["-C", pushDir, "config", "user.email", "test@test.com"]);
    await execFile("git", ["-C", pushDir, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(pushDir, "file.txt"), "v2");
    await execFile("git", ["-C", pushDir, "add", "."]);
    await execFile("git", ["-C", pushDir, "commit", "-m", "update"]);
    await execFile("git", ["-C", pushDir, "push"]);

    // Second call: fetch
    const second = await ensureReady(repo, config);

    expect(second.mode).toBe("managed");
    expect(second.currentHash).not.toBe(first.currentHash);
  });

  it("throws when no URL configured", async () => {
    const repo = makeRepoConfig({ name: "mylib" });
    const config = makeConfig([repo]);

    await expect(ensureReady(repo, config)).rejects.toThrow(/no URL configured/);
  });

  it("cleans up partial clone remnant and reclones", async () => {
    const bareDir = await createBareRepo({
      "hello.txt": "world",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const repo = makeRepoConfig({ name: "mylib", url: bareDir });
    const config = makeConfig([repo]);

    // Create a non-repo directory at the managed path
    fs.mkdirSync(repo.managedSourcePath, { recursive: true });
    fs.writeFileSync(path.join(repo.managedSourcePath, "junk.txt"), "leftover");

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(fs.existsSync(path.join(result.sourcePath, "hello.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.sourcePath, "junk.txt"))).toBe(false);
  });
});

// ── Auto-discovery ──

describe("ensureReady — auto-discover packages", () => {
  it("discovers packages for auto repos after clone", async () => {
    const bareDir = await createBareRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Logging/MyCompany.Logging.csproj": "<Project />",
      "src/MyCompany.Tests/MyCompany.Tests.csproj": "<Project />",
    });
    const repo = makeRepoConfig({
      name: "shared",
      url: bareDir,
      discoveryMode: "auto",
    });
    const config = makeConfig([repo]);

    await ensureReady(repo, config);

    const pkgNames = repo.packages.map((p) => p.name).sort();
    expect(pkgNames).toEqual(["MyCompany.Core", "MyCompany.Logging"]);
    expect(pkgNames).not.toContain("MyCompany.Tests");
  });

  it("skips discovery for explicit repos", async () => {
    const bareDir = await createBareRepo({
      "src/Pkg/Pkg.csproj": "<Project />",
    });
    const repo = makeRepoConfig({
      name: "shared",
      url: bareDir,
      discoveryMode: "explicit",
      packages: [
        {
          name: "ManualPkg",
          repoName: "shared",
          pathInRepo: "src/ManualPkg",
          cachePath: path.join(tmpDir, "cache", "ManualPkg"),
        },
      ],
    });
    const config = makeConfig([repo]);

    await ensureReady(repo, config);

    expect(repo.packages).toHaveLength(1);
    expect(repo.packages[0]!.name).toBe("ManualPkg");
  });

  it("discovers packages from local repo", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Api/MyCompany.Api.csproj": "<Project />",
    });
    const repo = makeRepoConfig({
      name: "api",
      localPath: localRepo,
      discoveryMode: "auto",
    });
    const config = makeConfig([repo]);

    await ensureReady(repo, config);

    expect(repo.packages).toHaveLength(1);
    expect(repo.packages[0]!.name).toBe("MyCompany.Api");
  });
});

// ── ensureAllReady ──

describe("ensureAllReady", () => {
  it("processes all repos and returns results map", async () => {
    const bare1 = await createBareRepo({ "src/A/A.csproj": "<Project />" });
    const bare2 = await createBareRepo({ "src/B/B.csproj": "<Project />" });
    const repo1 = makeRepoConfig({ name: "repo1", url: bare1 });
    const repo2 = makeRepoConfig({ name: "repo2", url: bare2 });
    const config = makeConfig([repo1, repo2]);

    const results = await ensureAllReady(config);

    expect(results.size).toBe(2);
    expect(results.get("repo1")!.mode).toBe("managed");
    expect(results.get("repo2")!.mode).toBe("managed");
    expect(results.get("repo1")!.currentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("mixes local and managed repos", async () => {
    const localRepo = await initRepo({
      "file.txt": "local",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const bareDir = await createBareRepo({
      "file.txt": "managed",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const repo1 = makeRepoConfig({ name: "local-lib", localPath: localRepo });
    const repo2 = makeRepoConfig({ name: "remote-lib", url: bareDir });
    const config = makeConfig([repo1, repo2]);

    const results = await ensureAllReady(config);

    expect(results.get("local-lib")!.mode).toBe("local");
    expect(results.get("remote-lib")!.mode).toBe("managed");
  });

  it("captures per-repo errors on the result instead of throwing", async () => {
    const goodLocal = await initRepo({
      "file.txt": "good",
      "src/Lib/Lib.csproj": "<Project />",
    });
    const good = makeRepoConfig({ name: "good", localPath: goodLocal });
    const bad = makeRepoConfig({
      name: "bad",
      localPath: path.join(tmpDir, "nowhere"),
    });
    const config = makeConfig([good, bad]);

    const results = await ensureAllReady(config);

    expect(results.get("good")!.error).toBeUndefined();
    expect(results.get("bad")!.error).toMatch(/not a valid git repo/);
  });
});

// ── Wildcard mode ──

describe("ensureReady — wildcard mode", () => {
  it("intersects on-disk candidates, prefix, and workspace-referenced packages", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Auth/MyCompany.Auth.csproj": "<Project />",
      "src/MyCompany.Internal/MyCompany.Internal.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), [
      "MyCompany.Core",
      "MyCompany.Auth",
      "Newtonsoft.Json",
    ]);
    writeSlnFile(tmpDir, "Sample.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    const results = await ensureAllReady(config);
    const result = results.get("MyCompany.Libs")!;

    expect(result.error).toBeUndefined();
    const names = repo.packages.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.Auth", "MyCompany.Core"]);
  });

  it("resolves references from .slnx solution files", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnxFile(tmpDir, "Modern.slnx", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    expect(repo.packages.map((p) => p.name)).toEqual(["MyCompany.Core"]);
  });

  it("resolves references from Directory.Packages.props when no solution exists", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    writeDirectoryPackagesProps(tmpDir, ["MyCompany.Core"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    expect(repo.packages.map((p) => p.name)).toEqual(["MyCompany.Core"]);
  });

  it("sets error when wildcard matches zero packages", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    // Solution references something outside the repo's prefix
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    const results = await ensureAllReady(config);
    const result = results.get("MyCompany.Libs")!;

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/matched zero packages/);
    expect(result.error).toMatch(/explicit 'packages' list/);
    expect(repo.packages).toEqual([]);
  });

  it("leaves non-wildcard sibling repos unaffected when a wildcard has zero matches", async () => {
    const wildcardRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    const explicitRepo = await initRepo({
      "src/Other/Other.csproj": "<Project />",
    });

    // No solutions → wildcard matches nothing
    const wildcard = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: wildcardRepo });
    const explicit = makeRepoConfig({
      name: "explicit",
      localPath: explicitRepo,
      packages: [
        {
          name: "Other",
          repoName: "explicit",
          pathInRepo: "src/Other",
          cachePath: path.join(tmpDir, "cache", "Other"),
        },
      ],
    });
    const config = makeConfig([wildcard, explicit]);

    const results = await ensureAllReady(config);

    expect(results.get("MyCompany.Libs")!.error).toBeDefined();
    expect(results.get("explicit")!.error).toBeUndefined();
    expect(explicit.packages).toHaveLength(1);
  });

  it("writes solution-scan.json to cacheDir whenever a wildcard repo runs", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    const cachePath = scanCachePath(config.cacheDir);
    expect(fs.existsSync(cachePath)).toBe(true);
  });
});

// ── Wildcard transitive ProjectReference expansion ──

describe("ensureReady — wildcard transitive ProjectReference", () => {
  it("includes single-hop transitive dependency via ProjectReference", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Data/MyCompany.Data.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.Core\\MyCompany.Core.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyCompany.Api/MyCompany.Api.csproj": "<Project />",
    });
    // Workspace only directly references Data and Api — Core is transitive
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), [
      "MyCompany.Data",
      "MyCompany.Api",
    ]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    const names = repo.packages.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.Api", "MyCompany.Core", "MyCompany.Data"]);
  });

  it("follows multi-hop chain A → B → C", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.A/MyCompany.A.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.B\\MyCompany.B.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyCompany.B/MyCompany.B.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.C\\MyCompany.C.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyCompany.C/MyCompany.C.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.A"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    const names = repo.packages.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.A", "MyCompany.B", "MyCompany.C"]);
  });

  it("handles cycles without infinite loop", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.A/MyCompany.A.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.B\\MyCompany.B.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyCompany.B/MyCompany.B.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.A\\MyCompany.A.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.A"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    const names = repo.packages.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.A", "MyCompany.B"]);
  });

  it("excludes transitive deps outside the prefix filter", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\ThirdParty.Lib\\ThirdParty.Lib.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      "src/ThirdParty.Lib/ThirdParty.Lib.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    expect(repo.packages.map((p) => p.name)).toEqual(["MyCompany.Core"]);
  });

  it("excludes transitive deps not found as on-disk candidates", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <ProjectReference Include="..\\MyCompany.Missing\\MyCompany.Missing.csproj" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
      // MyCompany.Missing directory does not exist
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    expect(repo.packages.map((p) => p.name)).toEqual(["MyCompany.Core"]);
  });

  it("leaves packages unchanged when no ProjectReferences exist", async () => {
    const localRepo = await initRepo({
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Auth/MyCompany.Auth.csproj": "<Project />",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), [
      "MyCompany.Core",
      "MyCompany.Auth",
    ]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    await ensureAllReady(config);

    const names = repo.packages.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.Auth", "MyCompany.Core"]);
  });
});

// ── .NET C# repo validation ──

describe("ensureReady — .NET C# repo validation", () => {
  it("sets error when local repo has no .csproj", async () => {
    const localRepo = await initBareRepo({ "README.md": "# project" });
    const repo = makeRepoConfig({ name: "mylib", localPath: localRepo });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("local");
    expect(result.currentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("only supports .NET C# repositories");
    expect(result.error).toContain("no .csproj");
    expect(result.error).toContain(localRepo);
    expect(result.error).toContain("localPath");
  });

  it("sets error when managed clone has no .csproj", async () => {
    const bareDir = await createBareNonNetRepo({ "readme.md": "hello" });
    const repo = makeRepoConfig({ name: "mylib", url: bareDir });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("only supports .NET C# repositories");
    expect(result.error).toContain("URL");
    expect(result.error).toContain(result.sourcePath);
  });

  it("short-circuits auto discovery when repo has no .csproj", async () => {
    const localRepo = await initBareRepo({ "README.md": "# project" });
    const repo = makeRepoConfig({
      name: "mylib",
      localPath: localRepo,
      discoveryMode: "auto",
    });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.error).toContain("only supports .NET C# repositories");
    expect(repo.packages).toEqual([]);
  });

  it("validation error takes precedence over wildcard zero-match error", async () => {
    const localRepo = await initBareRepo({ "README.md": "# project" });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Some.Other.Pkg"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", { packageFilter: "MyCompany.*", localPath: localRepo });
    const config = makeConfig([repo]);

    const results = await ensureAllReady(config);
    const result = results.get("MyCompany.Libs")!;

    expect(result.error).toBeDefined();
    expect(result.error).toContain("only supports .NET C# repositories");
    expect(result.error).not.toContain("matched zero packages");
  });

  it("ensureAllReady isolates per-repo validation errors", async () => {
    const validLocal = await initRepo({ "src/Lib/Lib.csproj": "<Project />" });
    const invalidLocal = await initBareRepo({ "README.md": "# project" });
    const validPkg = {
      name: "Lib",
      repoName: "valid",
      pathInRepo: "src/Lib",
      cachePath: path.join(tmpDir, "cache", "Lib"),
    };
    const valid = makeRepoConfig({
      name: "valid",
      localPath: validLocal,
      packages: [validPkg],
    });
    const invalid = makeRepoConfig({ name: "invalid", localPath: invalidLocal });
    const config = makeConfig([valid, invalid]);

    const results = await ensureAllReady(config);

    expect(results.get("valid")!.error).toBeUndefined();
    expect(results.get("invalid")!.error).toContain("only supports .NET C# repositories");
  });

  it("fallback from invalid localPath to managed clone preserves warning AND surfaces validation error against managed path", async () => {
    // Local path invalid, managed clone is a non-.NET repo → both warning
    // (fallback context) AND error (validation) must be set, with the error's
    // "Checked path" referencing the managed clone, not the bad localPath.
    const bareDir = await createBareNonNetRepo({ "readme.md": "hello" });
    const badLocal = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(badLocal, { recursive: true });

    const repo = makeRepoConfig({
      name: "mylib",
      localPath: badLocal,
      url: bareDir,
    });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(result.warning).toContain("not a valid git repo");
    expect(result.warning).toContain("Falling back");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("only supports .NET C# repositories");
    // Checked path should be the managed clone, not the bad localPath
    expect(result.error).toContain(result.sourcePath);
    expect(result.error).not.toContain(badLocal);
  });
});

// ── extractProjectReferenceNames ──

describe("extractProjectReferenceNames", () => {
  it("extracts package name from backslash paths", () => {
    const xml = '<ProjectReference Include="..\\Acme.Core\\Acme.Core.csproj" />';
    expect(extractProjectReferenceNames(xml)).toEqual(["Acme.Core"]);
  });

  it("extracts package name from forward-slash paths", () => {
    const xml = '<ProjectReference Include="../Acme.Core/Acme.Core.csproj" />';
    expect(extractProjectReferenceNames(xml)).toEqual(["Acme.Core"]);
  });

  it("extracts multiple references from one file", () => {
    const xml = [
      "<ItemGroup>",
      '  <ProjectReference Include="..\\A\\A.csproj" />',
      '  <ProjectReference Include="..\\B\\B.csproj" />',
      '  <ProjectReference Include="..\\C\\C.csproj" />',
      "</ItemGroup>",
    ].join("\n");
    expect(extractProjectReferenceNames(xml)).toEqual(["A", "B", "C"]);
  });

  it("returns empty array for XML without ProjectReferences", () => {
    const xml = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup /></Project>';
    expect(extractProjectReferenceNames(xml)).toEqual([]);
  });
});

// ── Branch support ──

describe("ensureReady — branch", () => {
  it("clones a specific branch for managed repos", async () => {
    const bareDir = await createBareRepoWithBranch(
      {
        "default.txt": "on-default",
        "src/Lib/Lib.csproj": "<Project />",
      },
      "develop",
      { "develop.txt": "on-develop" },
    );
    const repo = makeRepoConfig({ name: "mylib", url: bareDir, branch: "develop" });
    const config = makeConfig([repo]);

    const result = await ensureReady(repo, config);

    expect(result.mode).toBe("managed");
    expect(result.currentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(result.sourcePath, "develop.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.sourcePath, "default.txt"))).toBe(true);
  });

  it("fetches updates on the specified branch", async () => {
    const bareDir = await createBareRepoWithBranch(
      {
        "default.txt": "on-default",
        "src/Lib/Lib.csproj": "<Project />",
      },
      "develop",
      { "develop.txt": "v1" },
    );
    const repo = makeRepoConfig({ name: "mylib", url: bareDir, branch: "develop" });
    const config = makeConfig([repo]);

    const first = await ensureReady(repo, config);

    // Push a new commit to develop
    const pushDir = path.join(tmpDir, "pusher");
    await execFile("git", ["clone", "-b", "develop", bareDir, pushDir]);
    await execFile("git", ["-C", pushDir, "config", "user.email", "test@test.com"]);
    await execFile("git", ["-C", pushDir, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(pushDir, "new.txt"), "new content");
    await execFile("git", ["-C", pushDir, "add", "."]);
    await execFile("git", ["-C", pushDir, "commit", "-m", "update develop"]);
    await execFile("git", ["-C", pushDir, "push"]);

    const second = await ensureReady(repo, config);

    expect(second.mode).toBe("managed");
    expect(second.currentHash).not.toBe(first.currentHash);
  });
});
