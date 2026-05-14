import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFresh,
  markFresh,
  readIndex,
  readSignatures,
  writeIndex,
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

// ── Keyword filtering ──

describe("digSignatures — keyword filtering", () => {
  it("returns signatures for matching type name", async () => {
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
      "src/MyLib/Unrelated.cs": [
        "namespace MyLib;",
        "public class Unrelated",
        "{",
        "    public void DoStuff() { return; }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "IService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService");
    expect(result.text).toContain("```csharp");
    expect(result.text).not.toContain("Unrelated");
  });

  it("returns signatures for file containing matching method", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyService.cs": [
        "namespace MyLib;",
        "public class MyService",
        "{",
        "    public void Execute() { return; }",
        "}",
      ].join("\n"),
      "src/MyLib/Other.cs": [
        "namespace MyLib;",
        "public class Other",
        "{",
        "    public void DoStuff() { return; }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "Execute");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("MyService.cs");
    expect(result.text).not.toContain("Other.cs");
  });

  it("matches substring by default (case-insensitive)", async () => {
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

    const result = await digSignatures(config, "MyLib", "service");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService");
  });

  it("exact match matches exact symbol name (case-insensitive)", async () => {
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

    const result = await digSignatures(config, "MyLib", "iservice", true);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService");
  });

  it("exact match does not match substring", async () => {
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

    const result = await digSignatures(config, "MyLib", "Service", true);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matches");
  });

  it("returns no-match success message when keyword not found", async () => {
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

    const result = await digSignatures(config, "MyLib", "NonExistent");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matches for 'NonExistent'");
    expect(result.text).toContain("dig_lookup");
  });

  it("returns signatures from multiple matching files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
      "src/MyLib/ServiceImpl.cs": [
        "namespace MyLib;",
        "public class ServiceImpl : IService",
        "{",
        "    public void Execute() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "Service");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IService.cs");
    expect(result.text).toContain("ServiceImpl.cs");
    expect(result.text).toContain("Found 2 match");
  });

  it("deduplicates files — prefers type entry over method entry for heading", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService",
        "{",
        "    void ServiceHelper();",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // "Service" matches both IService (interface) and ServiceHelper (method) in same file
    const result = await digSignatures(config, "MyLib", "Service");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Found 1 match");
    expect(result.text).toContain("IService (interface)");
  });

  it("shows generics and modifiers in type headings", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Entity.cs": [
        "namespace MyLib;",
        "public abstract class Entity<TId>",
        "{",
        "    public TId Id { get; set; }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "Entity");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Entity<TId> (abstract class)");
  });
});

// ── Contextual hints ──

describe("digSignatures — contextual hints", () => {
  it("hints dig_file for full implementation", async () => {
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

    const result = await digSignatures(config, "MyLib", "IService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("dig_file");
    expect(result.text).toContain("full implementation");
  });
});

// ── Caching ──

describe("digSignatures — caching", () => {
  it("returns cached index and signatures without regenerating", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Dummy.cs": "namespace MyLib; public class Dummy { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await writeIndex(pkg, "Dummy|class|Dummy.cs");
    await writeSignature(pkg, "Dummy.cs", "// cached signature content");
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const result = await digSignatures(config, "MyLib", "Dummy");

    expect(result.text).toContain("cached signature content");
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

    await writeIndex(pkg, "Old|class|Old.cs");
    await writeSignature(pkg, "Old.cs", "// stale content");
    await markFresh(
      cacheDir,
      "myrepo",
      "0000000000000000000000000000000000000000",
    );

    const result = await digSignatures(config, "MyLib", "IFoo");

    expect(result.text).toContain("IFoo");
    expect(result.text).not.toContain("stale content");
    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);
  });

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

    await digSignatures(config, "MyLib", "X");

    expect(
      await isFresh(cacheDir, "myrepo", await getHeadHash(repoDir)),
    ).toBe(true);
    const cached = await readSignatures(pkg);
    expect(cached.length).toBeGreaterThan(0);
    expect(await readIndex(pkg)).toBeDefined();
  });
});

// ── Unknown package ──

describe("digSignatures — unknown package", () => {
  it("lists available packages when package not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/A.cs": "namespace Alpha; public class A { }",
    });

    const pkg = makePkg("Alpha", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "NonExistent", "anything");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'NonExistent'");
    expect(result.text).toContain("Alpha");
  });

  it("returns message when no packages configured", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digSignatures(config, "Anything", "keyword");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'Anything'");
    expect(result.text).toContain("No packages are configured");
  });

  it("hints to run dig_list when a wildcard repo is unresolved", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "readme.md": "hi" });
    const wildcard = makeWildcardRepo("MyCompany.Libs", tmpDir, {
      packageFilter: "MyCompany.*",
      localPath: repoDir,
    });
    const config = makeConfig([wildcard], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyCompany.Core", "keyword");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'MyCompany.Core'");
    expect(result.text).toMatch(
      /filtered repo.*'MyCompany\.Libs'.*have not resolved/i,
    );
    expect(result.text).toContain("dig_list");
  });
});

// ── Error handling ──

describe("digSignatures — error handling", () => {
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

    const result = await digSignatures(config, "Missing", "anything");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Missing");
    expect(result.text).toContain("Source unavailable");
  });

  it("returns stale cache filtered by keyword when repo becomes unreachable", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    await writeIndex(
      pkg,
      "OldType|class|Old.cs\nUnrelated|class|Other.cs",
    );
    await writeSignature(pkg, "Old.cs", "// old but useful");
    await writeSignature(pkg, "Other.cs", "// unrelated content");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "StaleLib", "OldType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("old but useful");
    expect(result.text).not.toContain("unrelated content");
    expect(result.text).toContain("Warning");
    expect(result.text).toContain("stale");
  });
});

// ── Empty package ──

describe("digSignatures — empty package", () => {
  it("returns no-match message when package has no .cs files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/EmptyLib/readme.txt": "nothing here",
    });

    const pkg = makePkg("EmptyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "EmptyLib", "anything");

    expect(result.text).toContain("No matches");
  });
});
