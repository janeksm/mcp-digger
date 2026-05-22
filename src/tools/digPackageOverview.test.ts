import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markFresh,
  writeOverview,
} from "../cacheManager.js";
import {
  cleanupTmpDir,
  getHeadHash,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
} from "../testHelpers.js";
import { digPackageOverview } from "./digPackageOverview.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-pkg-overview-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// ── Basic functionality ──

describe("digPackageOverview", () => {
  it("generates overview for a named package only", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/PkgA/IFoo.cs": [
        "namespace PkgA;",
        "/// <summary>Foo interface.</summary>",
        "public interface IFoo { }",
      ].join("\n"),
      "src/PkgA/PkgA.csproj": "<Project />",
      "src/PkgB/IBar.cs": [
        "namespace PkgB;",
        "/// <summary>Bar interface.</summary>",
        "public interface IBar { }",
      ].join("\n"),
      "src/PkgB/PkgB.csproj": "<Project />",
    });

    const pkgA = makePkg("PkgA", "myrepo", "src", cacheDir);
    const pkgB = makePkg("PkgB", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkgA, pkgB], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "myrepo", "PkgA");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# PkgA");
    expect(result.text).toContain("IFoo");
    expect(result.text).not.toContain("PkgB");
    expect(result.text).not.toContain("IBar");
    expect(result.text).toContain("*1 source file");
  });

  it("shows plural file count", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/User.cs": "namespace MyLib.Domain;\npublic class User { }",
      "src/MyLib/Services/Auth.cs": "namespace MyLib.Services;\npublic class Auth { }",
      "src/MyLib/MyLib.csproj": "<Project />",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "myrepo", "MyLib");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("*2 source files");
  });

  it("does not include Source Files section", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/User.cs": "namespace MyLib.Domain;\npublic class User { }",
      "src/MyLib/Services/Auth.cs": "namespace MyLib.Services;\npublic class Auth { }",
      "src/MyLib/MyLib.csproj": "<Project />",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "myrepo", "MyLib");

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("## Source Files");
  });

  it("returns cached overview when fresh", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Dummy.cs": "namespace MyLib; public class Dummy { }",
      "src/MyLib/MyLib.csproj": "<Project />",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const cachedContent = "# MyLib\n\nPre-cached overview.\n";
    await writeOverview(pkg, cachedContent);
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const result = await digPackageOverview(config, "myrepo", "MyLib");

    expect(result.text).toBe(cachedContent.trimEnd());
  });

  it("regenerates when commit hash changes", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IFoo.cs": [
        "namespace MyLib;",
        "/// <summary>Foo interface.</summary>",
        "public interface IFoo { }",
      ].join("\n"),
      "src/MyLib/MyLib.csproj": "<Project />",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await writeOverview(pkg, "# MyLib\n\nStale content.\n");
    await markFresh(cacheDir, "myrepo", "0000000000000000000000000000000000000000");

    const result = await digPackageOverview(config, "myrepo", "MyLib");

    expect(result.text).toContain("IFoo");
    expect(result.text).not.toContain("Stale content");
  });
});

// ── Error handling ──

describe("error handling", () => {
  it("returns error for unknown repo", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digPackageOverview(config, "nonexistent", "MyLib");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown repo");
  });

  it("returns error for unknown package in repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
      "src/MyLib/MyLib.csproj": "<Project />",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "myrepo", "NonExistent");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'NonExistent'");
    expect(result.text).toContain("MyLib");
  });

  it("returns stale cache when repo becomes unreachable", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    await writeOverview(pkg, "# StaleLib\n\nOld but useful content.\n");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "gonerepo", "StaleLib");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Old but useful content.");
    expect(result.text).toContain("stale");
  });

  it("returns error when repo unreachable and no stale cache", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("BadLib", "bad", "src", cacheDir);

    const repo = makeRepoConfig(
      {
        name: "bad",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageOverview(config, "bad", "BadLib");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("bad");
  });
});
