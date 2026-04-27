import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFresh,
  markFresh,
  readOverview,
  writeOverview,
} from "../cacheManager.js";
import {
  getHeadHash,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
  makeWildcardRepo,
  writeCsprojFile,
  writeSlnFile,
} from "../testHelpers.js";
import { digOverview } from "./digOverview.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-dig-overview-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic functionality ──

describe("digOverview", () => {
  it("generates overview for a single package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "/// <summary>Core service interface.</summary>",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digOverview(config, "myrepo");

    expect(result).toContain("# MyLib");
    expect(result).toContain("IService");
    expect(result).toContain("Core service interface.");
  });

  it("returns cached overview without regenerating", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Dummy.cs": "namespace MyLib; public class Dummy { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Pre-populate cache and mark fresh
    const cachedContent = "# MyLib\n\nPre-cached overview.\n";
    await writeOverview(pkg, cachedContent);
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const result = await digOverview(config, "myrepo");

    expect(result).toBe(cachedContent.trimEnd());
  });

  it("regenerates when commit hash changes", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IFoo.cs": [
        "namespace MyLib;",
        "/// <summary>Foo interface.</summary>",
        "public interface IFoo { }",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Pre-populate cache with stale data at an old hash
    await writeOverview(pkg, "# MyLib\n\nStale content.\n");
    await markFresh(cacheDir, "myrepo", "0000000000000000000000000000000000000000");

    const result = await digOverview(config, "myrepo");

    // Should have regenerated — contains interface from actual repo
    expect(result).toContain("IFoo");
    expect(result).toContain("Foo interface.");
    expect(result).not.toContain("Stale content");

    // Cache should now be fresh
    expect(await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir))).toBe(true);
  });

  it("generates missing overview even when cache is fresh", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/PkgA/A.cs": "namespace PkgA; public interface IA { }",
      "src/PkgB/B.cs": "namespace PkgB; public interface IB { }",
    });

    const pkgA = makePkg("PkgA", "myrepo", "src", cacheDir);
    const pkgB = makePkg("PkgB", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkgA, pkgB], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Mark fresh at current hash, but only cache PkgA's overview
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));
    await writeOverview(pkgA, "# PkgA\n\nCached A.\n");

    const result = await digOverview(config, "myrepo");

    // PkgA should use cached content
    expect(result).toContain("Cached A.");
    // PkgB should be generated fresh
    expect(result).toContain("# PkgB");
    expect(result).toContain("IB");
  });
});

// ── Repo scoping ──

describe("repo scoping", () => {
  it("returns overview for the specified repo only", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repo1Dir = await initRepo(tmpDir, {
      "src/Alpha/A.cs": [
        "namespace Alpha;",
        "/// <summary>Alpha interface.</summary>",
        "public interface IAlpha { }",
      ].join("\n"),
    });
    const repo2Dir = await initRepo(tmpDir, {
      "src/Beta/B.cs": [
        "namespace Beta;",
        "/// <summary>Beta interface.</summary>",
        "public interface IBeta { }",
      ].join("\n"),
    });

    const pkgA = makePkg("Alpha", "repo1", "src", cacheDir);
    const pkgB = makePkg("Beta", "repo2", "src", cacheDir);
    const repoA = makeLocalRepo("repo1", repo1Dir, [pkgA], tmpDir);
    const repoB = makeLocalRepo("repo2", repo2Dir, [pkgB], tmpDir);
    const config = makeConfig([repoA, repoB], tmpDir, cacheDir);

    const result = await digOverview(config, "repo1");

    expect(result).toContain("# Alpha");
    expect(result).toContain("IAlpha");
    expect(result).not.toContain("Beta");
  });

  it("returns unknown repo message for non-existent repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });
    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digOverview(config, "nonexistent");

    expect(result).toContain("Unknown repo 'nonexistent'");
    expect(result).toContain("myrepo");
  });
});

// ── Error handling ──

describe("error handling", () => {
  it("shows unavailable message when repo has no source", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("Missing", "norepo", "src", cacheDir);
    const repo = makeRepoConfig(
      {
        name: "norepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digOverview(config, "norepo");

    expect(result).toContain("Missing");
    expect(result).toContain("Source unavailable");
    expect(result).toContain("Warnings");
  });

  it("returns stale cache when repo becomes unreachable", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    // Pre-populate cache with stale data (no valid repo to refresh from)
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

    const result = await digOverview(config, "gonerepo");

    // Should return stale cached content
    expect(result).toContain("Old but useful content.");
    // Should also include a warning
    expect(result).toContain("Warnings");
    expect(result).toContain("gonerepo");
  });

  it("handles unavailable repo with no stale cache", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const badPkg = makePkg("BadLib", "bad", "src", cacheDir);

    const badRepo = makeRepoConfig(
      {
        name: "bad",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [badPkg],
      },
      tmpDir,
    );
    const config = makeConfig([badRepo], tmpDir, cacheDir);

    const result = await digOverview(config, "bad");

    expect(result).toContain("BadLib");
    expect(result).toContain("Source unavailable");
    expect(result).toContain("Warnings");
  });

  it("returns unknown repo message when repo does not exist", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digOverview(config, "myrepo");

    expect(result).toContain("Unknown repo");
  });
});

// ── Wildcard repo error surfacing ──

describe("wildcard repo errors", () => {
  it("surfaces the 'matched zero packages' error when a wildcard repo has no matches", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });
    // Solution references something outside the wildcard prefix
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.*", tmpDir, { localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digOverview(config, "MyCompany.*");

    expect(result).toContain("matched zero packages");
    expect(result).toContain("explicit 'packages' list");
    expect(result).toContain("Warnings");
  });
});

// ── Warnings ──

describe("warnings", () => {
  it("omits warnings section when no warnings occur", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/FallbackLib/F.cs": "namespace FallbackLib; public class F { }",
    });

    const pkg = makePkg("FallbackLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digOverview(config, "myrepo");

    expect(result).not.toContain("Warnings");
  });
});

// ── Cache freshness ──

describe("cache freshness lifecycle", () => {
  it("marks cache fresh after successful generation", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await digOverview(config, "myrepo");

    // Verify cache is now fresh
    expect(await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir))).toBe(true);

    // Verify overview is cached
    const cached = await readOverview(pkg);
    expect(cached).toContain("# MyLib");
  });

  it("invalidates old cache before regenerating", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/New.cs": [
        "namespace MyLib;",
        "/// <summary>New interface.</summary>",
        "public interface INew { }",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Write stale overview at old hash
    await writeOverview(pkg, "# MyLib\n\n- OldInterface\n");
    await markFresh(cacheDir, "myrepo", "deadbeef00000000000000000000000000000000");

    await digOverview(config, "myrepo");

    // Old content should be replaced
    const cached = await readOverview(pkg);
    expect(cached).toContain("INew");
    expect(cached).not.toContain("OldInterface");
  });
});
