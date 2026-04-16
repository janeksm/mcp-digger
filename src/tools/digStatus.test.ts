import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "../config.js";
import {
  createBareRepo,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
} from "../testHelpers.js";
import { digStatus } from "./digStatus.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-dig-status-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Config summary ──

describe("config summary", () => {
  it("renders auth strategy and PAT status", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digStatus(config);

    expect(result).toContain("Auth strategy:** none");
    expect(result).toContain("PAT:** not set");
    expect(result).toContain("Repos:** 0");
  });

  it("shows PAT as configured when present", async () => {
    const config = makeConfig([], tmpDir);
    config.auth = { strategy: "auto", pat: "some-token" };

    const result = await digStatus(config);

    expect(result).toContain("Auth strategy:** auto");
    expect(result).toContain("PAT:** configured");
  });

  it("returns sensible output with no repos configured", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digStatus(config);

    expect(result).toContain("No repositories configured");
    expect(result).toContain("Repos:** 0");
  });

  it("displays config warnings", async () => {
    const config = makeConfig([], tmpDir);
    config.warnings = ["Orphan LOCAL_REPOS entry 'stale'"];

    const result = await digStatus(config);

    expect(result).toContain("Config warnings");
    expect(result).toContain("Orphan LOCAL_REPOS entry 'stale'");
  });
});

// ── Local repo checks ──

describe("local repo checks", () => {
  it("reports OK for valid local repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Local repo valid:** OK");
    expect(result).toContain("All checks passed");
  });

  it("reports FAILED for invalid local path", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo: RepoConfig = {
      name: "myrepo",
      localPath: path.join(tmpDir, "nonexistent"),
      managedSourcePath: path.join(tmpDir, "source", "myrepo"),
      sourceRoot: "src",
      discoveryMode: "explicit",
      packages: [pkg],
    };
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Local repo valid:** FAILED");
    expect(result).toContain("1 of 1 repo(s) have issues");
  });
});

// ── Remote connectivity checks ──

describe("remote connectivity checks", () => {
  it("reports OK for reachable bare repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const bareDir = await createBareRepo(tmpDir, { "file.txt": "content" });

    const repo: RepoConfig = {
      name: "remoterepo",
      url: bareDir,
      managedSourcePath: path.join(tmpDir, "source", "remoterepo"),
      sourceRoot: "src",
      discoveryMode: "explicit",
      packages: [],
    };
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Remote connectivity:** OK");
    expect(result).toContain("branch refs found");
    expect(result).toContain("All checks passed");
  });

  it("reports FAILED for unreachable URL", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repo: RepoConfig = {
      name: "badrepo",
      url: "/nonexistent/repo.git",
      managedSourcePath: path.join(tmpDir, "source", "badrepo"),
      sourceRoot: "src",
      discoveryMode: "explicit",
      packages: [],
    };
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Remote connectivity:** FAILED");
    expect(result).toContain("Error:");
    expect(result).toContain("1 of 1 repo(s) have issues");
  });
});

// ── Mixed results ──

describe("mixed results", () => {
  it("counts issues correctly with mixed repos", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Good/A.cs": "namespace Good;" });

    const goodPkg = makePkg("Good", "good", "src", cacheDir);
    const goodRepo = makeLocalRepo("good", repoDir, [goodPkg], tmpDir);

    const badRepo: RepoConfig = {
      name: "bad",
      localPath: path.join(tmpDir, "nonexistent"),
      managedSourcePath: path.join(tmpDir, "source", "bad"),
      sourceRoot: "src",
      discoveryMode: "explicit",
      packages: [],
    };

    const config = makeConfig([goodRepo, badRepo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Repo: good");
    expect(result).toContain("Repo: bad");
    expect(result).toContain("1 of 2 repo(s) have issues");
  });
});

// ── Repo info display ──

describe("repo info display", () => {
  it("shows mode, source root, discovery, and packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "lib/Core/C.cs": "namespace Core;" });

    const pkg = makePkg("Core", "myrepo", "lib", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir, "lib");
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Mode:** local");
    expect(result).toContain("Source root:** lib");
    expect(result).toContain("Discovery:** explicit (1)");
    expect(result).toContain("Packages:** Core");
  });

  it("shows managed mode for repos with URL only", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const bareDir = await createBareRepo(tmpDir, { "f.txt": "x" });

    const repo: RepoConfig = {
      name: "managed",
      url: bareDir,
      managedSourcePath: path.join(tmpDir, "source", "managed"),
      sourceRoot: "src",
      discoveryMode: "auto",
      packages: [],
    };
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Mode:** managed");
    expect(result).toContain("auto");
  });

  it("shows auto discovery with not yet discovered when no packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "content" });

    const repo = makeLocalRepo("myrepo", repoDir, [], tmpDir);
    repo.discoveryMode = "auto";
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("auto (not yet discovered)");
  });
});
