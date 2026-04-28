import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFresh,
  markFresh,
  readIndex,
  writeIndex,
} from "../cacheManager.js";
import {
  getHeadHash,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
  makeWildcardRepo,
} from "../testHelpers.js";
import { digLookup } from "./digLookup.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-digger-dig-lookup-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic functionality ──

describe("digLookup", () => {
  it("finds a type by name", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "MyLib", "IService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService");
    expect(result.text).toContain("interface");
    expect(result.text).toContain("IService.cs");
  });

  it("finds a method by name", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": [
        "namespace MyLib;",
        "public class OrderService",
        "{",
        "    public void CreateOrder(int id)",
        "    {",
        "        // body",
        "    }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "MyLib", "CreateOrder");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("CreateOrder");
    expect(result.text).toContain("method on OrderService");
    expect(result.text).toContain("Service.cs");
  });

  it("performs case-insensitive search", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService { }",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "MyLib", "iservice");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService");
  });

  it("returns cached index without regenerating", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Dummy.cs": "namespace MyLib; public class Dummy { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Pre-populate cache and mark fresh
    await writeIndex(pkg, "CachedType|class|Cached.cs");
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const result = await digLookup(config, "MyLib", "CachedType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("CachedType");
    expect(result.text).toContain("Cached.cs");
  });

  it("regenerates when commit hash changes", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IFoo.cs": [
        "namespace MyLib;",
        "public interface IFoo",
        "{",
        "    void DoFoo();",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Pre-populate cache with stale data at an old hash
    await writeIndex(pkg, "StaleType|class|Stale.cs");
    await markFresh(
      cacheDir,
      "myrepo",
      "0000000000000000000000000000000000000000",
    );

    const result = await digLookup(config, "MyLib", "IFoo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IFoo");
    expect(result.text).not.toContain("StaleType");

    // Cache should now be fresh
    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);
  });

  it("returns no-matches message when keyword not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": "namespace MyLib;\npublic class Service { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "MyLib", "NonExistentThing");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matches");
    expect(result.text).toContain("NonExistentThing");
  });
});

// ── Unknown package ──

describe("unknown package", () => {
  it("lists available packages when package not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/A.cs": "namespace Alpha; public class A { }",
    });

    const pkg = makePkg("Alpha", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "NonExistent", "anything");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'NonExistent'");
    expect(result.text).toContain("Alpha");
  });

  it("returns message when no packages configured", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digLookup(config, "Anything", "keyword");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'Anything'");
    expect(result.text).toContain("No packages are configured");
  });

  it("hints to run dig_list when a wildcard repo is unresolved", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "readme.md": "hi" });
    const wildcard = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([wildcard], tmpDir, cacheDir);

    const result = await digLookup(config, "MyCompany.Core", "anything");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'MyCompany.Core'");
    expect(result.text).toMatch(/filtered repo.*'MyCompany\.Libs'.*have not resolved/i);
    expect(result.text).toContain("dig_list");
  });
});

// ── Error handling ──

describe("error handling", () => {
  it("shows unavailable when repo is unreachable", async () => {
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

    const result = await digLookup(config, "Missing", "anything");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Missing");
    expect(result.text).toContain("Source unavailable");
  });

  it("returns stale cache when repo becomes unreachable", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    // Pre-populate cache with stale index
    await writeIndex(pkg, "OldType|class|Old.cs");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "StaleLib", "OldType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("OldType");
    expect(result.text).toContain("Warning");
    expect(result.text).toContain("stale");
  });
});

// ── No source files ──

describe("empty package", () => {
  it("returns message when package has no .cs files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/EmptyLib/readme.txt": "nothing here",
    });

    const pkg = makePkg("EmptyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "EmptyLib", "anything");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("EmptyLib");
    expect(result.text).toContain("No .cs source files found");
  });
});

// ── Cache freshness lifecycle ──

describe("cache freshness lifecycle", () => {
  it("marks cache fresh after successful generation", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": [
        "namespace MyLib;",
        "public class X",
        "{",
        "    public void DoStuff() { return; }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await digLookup(config, "MyLib", "X");

    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);

    const cached = await readIndex(pkg);
    expect(cached).toBeDefined();
    expect(cached).toContain("X|class");
  });
});
