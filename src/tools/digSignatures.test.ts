import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isFresh,
  markFresh,
  readIndex,
  readSignatures,
  writeIndex,
  writeSignature,
} from "../cacheManager.js";
import * as sourceExtractor from "../sourceExtractor.js";
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

vi.mock("../sourceExtractor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sourceExtractor.js")>();
  return {
    ...actual,
    parseIndex: vi.fn(actual.parseIndex),
  };
});

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

// ── Summary block ──

describe("digSignatures — summary block", () => {
  it("shows summary blockquote for type match with method counts and key methods", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/OrderService.cs": [
        "namespace MyLib;",
        "public class OrderService",
        "{",
        "    public Task<Order> GetOrderAsync(int id) { return null; }",
        "    public int CreateOrder(Order order) { return 0; }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "OrderService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("> **OrderService** (class)");
    expect(result.text).toContain("Methods: 2");
    expect(result.text).toContain("Key:");
    expect(result.text).toContain("GetOrderAsync");
  });

  it("shows implements list from base types", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/OrderService.cs": [
        "namespace MyLib;",
        "public class OrderService : IOrderService, IDisposable",
        "{",
        "    public void Execute() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "OrderService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Implements: IOrderService, IDisposable");
  });

  it("counts protected methods separately from public", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/BaseService.cs": [
        "namespace MyLib;",
        "public abstract class BaseService",
        "{",
        "    public void Execute() { }",
        "    public Task<int> GetCountAsync() { return Task.FromResult(0); }",
        "    protected void Validate() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "BaseService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("2 public, 1 protected");
  });

  it("shows method count for interface (no access distinction)", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IOrderService.cs": [
        "namespace MyLib;",
        "public interface IOrderService",
        "{",
        "    Task<Order> GetOrderAsync(int id);",
        "    void CreateOrder(Order order);",
        "    void DeleteOrder(int id);",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "IOrderService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Methods: 3");
  });

  it("does not show summary for method-only match", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/OrderService.cs": [
        "namespace MyLib;",
        "public class OrderService",
        "{",
        "    public void UniqueMethodName() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "UniqueMethodName");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("OrderService.cs");
    // No blockquote summary for method-only matches
    const lines = result.text.split("\n");
    const summaryLines = lines.filter((l: string) => l.startsWith("> **"));
    expect(summaryLines.length).toBe(0);
  });

  it("excludes constructors from method count", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/OrderService.cs": [
        "namespace MyLib;",
        "public class OrderService",
        "{",
        "    public OrderService(int id) { }",
        "    public void Execute() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "OrderService");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Methods: 1");
    expect(result.text).not.toMatch(/Methods: 2/);
  });

  it("shows type info only for enum (no methods section)", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/OrderStatus.cs": [
        "namespace MyLib;",
        "public enum OrderStatus",
        "{",
        "    Pending,",
        "    Active,",
        "    Completed",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "OrderStatus");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("> **OrderStatus** (enum)");
    expect(result.text).not.toContain("Methods:");
    expect(result.text).not.toContain("Key:");
  });
});

// ── Result ranking ──

describe("digSignatures — result ranking", () => {
  it("ranks exact match above prefix above substring in file order", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    // Names chosen so alphabetical order (AReorderHelper, Order, ZOrderService)
    // differs from ranked order (Order=1.0, ZOrderService=0.8, AReorderHelper=0.6)
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/AReorderHelper.cs": [
        "namespace MyLib;",
        "public class AReorderHelper",
        "{",
        "    public void Do() { }",
        "}",
      ].join("\n"),
      "src/MyLib/Order.cs": [
        "namespace MyLib;",
        "public class Order",
        "{",
        "    public void Do() { }",
        "}",
      ].join("\n"),
      "src/MyLib/ZOrderService.cs": [
        "namespace MyLib;",
        "public class ZOrderService",
        "{",
        "    public void Do() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "Order");

    expect(result.isError).toBe(false);
    const headings = result.text.split("\n").filter((l: string) => l.startsWith("## "));
    expect(headings[0]).toContain("Order (class)");
    expect(headings[1]).toContain("ZOrderService (class)");
    expect(headings[2]).toContain("AReorderHelper (class)");
  });

  it("sub-sorts by file path within same score tier", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    // Both score 0.8 (PascalCase boundary on 'O'), file path tiebreaker
    // sigsCached comes path-sorted, so without ranking sort this would be
    // AlphaOrder, ZetaOrder (both same score). With ranking: same.
    // To test tiebreaker, use names where path order = expected order.
    // Key: verify deterministic path-based sub-sort is stable.
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/ZetaOrder.cs": [
        "namespace MyLib;",
        "public class ZetaOrder",
        "{",
        "    public void Do() { }",
        "}",
      ].join("\n"),
      "src/MyLib/AlphaOrder.cs": [
        "namespace MyLib;",
        "public class AlphaOrder",
        "{",
        "    public void Do() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "MyLib", "Order");

    expect(result.isError).toBe(false);
    const headings = result.text.split("\n").filter((l: string) => l.startsWith("## "));
    expect(headings[0]).toContain("AlphaOrder");
    expect(headings[1]).toContain("ZetaOrder");
  });

  it("ranks stale fallback results by score", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);

    await writeIndex(
      pkg,
      "Order|class|Order.cs\nOrderService|class|OrderService.cs\nReorderHelper|class|ReorderHelper.cs",
    );
    await writeSignature(pkg, "Order.cs", "class Order { }");
    await writeSignature(pkg, "OrderService.cs", "class OrderService { }");
    await writeSignature(pkg, "ReorderHelper.cs", "class ReorderHelper { }");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digSignatures(config, "StaleLib", "Order");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Warning");
    const headings = result.text.split("\n").filter((l: string) => l.startsWith("## "));
    expect(headings[0]).toContain("Order");
    expect(headings[0]).not.toContain("OrderService");
    expect(headings[1]).toContain("OrderService");
    expect(headings[2]).toContain("ReorderHelper");
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

// ── Stale-fallback defensive guards ──

describe("digSignatures — corrupt stale index", () => {
  let realParseIndex: typeof sourceExtractor.parseIndex;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../sourceExtractor.js")>(
      "../sourceExtractor.js",
    );
    realParseIndex = actual.parseIndex;
    vi.mocked(sourceExtractor.parseIndex).mockImplementation(realParseIndex);
  });

  afterEach(() => {
    vi.mocked(sourceExtractor.parseIndex).mockImplementation(realParseIndex);
  });

  it("returns tool error (no throw) when stale parseIndex throws", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("StaleLib", "gonerepo", "src", cacheDir);
    await writeIndex(pkg, "OldType|class|Old.cs");
    await writeSignature(pkg, "Old.cs", "// stale signature content");

    const repo = makeRepoConfig(
      {
        name: "gonerepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    vi.mocked(sourceExtractor.parseIndex).mockImplementationOnce(() => {
      throw new Error("corrupt index");
    });

    const result = await digSignatures(config, "StaleLib", "OldType");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Source unavailable");
  });
});
