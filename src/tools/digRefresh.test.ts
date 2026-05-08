import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFresh, markFresh, writeIndex } from "../cacheManager.js";
import {
  getHeadHash,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
} from "../testHelpers.js";
import { digRefresh } from "./digRefresh.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-refresh-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("digRefresh", () => {
  it("refreshes a single repo by name", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRefresh(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# dig_refresh");
    expect(result.text).toContain("Refreshed 1 repo");
    expect(result.text).toContain("## myrepo (local)");
    expect(result.text).toContain("Packages: 1");
    expect(result.text).toContain("Cache cleared");
  });

  it("refreshes all repos when repoName is omitted", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir1 = await initRepo(tmpDir, {
      "src/PkgA/A.cs": "namespace PkgA; public class A { }",
    });
    const repoDir2 = await initRepo(tmpDir, {
      "src/PkgB/B.cs": "namespace PkgB; public class B { }",
    });

    const pkgA = makePkg("PkgA", "repo1", "src", cacheDir);
    const pkgB = makePkg("PkgB", "repo2", "src", cacheDir);
    const repo1 = makeLocalRepo("repo1", repoDir1, [pkgA], tmpDir);
    const repo2 = makeLocalRepo("repo2", repoDir2, [pkgB], tmpDir);
    const config = makeConfig([repo1, repo2], tmpDir, cacheDir);

    const result = await digRefresh(config, undefined);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Refreshed 2 repos (2 packages)");
    expect(result.text).toContain("## repo1 (local)");
    expect(result.text).toContain("## repo2 (local)");
  });

  it("returns error for unknown repo name", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digRefresh(config, "nonexistent");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown repo");
  });

  it("actually clears the cache", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });
    const hash = await getHeadHash(repoDir);

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", hash);
    await writeIndex(pkg, "Class1|class|src/MyLib/Class1.cs");
    expect(await isFresh(cacheDir, "myrepo", hash)).toBe(true);

    await digRefresh(config, "myrepo");

    expect(await isFresh(cacheDir, "myrepo", hash)).toBe(false);
  });

  it("shows old → new hash when commit changed", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "0000000000000000000000000000000000000000");

    const result = await digRefresh(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/00000000 → [0-9a-f]{8}/);
  });

  it("shows unchanged hash with forced re-index note", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });
    const hash = await getHeadHash(repoDir);

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", hash);

    const result = await digRefresh(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("unchanged — forced re-index");
  });

  it("captures per-repo errors without throwing", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("Missing", "badrepo", "src", cacheDir);
    const repo = makeRepoConfig(
      {
        name: "badrepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRefresh(config, "badrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("failed");
    expect(result.text).toContain("## badrepo");
    expect(result.text).toContain("Error:");
  });

  it("is idempotent — second refresh succeeds", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result1 = await digRefresh(config, "myrepo");
    const result2 = await digRefresh(config, "myrepo");

    expect(result1.isError).toBe(false);
    expect(result2.isError).toBe(false);
    expect(result2.text).toContain("Refreshed 1 repo");
  });
});
