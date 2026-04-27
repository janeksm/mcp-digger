import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFresh,
  markFresh,
  readSignatures,
  writeSignature,
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
import { digSignatures } from "./digSignatures.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-digger-dig-signatures-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic functionality ──

describe("digSignatures", () => {
  it("generates signatures for a package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "/// <summary>Core service.</summary>",
        "public interface IService",
        "{",
        "    void Execute();",
        "    string GetName(int id);",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const full = await digSignatures(config, "MyLib");
    const result = full.text;

    expect(full.isError).toBe(false);
    expect(result).toContain("# MyLib — Signatures");
    expect(result).toContain("IService.cs");
    expect(result).toContain("```csharp");
    expect(result).toContain("IService");
  });

  it("returns cached signatures without regenerating", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Dummy.cs": "namespace MyLib; public class Dummy { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // Pre-populate cache and mark fresh
    await writeSignature(pkg, "Dummy.cs", "// cached signature content");
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const { text: result } = await digSignatures(config, "MyLib");

    expect(result).toContain("cached signature content");
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
    await writeSignature(pkg, "Old.cs", "// stale content");
    await markFresh(
      cacheDir,
      "myrepo",
      "0000000000000000000000000000000000000000",
    );

    const { text: result } = await digSignatures(config, "MyLib");

    // Should have regenerated from actual repo
    expect(result).toContain("IFoo");
    expect(result).not.toContain("stale content");

    // Cache should now be fresh
    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);
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

    const full = await digSignatures(config, "NonExistent");

    expect(full.isError).toBe(true);
    expect(full.text).toContain("Unknown package 'NonExistent'");
    expect(full.text).toContain("Alpha");
  });

  it("returns message when no packages configured", async () => {
    const config = makeConfig([], tmpDir);

    const full = await digSignatures(config, "Anything");

    expect(full.isError).toBe(true);
    expect(full.text).toContain("Unknown package 'Anything'");
    expect(full.text).toContain("No packages are configured");
  });

  it("hints to run dig_overview when a wildcard repo is unresolved", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "readme.md": "hi" });
    const wildcard = makeWildcardRepo("MyCompany.*", tmpDir, { localPath: repoDir });
    const config = makeConfig([wildcard], tmpDir, cacheDir);

    const full = await digSignatures(config, "MyCompany.Core");

    expect(full.isError).toBe(true);
    expect(full.text).toContain("Unknown package 'MyCompany.Core'");
    expect(full.text).toMatch(/wildcard repo.*'MyCompany\.\*'.*have not resolved/i);
    expect(full.text).toContain("dig_overview");
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

    const full = await digSignatures(config, "Missing");

    expect(full.isError).toBe(true);
    expect(full.text).toContain("Missing");
    expect(full.text).toContain("Source unavailable");
  });

  it("returns stale cache when repo becomes unreachable", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    // Pre-populate cache with stale signatures
    await writeSignature(pkg, "Old.cs", "// old but useful");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const full = await digSignatures(config, "StaleLib");

    expect(full.isError).toBe(false);
    expect(full.text).toContain("old but useful");
    expect(full.text).toContain("Warning");
    expect(full.text).toContain("stale");
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

    const { text: result } = await digSignatures(config, "EmptyLib");

    expect(result).toContain("EmptyLib");
    expect(result).toContain("No .cs source files found");
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

    await digSignatures(config, "MyLib");

    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);

    const cached = await readSignatures(pkg);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0]!.content).toContain("MyLib");
  });
});
