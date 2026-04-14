import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackageConfig } from "./config.js";
import {
  extractOverview,
  extractSignatures,
  stripCsBody,
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

// ── stripCsBody ──

describe("stripCsBody", () => {
  it("strips multi-line method body", () => {
    const input = [
      "public class Foo",
      "{",
      "    public void DoWork()",
      "    {",
      "        var x = 1;",
      "        Console.WriteLine(x);",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public class Foo");
    expect(result).toContain("public void DoWork()");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("var x = 1");
    expect(result).not.toContain("Console.WriteLine");
  });

  it("strips single-line method body", () => {
    const input = [
      "public class Foo",
      "{",
      "    public int Get() { return 42; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public int Get() { /* ... */ }");
    expect(result).not.toContain("return 42");
  });

  it("preserves interface declarations (no bodies)", () => {
    const input = [
      "public interface IService",
      "{",
      "    void Execute(string cmd);",
      "    Task<bool> ValidateAsync(int id);",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toBe(input);
  });

  it("preserves enum values", () => {
    const input = [
      "public enum Status",
      "{",
      "    Active,",
      "    Inactive,",
      "    Deleted",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toBe(input);
  });

  it("preserves auto-properties", () => {
    const input = [
      "public class User",
      "{",
      "    public string Name { get; set; }",
      "    public int Age { get; private set; }",
      "    public string Id { get; init; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public string Name { get; set; }");
    expect(result).toContain("public int Age { get; private set; }");
    expect(result).toContain("public string Id { get; init; }");
  });

  it("strips property with body", () => {
    const input = [
      "public class Foo",
      "{",
      "    public int Count",
      "    {",
      "        get { return _items.Count; }",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public int Count");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("_items.Count");
  });

  it("strips constructor body", () => {
    const input = [
      "public class Service",
      "{",
      "    private readonly IRepo _repo;",
      "",
      "    public Service(IRepo repo)",
      "    {",
      "        _repo = repo;",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("private readonly IRepo _repo;");
    expect(result).toContain("public Service(IRepo repo)");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("_repo = repo");
  });

  it("preserves XML doc comments", () => {
    const input = [
      "public class Foo",
      "{",
      "    /// <summary>Does important work.</summary>",
      "    public void Work()",
      "    {",
      "        // implementation",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("/// <summary>Does important work.</summary>");
    expect(result).toContain("public void Work()");
    expect(result).not.toContain("// implementation");
  });

  it("preserves attributes", () => {
    const input = [
      "public class Foo",
      "{",
      "    [Obsolete]",
      "    [return: NotNull]",
      "    public string Get()",
      "    {",
      "        return \"\";",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("[Obsolete]");
    expect(result).toContain("[return: NotNull]");
    expect(result).toContain("public string Get()");
    expect(result).not.toContain('return ""');
  });

  it("handles nested classes", () => {
    const input = [
      "public class Outer",
      "{",
      "    public class Inner",
      "    {",
      "        public void Foo()",
      "        {",
      "            // body",
      "        }",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public class Outer");
    expect(result).toContain("public class Inner");
    expect(result).toContain("public void Foo()");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("// body");
    // Both closing braces for Outer and Inner should be preserved
    const closingBraces = result.match(/^\s*\}$/gm);
    expect(closingBraces?.length).toBe(2);
  });

  it("handles file-scoped namespace", () => {
    const input = [
      "namespace MyLib;",
      "",
      "public class Foo",
      "{",
      "    public void Bar() { return; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("namespace MyLib;");
    expect(result).toContain("public class Foo");
    expect(result).toContain("public void Bar() { /* ... */ }");
  });

  it("preserves using statements", () => {
    const input = [
      "using System;",
      "using System.Collections.Generic;",
      "",
      "namespace MyLib",
      "{",
      "    public class Foo { }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("using System;");
    expect(result).toContain("using System.Collections.Generic;");
  });

  it("preserves constants and static readonly fields", () => {
    const input = [
      "public class Config",
      "{",
      "    public const int MaxRetries = 3;",
      "    public static readonly string DefaultName = \"test\";",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public const int MaxRetries = 3;");
    expect(result).toContain(
      'public static readonly string DefaultName = "test";',
    );
  });

  it("preserves expression-bodied members", () => {
    const input = [
      "public class Foo",
      "{",
      "    public int Count => _items.Count;",
      "    public override string ToString() => Name;",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    // Expression-bodied members pass through as-is
    expect(result).toContain("public int Count => _items.Count;");
    expect(result).toContain("public override string ToString() => Name;");
  });

  it("ignores braces inside string literals", () => {
    const input = [
      "public class Foo",
      "{",
      '    public const string Template = "Hello {name}";',
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain('public const string Template = "Hello {name}";');
  });

  it("ignores braces inside comments", () => {
    const input = [
      "public class Foo",
      "{",
      "    // Use { and } for blocks",
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("// Use { and } for blocks");
    expect(result).toContain("public int X { get; set; }");
  });

  it("handles multi-line method signature", () => {
    const input = [
      "public class Foo",
      "{",
      "    public async Task<Result<User>> GetUser(",
      "        int userId,",
      "        CancellationToken ct)",
      "    {",
      "        return await _repo.Find(userId, ct);",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public async Task<Result<User>> GetUser(");
    expect(result).toContain("int userId,");
    expect(result).toContain("CancellationToken ct)");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("_repo.Find");
  });

  it("handles generic class with where clause", () => {
    const input = [
      "public class Repository<T>",
      "    where T : IEntity",
      "{",
      "    public T GetById(int id)",
      "    {",
      "        return default;",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public class Repository<T>");
    expect(result).toContain("where T : IEntity");
    expect(result).toContain("public T GetById(int id)");
    expect(result).toContain("{ /* ... */ }");
    expect(result).not.toContain("return default");
  });

  it("handles record types", () => {
    const input = [
      "public record UserDto(string Name, int Age);",
      "",
      "public record OrderDto(int Id)",
      "{",
      "    public string Status { get; init; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public record UserDto(string Name, int Age);");
    expect(result).toContain("public record OrderDto(int Id)");
    expect(result).toContain("public string Status { get; init; }");
  });

  it("handles block comment spanning multiple lines", () => {
    const input = [
      "public class Foo",
      "{",
      "    /* this is a",
      "       multi-line comment { with braces } */",
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("/* this is a");
    expect(result).toContain("multi-line comment { with braces } */");
    expect(result).toContain("public int X { get; set; }");
  });
});

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

// ── extractSignatures ──

describe("extractSignatures", () => {
  it("returns stripped .cs files with header", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": [
        "namespace MyLib;",
        "public class Service",
        "{",
        "    public void Run()",
        "    {",
        "        Console.WriteLine();",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123def456");

    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.filePath).toBe("Service.cs");
    expect(sigs[0]!.content).toContain(
      "// GENERATED — read only — MyLib @ commit abc123de",
    );
    expect(sigs[0]!.content).toContain("public class Service");
    expect(sigs[0]!.content).toContain("public void Run()");
    expect(sigs[0]!.content).toContain("{ /* ... */ }");
    expect(sigs[0]!.content).not.toContain("Console.WriteLine");
  });

  it("returns files sorted by path", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Z.cs": "namespace MyLib;\npublic class Z { }",
      "src/MyLib/A.cs": "namespace MyLib;\npublic class A { }",
      "src/MyLib/Sub/M.cs": "namespace MyLib.Sub;\npublic class M { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123");

    expect(sigs.map((s) => s.filePath)).toEqual([
      "A.cs",
      "Sub/M.cs",
      "Z.cs",
    ]);
  });

  it("excludes generated files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Real.cs": "namespace MyLib;\npublic class Real { }",
      "src/MyLib/Auto.g.cs": "// auto-generated",
      "src/MyLib/Model.Designer.cs": "// designer-generated",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123");

    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.filePath).toBe("Real.cs");
  });

  it("uses package-relative file paths", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/Entity.cs":
        "namespace MyLib.Domain;\npublic class Entity { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123");

    expect(sigs[0]!.filePath).toBe("Domain/Entity.cs");
  });

  it("preserves full interface in stripped output", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IRepo.cs": [
        "namespace MyLib;",
        "",
        "/// <summary>Repository pattern.</summary>",
        "public interface IRepo<T>",
        "{",
        "    T GetById(int id);",
        "    void Save(T entity);",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123");

    const content = sigs[0]!.content;
    expect(content).toContain("/// <summary>Repository pattern.</summary>");
    expect(content).toContain("public interface IRepo<T>");
    expect(content).toContain("T GetById(int id);");
    expect(content).toContain("void Save(T entity);");
  });

  it("returns empty array when no .cs files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "# MyLib",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg, "abc123");

    expect(sigs).toEqual([]);
  });
});
