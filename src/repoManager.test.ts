import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "./config.js";
import { ensureAllReady, ensureReady } from "./repoManager.js";
import {
  createBareRepo as createBareRepoHelper,
  initRepo as initRepoHelper,
  makeConfig as makeConfigHelper,
  makeRepoConfig as makeRepoConfigHelper,
} from "./testHelpers.js";

const execFile = util.promisify(child_process.execFile);

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-repo-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const initRepo = (files: Record<string, string>) => initRepoHelper(tmpDir, files);
const createBareRepo = (files: Record<string, string>) => createBareRepoHelper(tmpDir, files);
const makeConfig = (repos: RepoConfig[]) => makeConfigHelper(repos, tmpDir);
const makeRepoConfig = (overrides: Partial<RepoConfig> & { name: string }) =>
  makeRepoConfigHelper(overrides, tmpDir);

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
    const bareDir = await createBareRepo({ "readme.md": "hello" });
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
    const bareDir = await createBareRepo({ "file.txt": "v1" });
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
    const bareDir = await createBareRepo({ "hello.txt": "world" });
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
    const localRepo = await initRepo({ "file.txt": "local" });
    const bareDir = await createBareRepo({ "file.txt": "managed" });
    const repo1 = makeRepoConfig({ name: "local-lib", localPath: localRepo });
    const repo2 = makeRepoConfig({ name: "remote-lib", url: bareDir });
    const config = makeConfig([repo1, repo2]);

    const results = await ensureAllReady(config);

    expect(results.get("local-lib")!.mode).toBe("local");
    expect(results.get("remote-lib")!.mode).toBe("managed");
  });
});
