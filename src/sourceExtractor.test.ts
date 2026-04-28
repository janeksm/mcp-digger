import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackageConfig } from "./config.js";
import {
  extractIndex,
  extractOverview,
  serializeIndex,
  parseIndex,
} from "./sourceExtractor.js";
import { initRepo } from "./testHelpers.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-digger-extract-test-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePkg(
  name: string,
  pathInRepo: string,
  repoName = "test",
): PackageConfig {
  return {
    name,
    repoName,
    pathInRepo,
    cachePath: path.join(tmpDir, "cache", name),
  };
}

// ── extractOverview ──

describe("extractOverview", () => {
  it("includes package name as header", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs":
        "namespace MyLib;\npublic class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123def456");

    expect(overview).toMatch(/^# MyLib\n/);
  });

  it("includes README content", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "# MyLib\n\nCore utilities for the platform.",
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("Core utilities for the platform.");
  });

  it("includes docs/*.md content", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/docs/patterns.md": "# Patterns\n\nUse Result<T> for errors.",
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("Use Result<T> for errors.");
  });

  it("lists interfaces with XML summaries", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "/// <summary>Core service contract.</summary>",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("## Key Interfaces");
    expect(overview).toContain("**IService** — Core service contract.");
  });

  it("lists abstract classes with XML summaries", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Entity.cs": [
        "namespace MyLib;",
        "/// <summary>Base entity class.</summary>",
        "public abstract class Entity<TId>",
        "{",
        "    public TId Id { get; set; }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("## Abstract Classes");
    expect(overview).toContain("**Entity<TId>** — Base entity class.");
  });

  it("extracts multi-line XML summary", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IRepo.cs": [
        "namespace MyLib;",
        "/// <summary>",
        "/// Generic repository for",
        "/// managing entities.",
        "/// </summary>",
        "public interface IRepo<T> { }",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain(
      "**IRepo<T>** — Generic repository for managing entities.",
    );
  });

  it("lists source files relative to package dir", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/User.cs": "namespace MyLib.Domain;\npublic class User { }",
      "src/MyLib/Services/Auth.cs":
        "namespace MyLib.Services;\npublic class Auth { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("## Source Files");
    expect(overview).toContain("- Domain/User.cs");
    expect(overview).toContain("- Services/Auth.cs");
  });

  it("excludes generated files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
      "src/MyLib/Class1.g.cs": "// generated",
      "src/MyLib/Model.generated.cs": "// generated",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("- Class1.cs");
    expect(overview).not.toContain("Class1.g.cs");
    expect(overview).not.toContain("Model.generated.cs");
  });

  it("handles package with no docs or types gracefully", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Helper.cs":
        "namespace MyLib;\npublic class Helper { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg, "abc123");

    expect(overview).toContain("# MyLib");
    expect(overview).toContain("- Helper.cs");
    expect(overview).not.toContain("## Key Interfaces");
    expect(overview).not.toContain("## Abstract Classes");
  });
});

// ── extractIndex ──

describe("extractIndex", () => {
  it("extracts class declarations", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": [
        "namespace MyLib;",
        "public class FooService",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    expect(entries).toContainEqual({
      symbol: "FooService",
      kind: "class",
      filePath: "Service.cs",
    });
  });

  it("extracts interfaces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    expect(entries).toContainEqual({
      symbol: "IService",
      kind: "interface",
      filePath: "IService.cs",
    });
  });

  it("extracts structs, enums, and records", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Types.cs": [
        "namespace MyLib;",
        "public struct Point { public int X; public int Y; }",
        "public enum Status { Active, Inactive }",
        "public record UserDto(string Name, int Age);",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toContain("Point");
    expect(symbols).toContain("Status");
    expect(symbols).toContain("UserDto");
    expect(entries.find((e) => e.symbol === "Point")!.kind).toBe("struct");
    expect(entries.find((e) => e.symbol === "Status")!.kind).toBe("enum");
    expect(entries.find((e) => e.symbol === "UserDto")!.kind).toBe("record");
  });

  it("extracts methods with parent type", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": [
        "namespace MyLib;",
        "public class OrderService",
        "{",
        "    public void CreateOrder(int id)",
        "    {",
        "        // body",
        "    }",
        "",
        "    public Task<Order> GetByIdAsync(int id)",
        "    {",
        "        return Task.FromResult(new Order());",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    const methods = entries.filter((e) => e.kind === "method");
    expect(methods).toContainEqual({
      symbol: "CreateOrder",
      kind: "method",
      parentType: "OrderService",
      filePath: "Service.cs",
    });
    expect(methods).toContainEqual({
      symbol: "GetByIdAsync",
      kind: "method",
      parentType: "OrderService",
      filePath: "Service.cs",
    });
  });

  it("excludes generated files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Real.cs": "namespace MyLib;\npublic class Real { }",
      "src/MyLib/Auto.g.cs": "namespace MyLib;\npublic class Auto { }",
      "src/MyLib/Model.Designer.cs": "namespace MyLib;\npublic class Model { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toContain("Real");
    expect(symbols).not.toContain("Auto");
    expect(symbols).not.toContain("Model");
  });

  it("returns empty array for no .cs files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "# MyLib",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    expect(entries).toEqual([]);
  });

  it("sorts entries by symbol name", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Z.cs": "namespace MyLib;\npublic class Zebra { }",
      "src/MyLib/A.cs": "namespace MyLib;\npublic class Alpha { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    expect(entries[0]!.symbol).toBe("Alpha");
    expect(entries[1]!.symbol).toBe("Zebra");
  });

  it("uses package-relative file paths", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/Entity.cs":
        "namespace MyLib.Domain;\npublic class Entity { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    expect(entries[0]!.filePath).toBe("Domain/Entity.cs");
  });

  it("handles nested types", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Outer.cs": [
        "namespace MyLib;",
        "public class Outer",
        "{",
        "    public class Inner",
        "    {",
        "        public void DoWork() { }",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const entries = await extractIndex(repoDir, pkg);

    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toContain("Outer");
    expect(symbols).toContain("Inner");
    const doWork = entries.find((e) => e.symbol === "DoWork");
    expect(doWork).toBeDefined();
    expect(doWork!.parentType).toBe("Inner");
  });
});

// ── serializeIndex / parseIndex ──

describe("serializeIndex / parseIndex", () => {
  it("round-trips type entries", () => {
    const entries = [
      { symbol: "FooService", kind: "class" as const, filePath: "Services/FooService.cs" },
      { symbol: "IFoo", kind: "interface" as const, filePath: "IFoo.cs" },
    ];

    const serialized = serializeIndex(entries);
    const parsed = parseIndex(serialized);

    expect(parsed).toEqual(entries);
  });

  it("round-trips method entries with parentType", () => {
    const entries = [
      { symbol: "GetById", kind: "method" as const, parentType: "FooService", filePath: "Services/FooService.cs" },
    ];

    const serialized = serializeIndex(entries);
    const parsed = parseIndex(serialized);

    expect(parsed).toEqual(entries);
  });

  it("returns empty array for empty string", () => {
    expect(parseIndex("")).toEqual([]);
    expect(parseIndex("  \n  ")).toEqual([]);
  });
});
