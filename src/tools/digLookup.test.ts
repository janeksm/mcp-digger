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

// C# source fragments for cross-package tests
const CS_INTERFACE = (ns: string, name: string) =>
  `namespace ${ns};\npublic interface ${name}\n{\n    void Execute();\n}`;

const CS_CLASS = (ns: string, name: string) =>
  `namespace ${ns};\npublic class ${name}\n{\n    public void Run() { }\n}`;

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

  it("shows generics and modifiers in symbol mode output", async () => {
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

    const result = await digLookup(config, "MyLib", "Entity");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**Entity<TId>** (abstract class)");
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

// ── Cross-package lookup ──

describe("cross-package lookup", () => {
  it("finds matches across multiple packages in the same repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/IAlphaService.cs": CS_INTERFACE("Alpha", "IAlphaService"),
      "src/Beta/IBetaService.cs": CS_INTERFACE("Beta", "IBetaService"),
    });

    const alpha = makePkg("Alpha", "myrepo", "src", cacheDir);
    const beta = makePkg("Beta", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [alpha, beta], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "Service");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Cross-package lookup");
    expect(result.text).toContain("IAlphaService");
    expect(result.text).toContain("IBetaService");
    expect(result.text).toContain("## Alpha");
    expect(result.text).toContain("## Beta");
  });

  it("finds matches across packages in different repos", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir1 = await initRepo(tmpDir, {
      "src/Alpha/AlphaWorker.cs": CS_CLASS("Alpha", "AlphaWorker"),
    });
    const repoDir2 = await initRepo(tmpDir, {
      "src/Beta/BetaWorker.cs": CS_CLASS("Beta", "BetaWorker"),
    });

    const alpha = makePkg("Alpha", "repo1", "src", cacheDir);
    const beta = makePkg("Beta", "repo2", "src", cacheDir);
    const repo1 = makeLocalRepo("repo1", repoDir1, [alpha], tmpDir);
    const repo2 = makeLocalRepo("repo2", repoDir2, [beta], tmpDir);
    const config = makeConfig([repo1, repo2], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "Worker");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("AlphaWorker");
    expect(result.text).toContain("BetaWorker");
    expect(result.text).toContain("across 2 packages");
  });

  it("returns no-matches message when keyword not found anywhere", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/Foo.cs": CS_CLASS("Alpha", "Foo"),
    });

    const alpha = makePkg("Alpha", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [alpha], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "NonExistent");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No matches");
    expect(result.text).toContain("NonExistent");
  });

  it("handles repo errors gracefully with partial results", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/AlphaType.cs": CS_CLASS("Alpha", "AlphaType"),
    });

    const alpha = makePkg("Alpha", "goodrepo", "src", cacheDir);
    const beta = makePkg("Beta", "badrepo", "src", cacheDir);
    const goodRepo = makeLocalRepo("goodrepo", repoDir, [alpha], tmpDir);
    const badRepo = makeRepoConfig(
      {
        name: "badrepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [beta],
      },
      tmpDir,
    );
    const config = makeConfig([goodRepo, badRepo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "AlphaType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("AlphaType");
    expect(result.text).toContain("Warning");
  });

  it("uses stale cache for unreachable repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);
    await writeIndex(pkg, "StaleType|class|Stale.cs");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "StaleType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("StaleType");
    expect(result.text).toContain("## StaleLib");
  });

  it("skips packages with no .cs files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/AlphaType.cs": CS_CLASS("Alpha", "AlphaType"),
      "src/Empty/readme.txt": "no code here",
    });

    const alpha = makePkg("Alpha", "myrepo", "src", cacheDir);
    const empty = makePkg("Empty", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [alpha, empty], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "AlphaType");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("AlphaType");
    expect(result.text).toContain("across 1 package");
    expect(result.text).not.toContain("## Empty");
  });

  it("uses cached index when fresh", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/Dummy.cs": CS_CLASS("Alpha", "Dummy"),
    });

    const alpha = makePkg("Alpha", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [alpha], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await writeIndex(alpha, "CachedSymbol|class|Cached.cs");
    await markFresh(cacheDir, "myrepo", await getHeadHash(repoDir));

    const result = await digLookup(config, undefined, "CachedSymbol");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("CachedSymbol");
    expect(result.text).toContain("Cached.cs");
  });
});

// ── Implements mode ──

const CS_WITH_BASE = (ns: string, name: string, bases: string) =>
  `namespace ${ns};\npublic class ${name} : ${bases}\n{\n    public void Run() { }\n}`;

describe("implements mode", () => {
  it("finds implementors in a single package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": CS_INTERFACE("Lib", "IService"),
      "src/Lib/ServiceImpl.cs": CS_WITH_BASE("Lib", "ServiceImpl", "IService"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IService", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("ServiceImpl");
    expect(result.text).toContain("implements");
    expect(result.text).toContain(": IService");
  });

  it("finds implementors cross-package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/IRepo.cs": CS_INTERFACE("Core", "IRepo"),
      "src/Data/SqlRepo.cs": CS_WITH_BASE("Data", "SqlRepo", "IRepo"),
    });

    const core = makePkg("Core", "myrepo", "src", cacheDir);
    const data = makePkg("Data", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [core, data], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "IRepo", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("SqlRepo");
    expect(result.text).toContain("## Data");
  });

  it("matches case-insensitively", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Impl.cs": CS_WITH_BASE("Lib", "Impl", "IService"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "iservice", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Impl");
  });

  it("returns no-match message when nothing implements the keyword", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Foo.cs": CS_CLASS("Lib", "Foo"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "INothing", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No types implementing");
  });

  it("finds subclasses of abstract class", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Base.cs": "namespace Lib;\npublic abstract class Base\n{\n}",
      "src/Lib/Child.cs": CS_WITH_BASE("Lib", "Child", "Base"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "Base", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Child");
    expect(result.text).toContain(": Base");
  });

  it("shows generics and modifiers in implements mode output", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IRepo.cs": CS_INTERFACE("Lib", "IRepo"),
      "src/Lib/SqlRepo.cs": [
        "namespace Lib;",
        "public sealed class SqlRepo<T> : IRepo",
        "{",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IRepo", "implements");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("**SqlRepo<T>** (sealed class)");
  });
});

// ── References mode ──

describe("references mode", () => {
  it("finds files referencing a type", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": CS_INTERFACE("Lib", "IService"),
      "src/Lib/Consumer.cs": [
        "namespace Lib;",
        "public class Consumer",
        "{",
        "    private readonly IService _svc;",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IService", "references");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("references");
    expect(result.text).toContain("IService.cs");
    expect(result.text).toContain("Consumer.cs");
  });

  it("respects word boundaries", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IFoo.cs": CS_INTERFACE("Lib", "IFoo"),
      "src/Lib/IFooFactory.cs": [
        "namespace Lib;",
        "public interface IFooFactory",
        "{",
        "    IFoo Create();",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IFoo", "references");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IFoo.cs");
    expect(result.text).toContain("IFooFactory.cs");
    // IFooFactory.cs has "IFoo" as a word boundary match in "IFoo Create()"
  });

  it("cross-package reference search", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/IEntity.cs": "namespace Core;\npublic interface IEntity { }",
      "src/Data/Repo.cs": "namespace Data;\npublic class Repo\n{\n    public IEntity Get() { return null; }\n}",
    });

    const core = makePkg("Core", "myrepo", "src", cacheDir);
    const data = makePkg("Data", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [core, data], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "IEntity", "references");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## Core");
    expect(result.text).toContain("## Data");
    expect(result.text).toContain("IEntity.cs");
    expect(result.text).toContain("Repo.cs");
  });

  it("enforces file cap across packages within a single repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`src/PkgA/File${i}.cs`] = `namespace PkgA;\npublic class A${i} { public Target Get() => null; }`;
      files[`src/PkgB/File${i}.cs`] = `namespace PkgB;\npublic class B${i} { public Target Get() => null; }`;
    }
    const repoDir = await initRepo(tmpDir, files);

    const pkgA = makePkg("PkgA", "myrepo", "src", cacheDir);
    const pkgB = makePkg("PkgB", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkgA, pkgB], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "Target", "references");

    expect(result.isError).toBe(false);
    const fileMatches = result.text.match(/`File\d+\.cs`/g) ?? [];
    expect(fileMatches.length).toBeLessThanOrEqual(50);
    expect(result.text).toContain("capped");
  });

  it("returns no-references message when keyword not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Foo.cs": CS_CLASS("Lib", "Foo"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "NonExistent", "references");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No references");
  });

  // ── Contextual hints ──

  it("hints dig_signatures/dig_file for single symbol match", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/OrderService.cs": CS_CLASS("Lib", "OrderService"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "OrderService");

    expect(result.text).toContain("Single match");
    expect(result.text).toContain("dig_signatures");
    expect(result.text).toContain("dig_file");
  });

  it("hints implements mode when interface found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": CS_INTERFACE("Lib", "IService"),
      "src/Lib/IRepo.cs": CS_INTERFACE("Lib", "IRepo"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "I");

    expect(result.text).toContain("implements");
  });

  it("hints implements mode cross-package when interface found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/IHandler.cs": CS_INTERFACE("Core", "IHandler"),
      "src/App/Worker.cs": CS_CLASS("App", "Worker"),
    });

    const core = makePkg("Core", "myrepo", "src", cacheDir);
    const app = makePkg("App", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [core, app], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "Handler");

    expect(result.text).toContain("implements");
  });

  it("hints single implementor in implements mode", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": CS_INTERFACE("Lib", "IService"),
      "src/Lib/Impl.cs": CS_WITH_BASE("Lib", "Impl", "IService"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IService", "implements");

    expect(result.text).toContain("Single implementor");
    expect(result.text).toContain("dig_signatures");
  });

  it("default mode is symbol (backward compat)", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": CS_INTERFACE("Lib", "IService"),
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "IService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("lookup:");
    expect(result.text).toContain("IService");
  });
});

// ── Result ranking ──

describe("result ranking", () => {
  it("ranks exact match above prefix above substring", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    // Names chosen so alphabetical order (AReorderUtil, Order, ZOrderService)
    // differs from ranked order (Order=1.0, ZOrderService=0.8, AReorderUtil=0.6)
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/AReorderUtil.cs": "namespace Lib;\npublic class AReorderUtil\n{\n}",
      "src/Lib/Order.cs": "namespace Lib;\npublic class Order\n{\n}",
      "src/Lib/ZOrderService.cs": "namespace Lib;\npublic class ZOrderService\n{\n}",
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "Order");

    expect(result.isError).toBe(false);
    const lines = result.text.split("\n").filter((l: string) => l.startsWith("- **"));
    // Ranked: exact (1.0), then boundary/prefix (0.8), then substring (0.6)
    expect(lines[0]).toContain("**Order**");
    expect(lines[1]).toContain("**ZOrderService**");
    expect(lines[2]).toContain("**AReorderUtil**");
  });

  it("sub-sorts alphabetically within same score tier", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    // Both score 0.8 (PascalCase boundary), alphabetical tiebreaker
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/ZetaOrder.cs": "namespace Lib;\npublic class ZetaOrder\n{\n}",
      "src/Lib/AlphaOrder.cs": "namespace Lib;\npublic class AlphaOrder\n{\n}",
    });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, "Lib", "Order");

    expect(result.isError).toBe(false);
    const lines = result.text.split("\n").filter((l: string) => l.startsWith("- **"));
    expect(lines[0]).toContain("**AlphaOrder**");
    expect(lines[1]).toContain("**ZetaOrder**");
  });

  it("cross-package: sorts within each package group by score", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    // Alpha: AReorderUtil (0.6 alphabetically first) and Order (1.0 alphabetically second)
    // Beta: AReorderHelper (0.6) and IOrder (0.8)
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/AReorderUtil.cs": "namespace Alpha;\npublic class AReorderUtil\n{\n}",
      "src/Alpha/Order.cs": "namespace Alpha;\npublic class Order\n{\n}",
      "src/Beta/AReorderHelper.cs": "namespace Beta;\npublic class AReorderHelper\n{\n}",
      "src/Beta/IOrder.cs": "namespace Beta;\npublic interface IOrder\n{\n}",
    });

    const alpha = makePkg("Alpha", "myrepo", "src", cacheDir);
    const beta = makePkg("Beta", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [alpha, beta], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digLookup(config, undefined, "Order");

    expect(result.isError).toBe(false);
    // Within Alpha: Order (exact 1.0) before AReorderUtil (substring 0.6)
    const alphaSection = result.text.split("## Beta")[0]!;
    const alphaLines = alphaSection.split("\n").filter((l: string) => l.startsWith("- **"));
    expect(alphaLines[0]).toContain("**Order**");
    expect(alphaLines[1]).toContain("**AReorderUtil**");

    // Within Beta: IOrder (boundary 0.8) before AReorderHelper (substring 0.6)
    const betaSection = result.text.split("## Beta")[1]!;
    const betaLines = betaSection.split("\n").filter((l: string) => l.startsWith("- **"));
    expect(betaLines[0]).toContain("**IOrder**");
    expect(betaLines[1]).toContain("**AReorderHelper**");
  });
});
