import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackageConfig } from "./config.js";
import {
  extractIndex,
  extractOverview,
  extractPackageSummary,
  extractSignatures,
  stripCsBody,
  cleanSignatureOutput,
  serializeIndex,
  parseIndex,
  formatEntryDisplay,
  countReferences,
  searchReferences,
  scoreSymbolMatch,
  computeRefCounts,
  type IndexEntry,
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
      '        return "";',
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
      '    public const int MaxRetries = 3;',
      '    public static readonly string DefaultName = "test";',
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

  it("handles verbatim string with backslash (not an escape)", () => {
    const input = [
      "public class Foo",
      "{",
      '    public const string Path = @"C:\\Users\\test\\";',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain('@"C:\\Users\\test\\"');
    expect(result).toContain("public int X { get; set; }");
  });

  it("handles multi-line verbatim string with braces", () => {
    const input = [
      "public class Foo",
      "{",
      "    public void Do()",
      "    {",
      '        var json = @"{',
      '            ""name"": ""test"",',
      '            ""items"": [{ ""id"": 1 }]',
      '        }";',
      "    }",
      "    public void Other()",
      "    {",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public void Do()");
    expect(result).toContain("{ /* ... */ }");
    expect(result).toContain("public void Other()");
    const closingBraces = result.match(/^\s*\}$/gm);
    expect(closingBraces?.length).toBe(1);
  });

  it("handles interpolated verbatim string $@\"...\"", () => {
    const input = [
      "public class Foo",
      "{",
      '    public string Get(string name) { return $@"Hello {name}, path=C:\\Users\\"; }',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public string Get(string name) { /* ... */ }");
    expect(result).toContain("public int X { get; set; }");
  });

  it("handles verbatim string with escaped quotes (\"\")", () => {
    const input = [
      "public class Foo",
      "{",
      '    public const string S = @"say ""hello"" to {world}";',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain('@"say ""hello"" to {world}"');
    expect(result).toContain("public int X { get; set; }");
  });

  it("ignores braces inside single-line raw string literal", () => {
    const input = [
      "public class Foo",
      "{",
      '    public const string Json = """{"name": "test"}""";',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain('"""{"name": "test"}"""');
    expect(result).toContain("public int X { get; set; }");
  });

  it("ignores braces inside multi-line raw string literal", () => {
    const input = [
      "public class Foo",
      "{",
      "    public void Do()",
      "    {",
      '        var json = """',
      '            {',
      '                "name": "test",',
      '                "items": [{ "id": 1 }]',
      "            }",
      '            """;',
      "    }",
      "    public void Other()",
      "    {",
      "    }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public void Do()");
    expect(result).toContain("{ /* ... */ }");
    expect(result).toContain("public void Other()");
    const closingBraces = result.match(/^\s*\}$/gm);
    expect(closingBraces?.length).toBe(1);
  });

  it("handles raw string with 4+ quote delimiters", () => {
    const input = [
      "public class Foo",
      "{",
      '    public const string S = """"contains """ inside"""";',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public int X { get; set; }");
  });

  it("handles interpolated raw string $\"\"\"...\"\"\"", () => {
    const input = [
      "public class Foo",
      "{",
      '    public string Get(string name) { return $"""{name} has {count} items"""; }',
      "    public int X { get; set; }",
      "}",
    ].join("\n");

    const result = stripCsBody(input);

    expect(result).toContain("public string Get(string name) { /* ... */ }");
    expect(result).toContain("public int X { get; set; }");
  });
});

// ── cleanSignatureOutput ──

describe("cleanSignatureOutput", () => {
  it("strips XML doc comments", () => {
    const input = [
      "class Foo",
      "{",
      "    /// <summary>Does work.</summary>",
      "    void Run() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("///");
    expect(result).toContain("void Run() { /* ... */ }");
  });

  it("strips private fields", () => {
    const input = [
      "class Foo",
      "{",
      "    private readonly IRepo _repo;",
      "    string Name { get; set; }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("private readonly IRepo _repo;");
    expect(result).toContain("string Name { get; set; }");
  });

  it("strips single-line private methods", () => {
    const input = [
      "class Foo",
      "{",
      "    private void Internal() { /* ... */ }",
      "    void Public() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("private void Internal()");
    expect(result).toContain("void Public() { /* ... */ }");
  });

  it("strips multi-line private methods", () => {
    const input = [
      "class Foo",
      "{",
      "    private async Task<Result> ProcessAsync(",
      "        int id,",
      "        CancellationToken ct)",
      "    { /* ... */ }",
      "    void Public() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("private async Task<Result>");
    expect(result).not.toContain("int id,");
    expect(result).toContain("void Public() { /* ... */ }");
  });

  it("preserves private in auto-properties", () => {
    const input = [
      "class Foo",
      "{",
      "    string Name { get; private set; }",
      "    int Age { get; init; }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).toContain("string Name { get; private set; }");
    expect(result).toContain("int Age { get; init; }");
  });

  it("strips private auto-properties as single line", () => {
    const input = [
      "class Foo",
      "{",
      "    private string Secret { get; set; }",
      "    string Name { get; set; }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("Secret");
    expect(result).toContain("string Name { get; set; }");
  });

  it("strips boilerplate Equals", () => {
    const input = [
      "class Foo",
      "{",
      "    override bool Equals(object? obj) { /* ... */ }",
      "    void Run() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("Equals");
    expect(result).toContain("void Run()");
  });

  it("strips boilerplate GetHashCode", () => {
    const input = [
      "class Foo",
      "{",
      "    override int GetHashCode() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("GetHashCode");
  });

  it("strips boilerplate ToString", () => {
    const input = [
      "class Foo",
      "{",
      "    override string ToString() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("ToString");
  });

  it("strips operator overloads", () => {
    const input = [
      "class Foo",
      "{",
      "    static Foo operator +(Foo a, Foo b) { /* ... */ }",
      "    void Run() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("operator");
    expect(result).toContain("void Run()");
  });

  it("strips public keyword from declarations", () => {
    const input = [
      "public class Foo",
      "{",
      "    public void Run() { /* ... */ }",
      "    public string Name { get; set; }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).toContain("class Foo");
    expect(result).toContain("void Run() { /* ... */ }");
    expect(result).toContain("string Name { get; set; }");
    expect(result).not.toMatch(/\bpublic\b/);
  });

  it("preserves internal and protected keywords", () => {
    const input = [
      "internal class Bar",
      "{",
      "    protected void Do() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).toContain("internal class Bar");
    expect(result).toContain("protected void Do()");
  });

  it("collapses consecutive blank lines", () => {
    const input = [
      "class Foo",
      "{",
      "",
      "",
      "",
      "    void Run() { /* ... */ }",
      "}",
    ].join("\n");

    const result = cleanSignatureOutput(input);

    expect(result).not.toContain("\n\n\n");
    expect(result).toContain("class Foo");
    expect(result).toContain("void Run()");
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

    const overview = await extractOverview(repoDir, pkg);

    expect(overview).toMatch(/^# MyLib\n/);
  });

  it("includes README content", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "# MyLib\n\nCore utilities for the platform.",
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg);

    expect(overview).toContain("Core utilities for the platform.");
  });

  it("includes docs/*.md content", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/docs/patterns.md": "# Patterns\n\nUse Result<T> for errors.",
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg);

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

    const overview = await extractOverview(repoDir, pkg);

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

    const overview = await extractOverview(repoDir, pkg);

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

    const overview = await extractOverview(repoDir, pkg);

    expect(overview).toContain(
      "**IRepo<T>** — Generic repository for managing entities.",
    );
  });

  it("does not include source file listing", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/User.cs": "namespace MyLib.Domain;\npublic class User { }",
      "src/MyLib/Services/Auth.cs":
        "namespace MyLib.Services;\npublic class Auth { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg);

    expect(overview).not.toContain("## Source Files");
    expect(overview).not.toContain("Domain/User.cs");
  });

  it("handles package with no docs or types gracefully", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Helper.cs":
        "namespace MyLib;\npublic class Helper { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const overview = await extractOverview(repoDir, pkg);

    expect(overview).toContain("# MyLib");
    expect(overview).not.toContain("## Source Files");
    expect(overview).not.toContain("## Key Interfaces");
    expect(overview).not.toContain("## Abstract Classes");
  });
});

// ── extractSignatures ──

describe("extractSignatures", () => {
  it("returns stripped .cs files without header or namespace", async () => {
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

    const sigs = await extractSignatures(repoDir, pkg);

    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.filePath).toBe("Service.cs");
    expect(sigs[0]!.content).not.toContain("GENERATED");
    expect(sigs[0]!.content).not.toContain("namespace");
    expect(sigs[0]!.content).toContain("class Service");
    expect(sigs[0]!.content).not.toContain("public class");
    expect(sigs[0]!.content).toContain("void Run()");
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

    const sigs = await extractSignatures(repoDir, pkg);

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

    const sigs = await extractSignatures(repoDir, pkg);

    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.filePath).toBe("Real.cs");
  });

  it("uses package-relative file paths", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/Entity.cs":
        "namespace MyLib.Domain;\npublic class Entity { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg);

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

    const sigs = await extractSignatures(repoDir, pkg);

    const content = sigs[0]!.content;
    expect(content).not.toContain("///");
    expect(content).toContain("interface IRepo<T>");
    expect(content).not.toContain("public interface");
    expect(content).toContain("T GetById(int id);");
    expect(content).toContain("void Save(T entity);");
  });

  it("returns empty array when no .cs files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "# MyLib",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const sigs = await extractSignatures(repoDir, pkg);

    expect(sigs).toEqual([]);
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

// ── extractPackageSummary ──

describe("extractPackageSummary", () => {
  it("returns PackageDescription from .csproj", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <PackageDescription>Data change auditation</PackageDescription>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const summary = await extractPackageSummary(repoDir, pkg);

    expect(summary).toBe("Data change auditation");
  });

  it("appends PackageTags when present", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <PackageDescription>Data change auditation</PackageDescription>",
        "    <PackageTags>audit</PackageTags>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const summary = await extractPackageSummary(repoDir, pkg);

    expect(summary).toBe("Data change auditation (tags: audit)");
  });

  it("returns tags-only when no description", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <PackageTags>core;domain</PackageTags>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const summary = await extractPackageSummary(repoDir, pkg);

    expect(summary).toBe("(tags: core;domain)");
  });

  it("returns undefined when .csproj has neither description nor tags", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <TargetFramework>net8.0</TargetFramework>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const summary = await extractPackageSummary(repoDir, pkg);

    expect(summary).toBeUndefined();
  });

  it("returns undefined when no .csproj in package dir", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });
    const pkg = makePkg("MyLib", "src/MyLib");

    const summary = await extractPackageSummary(repoDir, pkg);

    expect(summary).toBeUndefined();
  });
});

// ── Base type extraction in index ──

describe("extractIndex — baseTypes", () => {
  it("captures single base class", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Foo.cs": "namespace Lib;\npublic class Foo : Bar\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const foo = entries.find((e) => e.symbol === "Foo");
    expect(foo?.baseTypes).toEqual(["Bar"]);
  });

  it("captures multiple interfaces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Svc.cs": "namespace Lib;\npublic class Svc : IFoo, IBar\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const svc = entries.find((e) => e.symbol === "Svc");
    expect(svc?.baseTypes).toEqual(["IFoo", "IBar"]);
  });

  it("strips generic parameters from base types", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Repo.cs": "namespace Lib;\npublic class Repo<T> : IRepo<T>, IDisposable\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const repo = entries.find((e) => e.symbol === "Repo");
    expect(repo?.baseTypes).toEqual(["IRepo", "IDisposable"]);
  });

  it("handles nested generics", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/H.cs": "namespace Lib;\npublic class H : IHandler<Result<User>>\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const h = entries.find((e) => e.symbol === "H");
    expect(h?.baseTypes).toEqual(["IHandler"]);
  });

  it("strips where clause", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/R.cs": "namespace Lib;\npublic class R<T> : IRepo<T> where T : class\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const r = entries.find((e) => e.symbol === "R");
    expect(r?.baseTypes).toEqual(["IRepo"]);
  });

  it("handles record with constructor and inheritance", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Dto.cs": "namespace Lib;\npublic record Dto(int Id) : IDto;",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const dto = entries.find((e) => e.symbol === "Dto");
    expect(dto?.baseTypes).toEqual(["IDto"]);
  });

  it("returns no baseTypes for class without inheritance", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Plain.cs": "namespace Lib;\npublic class Plain\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const plain = entries.find((e) => e.symbol === "Plain");
    expect(plain?.baseTypes).toBeUndefined();
  });

  it("handles interface extending interface", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IExt.cs": "namespace Lib;\npublic interface IExt : IBase\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const ext = entries.find((e) => e.symbol === "IExt");
    expect(ext?.baseTypes).toEqual(["IBase"]);
  });

  it("handles multi-line inheritance (Allman style)", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Multi.cs": [
        "namespace Lib;",
        "public class Multi",
        "    : IFoo,",
        "      IBar",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const multi = entries.find((e) => e.symbol === "Multi");
    expect(multi?.baseTypes).toEqual(["IFoo", "IBar"]);
  });

  it("handles K&R style with base types on same line as brace", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Inline.cs": "namespace Lib;\npublic class Inline : IFoo {",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const inline = entries.find((e) => e.symbol === "Inline");
    expect(inline?.baseTypes).toEqual(["IFoo"]);
  });

  it("handles stray > in declaration without going negative on angle depth", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Stray.cs": "namespace Lib;\npublic class Stray> : IBase\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const stray = entries.find((e) => e.symbol === "Stray");
    expect(stray?.baseTypes).toEqual(["IBase"]);
  });

  it("handles stray > in base type list without losing subsequent types", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Multi.cs": "namespace Lib;\npublic class Multi : IFoo>, IBar\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const multi = entries.find((e) => e.symbol === "Multi");
    expect(multi?.baseTypes).toContain("IBar");
  });

  it("handles stray ) in declaration without going negative on paren depth", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Paren.cs": "namespace Lib;\npublic class Paren) : IFoo\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const paren = entries.find((e) => e.symbol === "Paren");
    expect(paren?.baseTypes).toEqual(["IFoo"]);
  });
});

// ── extractIndex — generics and modifiers ──

describe("extractIndex — generics and modifiers", () => {
  it("captures generics on a class", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Repo.cs": "namespace Lib;\npublic class Repo<T>\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const repo = entries.find((e) => e.symbol === "Repo");
    expect(repo?.generics).toBe("<T>");
    expect(repo?.modifiers).toBeUndefined();
  });

  it("captures generics on an interface", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IHandler.cs": "namespace Lib;\npublic interface IHandler<TRequest, TResponse>\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const handler = entries.find((e) => e.symbol === "IHandler");
    expect(handler?.generics).toBe("<TRequest, TResponse>");
  });

  it("captures abstract modifier", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Entity.cs": "namespace Lib;\npublic abstract class Entity<TId>\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const entity = entries.find((e) => e.symbol === "Entity");
    expect(entity?.generics).toBe("<TId>");
    expect(entity?.modifiers).toBe("abstract");
  });

  it("captures sealed modifier", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Config.cs": "namespace Lib;\npublic sealed class Config\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const config = entries.find((e) => e.symbol === "Config");
    expect(config?.generics).toBeUndefined();
    expect(config?.modifiers).toBe("sealed");
  });

  it("captures static modifier", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Extensions.cs": "namespace Lib;\npublic static class Extensions\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const ext = entries.find((e) => e.symbol === "Extensions");
    expect(ext?.modifiers).toBe("static");
  });

  it("captures nested generics", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Wrapper.cs": "namespace Lib;\npublic class Wrapper<Result<T>>\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const wrapper = entries.find((e) => e.symbol === "Wrapper");
    expect(wrapper?.generics).toBe("<Result<T>>");
  });

  it("does not add modifiers when none present", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Plain.cs": "namespace Lib;\npublic class Plain\n{\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const plain = entries.find((e) => e.symbol === "Plain");
    expect(plain?.generics).toBeUndefined();
    expect(plain?.modifiers).toBeUndefined();
  });
});

// ── Lexer-aware brace counting & block comment tracking ──

describe("extractIndex — brace counting skips strings/chars/comments", () => {
  it("ignores braces inside interpolated strings", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Logger.cs": [
        "namespace Lib;",
        "public class Logger",
        "{",
        "    public void Log(string name)",
        "    {",
        '        Console.WriteLine($"Hello {name}, welcome to {\\"world\\"}");',
        "    }",
        "    public void Other()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    const log = entries.find((e) => e.symbol === "Log");
    const other = entries.find((e) => e.symbol === "Other");
    expect(log?.parentType).toBe("Logger");
    expect(other?.parentType).toBe("Logger");
  });

  it("ignores braces inside char literals", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Parser.cs": [
        "namespace Lib;",
        "public class Parser",
        "{",
        "    public void Parse()",
        "    {",
        "        char open = '{';",
        "        char close = '}';",
        "    }",
        "    public void Next()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Parse")?.parentType).toBe("Parser");
    expect(entries.find((e) => e.symbol === "Next")?.parentType).toBe("Parser");
  });

  it("skips type declarations inside multi-line block comments", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Real.cs": [
        "namespace Lib;",
        "/*",
        "public class FakeClass",
        "{",
        "    public void FakeMethod() { }",
        "}",
        "*/",
        "public class RealClass",
        "{",
        "    public void RealMethod() { }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "FakeClass")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "FakeMethod")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "RealClass")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "RealMethod")?.parentType).toBe("RealClass");
  });

  it("handles block comment starting mid-line with Allman braces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Service.cs": [
        "namespace Lib;",
        "public class Service /* this is a comment",
        "   that spans multiple lines */",
        "{",
        "    public void DoWork()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Service")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "DoWork")?.parentType).toBe("Service");
  });

  it("ignores braces inside inline block comments", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Handler.cs": [
        "namespace Lib;",
        "public class Handler",
        "{",
        "    public void Process() /* { not a real brace } */",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Handler")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Process")?.parentType).toBe("Handler");
  });

  it("does not index declarations inside single-line block comments", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Commented.cs": [
        "namespace Lib;",
        "/* public class Fake { public void Hidden() { } } */",
        "public class Real",
        "{",
        "    public void Visible() { }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Fake")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Hidden")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Real")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Visible")?.parentType).toBe("Real");
  });

  it("does not index declarations inside multi-line verbatim strings", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Template.cs": [
        "namespace Lib;",
        "public class Template",
        "{",
        "    public string Get()",
        "    {",
        '        var sample = @"',
        "public class Fake",
        "{",
        "    public void Hidden() { }",
        "}",
        '";',
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Fake")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Hidden")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Template")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Get")?.parentType).toBe("Template");
  });

  it("ignores braces inside multi-line verbatim strings", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Template.cs": [
        "namespace Lib;",
        "public class Template",
        "{",
        "    public string Get()",
        "    {",
        '        var json = @"{',
        '            ""key"": ""value""',
        '        }";',
        "    }",
        "    public void After()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Get")?.parentType).toBe("Template");
    expect(entries.find((e) => e.symbol === "After")?.parentType).toBe("Template");
  });

  it("does not index declarations inside multi-line raw string literals", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Template.cs": [
        "namespace Lib;",
        "public class Template",
        "{",
        "    public string Get()",
        "    {",
        '        var sample = """',
        "public class Fake",
        "{",
        "    public void Hidden() { }",
        "}",
        '""";',
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Fake")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Hidden")).toBeUndefined();
    expect(entries.find((e) => e.symbol === "Template")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Get")?.parentType).toBe("Template");
  });

  it("ignores braces inside multi-line raw string literals", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Template.cs": [
        "namespace Lib;",
        "public class Template",
        "{",
        "    public string Get()",
        "    {",
        '        var json = """',
        "            {",
        '                "key": "value"',
        "            }",
        '            """;',
        "    }",
        "    public void After()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Get")?.parentType).toBe("Template");
    expect(entries.find((e) => e.symbol === "After")?.parentType).toBe("Template");
  });

  it("handles raw string with 4+ quote delimiters in index", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Raw.cs": [
        "namespace Lib;",
        "public class Raw",
        "{",
        "    public void Do()",
        "    {",
        '        var s = """"',
        '            contains """ inside',
        '            """";',
        "    }",
        "    public void After()",
        "    {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Do")?.parentType).toBe("Raw");
    expect(entries.find((e) => e.symbol === "After")?.parentType).toBe("Raw");
  });

  it("ignores base type syntax inside inline block comments", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Inherited.cs": [
        "namespace Lib;",
        "public class Real /* : IFake */ : IReal",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Real")?.baseTypes).toEqual(["IReal"]);
  });

  it("strips block comment spanning forward-looking lines before parsing base types", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Span.cs": [
        "namespace Lib;",
        "public class Span /* start",
        "  end */ : IReal",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Span")?.baseTypes).toEqual(["IReal"]);
  });

  it("clears pendingType after multi-line block comment", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Stale.cs": [
        "namespace Lib;",
        "public class Outer",
        "{",
        "    public record Stale(int X);",
        "    /*",
        "     * Documentation block",
        "     */",
        "    public void Method() {",
        "    }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Stale")?.kind).toBe("record");
    expect(entries.find((e) => e.symbol === "Method")?.parentType).toBe("Outer");
  });

  it("pendingType preserved across single-line block comment", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Allman.cs": [
        "namespace Lib;",
        "public class Allman",
        "/* single-line block comment */",
        "{",
        "    public void Work() { }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Allman")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Work")?.parentType).toBe("Allman");
  });

  it("pendingType consumed when brace on comment-closing line", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Combo.cs": [
        "namespace Lib;",
        "public class Combo /* multi-line",
        "   comment */ {",
        "    public void Inside() { }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Combo")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Inside")?.parentType).toBe("Combo");
  });

  it("pendingType preserved across separate block comment before brace", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Separate.cs": [
        "namespace Lib;",
        "public class Separate",
        "/*",
        " * block comment between type and brace",
        " */",
        "{",
        "    public void Work() { }",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Separate")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Work")?.parentType).toBe("Separate");
  });

  it("parses base types when primary-ctor default is a raw string containing braces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Configured.cs": [
        "namespace Lib;",
        'public class Configured(string Json = """{"a":1}""") : IConfig',
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Configured")?.baseTypes).toEqual(["IConfig"]);
  });

  it("parses base types when primary-ctor default is a verbatim string containing braces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Configured.cs": [
        "namespace Lib;",
        'public class Configured(string Json = @"{ a }") : IConfig',
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Configured")?.baseTypes).toEqual(["IConfig"]);
  });

  it("parses base types when primary-ctor default is a regular string containing braces", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Configured.cs": [
        "namespace Lib;",
        'public class Configured(string Json = "{a}") : IConfig',
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Configured")?.baseTypes).toEqual(["IConfig"]);
  });

  it("forward scan does not join lines that started inside a verbatim string", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Foo.cs": [
        "namespace Lib;",
        "public class Foo(string Path = @\"C:\\some\\path\")",
        "    : IFoo",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Foo")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Foo")?.baseTypes).toEqual(["IFoo"]);
  });

  it("forward scan tracks raw-string state across continuation lines", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Raw.cs": [
        "namespace Lib;",
        'public class Raw(string Json = """',
        "    { inside }",
        '    """) : IRaw',
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Raw")?.kind).toBe("class");
    expect(entries.find((e) => e.symbol === "Raw")?.baseTypes).toEqual(["IRaw"]);
    expect(entries.find((e) => e.symbol === "inside")).toBeUndefined();
  });

  it("strips line comments from base type clause", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Commented.cs": [
        "namespace Lib;",
        "public class Commented : IReal // : IFake",
        "{",
        "}",
      ].join("\n"),
    });
    const pkg = makePkg("Lib", "src/Lib");
    const entries = await extractIndex(repoDir, pkg);
    expect(entries.find((e) => e.symbol === "Commented")?.baseTypes).toEqual(["IReal"]);
  });
});

// ── Serialization with baseTypes ──

describe("serializeIndex / parseIndex — baseTypes", () => {
  it("round-trips entries with baseTypes", () => {
    const entries = [
      { symbol: "Foo", kind: "class" as const, filePath: "Foo.cs", baseTypes: ["IBar", "IBaz"] },
      { symbol: "Bar", kind: "interface" as const, filePath: "Bar.cs" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]?.baseTypes).toEqual(["IBar", "IBaz"]);
    expect(parsed[1]?.baseTypes).toBeUndefined();
  });

  it("parses old format (3-field) as no baseTypes", () => {
    const raw = "Foo|class|Foo.cs\nBar|interface|Bar.cs";
    const parsed = parseIndex(raw);
    expect(parsed[0]?.baseTypes).toBeUndefined();
    expect(parsed[1]?.baseTypes).toBeUndefined();
  });

  it("handles mixed entries (types with/without baseTypes and methods)", () => {
    const entries = [
      { symbol: "Svc", kind: "class" as const, filePath: "Svc.cs", baseTypes: ["ISvc"] },
      { symbol: "Plain", kind: "class" as const, filePath: "Plain.cs" },
      { symbol: "Run", kind: "method" as const, parentType: "Svc", filePath: "Svc.cs" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.baseTypes).toEqual(["ISvc"]);
    expect(parsed[1]?.baseTypes).toBeUndefined();
    expect(parsed[2]?.kind).toBe("method");
    expect(parsed[2]?.parentType).toBe("Svc");
  });
});

// ── Serialization with generics and modifiers ──

describe("serializeIndex / parseIndex — generics and modifiers", () => {
  it("round-trips entries with generics and modifiers", () => {
    const entries = [
      { symbol: "Entity", kind: "class" as const, filePath: "Entity.cs", baseTypes: ["IEntity"], generics: "<TId>", modifiers: "abstract" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]?.generics).toBe("<TId>");
    expect(parsed[0]?.modifiers).toBe("abstract");
    expect(parsed[0]?.baseTypes).toEqual(["IEntity"]);
  });

  it("round-trips entries with generics only", () => {
    const entries = [
      { symbol: "Repo", kind: "class" as const, filePath: "Repo.cs", generics: "<T>" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]?.generics).toBe("<T>");
    expect(parsed[0]?.modifiers).toBeUndefined();
    expect(parsed[0]?.baseTypes).toBeUndefined();
  });

  it("round-trips entries with modifiers only", () => {
    const entries = [
      { symbol: "Config", kind: "class" as const, filePath: "Config.cs", modifiers: "sealed" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]?.modifiers).toBe("sealed");
    expect(parsed[0]?.generics).toBeUndefined();
  });

  it("old format (3-4 fields) parses without generics or modifiers", () => {
    const raw = "Foo|class|Foo.cs\nBar|class|Bar.cs|IBar";
    const parsed = parseIndex(raw);
    expect(parsed[0]?.generics).toBeUndefined();
    expect(parsed[0]?.modifiers).toBeUndefined();
    expect(parsed[1]?.baseTypes).toEqual(["IBar"]);
    expect(parsed[1]?.generics).toBeUndefined();
    expect(parsed[1]?.modifiers).toBeUndefined();
  });

  it("handles mixed entries with and without generics/modifiers", () => {
    const entries = [
      { symbol: "Entity", kind: "class" as const, filePath: "Entity.cs", generics: "<TId>", modifiers: "abstract" },
      { symbol: "Plain", kind: "class" as const, filePath: "Plain.cs" },
      { symbol: "Run", kind: "method" as const, parentType: "Entity", filePath: "Entity.cs" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]?.generics).toBe("<TId>");
    expect(parsed[0]?.modifiers).toBe("abstract");
    expect(parsed[1]?.generics).toBeUndefined();
    expect(parsed[1]?.modifiers).toBeUndefined();
    expect(parsed[2]?.kind).toBe("method");
  });
});

// ── formatEntryDisplay ──

describe("formatEntryDisplay", () => {
  it("formats type with generics and modifiers", () => {
    const { displayName, kindLabel } = formatEntryDisplay({
      symbol: "Entity", kind: "class", filePath: "Entity.cs", generics: "<TId>", modifiers: "abstract",
    });
    expect(displayName).toBe("Entity<TId>");
    expect(kindLabel).toBe("abstract class");
  });

  it("formats type without generics or modifiers", () => {
    const { displayName, kindLabel } = formatEntryDisplay({
      symbol: "Config", kind: "class", filePath: "Config.cs",
    });
    expect(displayName).toBe("Config");
    expect(kindLabel).toBe("class");
  });

  it("formats interface with generics", () => {
    const { displayName, kindLabel } = formatEntryDisplay({
      symbol: "IHandler", kind: "interface", filePath: "IHandler.cs", generics: "<TReq, TRes>",
    });
    expect(displayName).toBe("IHandler<TReq, TRes>");
    expect(kindLabel).toBe("interface");
  });
});

// ── countReferences ──

describe("countReferences", () => {
  it("counts word-boundary matches", () => {
    const source = "IFoo foo = new FooImpl(); IFoo bar;";
    expect(countReferences(source, "IFoo")).toBe(2);
  });

  it("does not match substrings", () => {
    const source = "IFooFactory factory = new IFooFactory();";
    expect(countReferences(source, "IFoo")).toBe(0);
  });

  it("matches before generic brackets", () => {
    const source = "List<IFoo> items; IFoo<T> other;";
    expect(countReferences(source, "IFoo")).toBe(2);
  });

  it("is case-sensitive", () => {
    const source = "IFoo foo; ifoo bar; IFOO baz;";
    expect(countReferences(source, "IFoo")).toBe(1);
  });

  it("returns zero for empty source", () => {
    expect(countReferences("", "IFoo")).toBe(0);
  });

  it("escapes regex special characters in keyword", () => {
    const source = "System.String x; System.String y; SystemXString z;";
    expect(countReferences(source, "System.String")).toBe(2);
  });
});

// ── searchReferences ──

describe("searchReferences", () => {
  it("finds files referencing a type", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/IService.cs": "namespace Lib;\npublic interface IService\n{\n    void Run();\n}",
      "src/Lib/Impl.cs": "namespace Lib;\npublic class Impl : IService\n{\n    public void Run() { }\n}",
      "src/Lib/Other.cs": "namespace Lib;\npublic class Other\n{\n    public void Noop() { }\n}",
    });
    const pkg = makePkg("Lib", "src/Lib");

    const refs = await searchReferences(repoDir, pkg, "IService");

    expect(refs.length).toBe(2);
    expect(refs.some((r) => r.filePath === "IService.cs")).toBe(true);
    expect(refs.some((r) => r.filePath === "Impl.cs")).toBe(true);
    expect(refs.some((r) => r.filePath === "Other.cs")).toBe(false);
  });

  it("respects maxFiles cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`src/Lib/File${i}.cs`] = `namespace Lib;\npublic class File${i} : ITarget\n{\n}`;
    }
    const repoDir = await initRepo(tmpDir, files);
    const pkg = makePkg("Lib", "src/Lib");

    const refs = await searchReferences(repoDir, pkg, "ITarget", 3);

    expect(refs.length).toBe(3);
  });

  it("reports occurrence count per file and sorts descending", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Heavy.cs": "IFoo a; IFoo b; IFoo c;",
      "src/Lib/Light.cs": "IFoo x;",
      "src/Lib/Medium.cs": "IFoo m; IFoo n;",
    });
    const pkg = makePkg("Lib", "src/Lib");

    const refs = await searchReferences(repoDir, pkg, "IFoo");

    expect(refs).toEqual([
      { filePath: "Heavy.cs", count: 3 },
      { filePath: "Medium.cs", count: 2 },
      { filePath: "Light.cs", count: 1 },
    ]);
  });

  it("skips files that fail to read", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Good.cs": "IFoo x;",
      "src/Lib/Broken.cs": "IFoo y;",
    });
    const pkg = makePkg("Lib", "src/Lib");

    const blobHash = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD:src/Lib/Broken.cs"], { encoding: "utf8" }).trim();
    const objPath = path.join(repoDir, ".git", "objects", blobHash.slice(0, 2), blobHash.slice(2));
    fs.unlinkSync(objPath);

    const refs = await searchReferences(repoDir, pkg, "IFoo");

    expect(refs).toEqual([{ filePath: "Good.cs", count: 1 }]);
  });

  it("excludes generated files", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Real.cs": "IFoo x;",
      "src/Lib/Auto.g.cs": "IFoo y;",
      "src/Lib/Auto.generated.cs": "IFoo z;",
      "src/Lib/Form.Designer.cs": "IFoo w;",
    });
    const pkg = makePkg("Lib", "src/Lib");

    const refs = await searchReferences(repoDir, pkg, "IFoo");

    expect(refs).toEqual([{ filePath: "Real.cs", count: 1 }]);
  });
});

// ── scoreSymbolMatch ──

describe("scoreSymbolMatch", () => {
  it("returns 1.0 for exact case-insensitive match", () => {
    expect(scoreSymbolMatch("OrderService", "OrderService")).toBe(1.0);
    expect(scoreSymbolMatch("OrderService", "orderservice")).toBe(1.0);
    expect(scoreSymbolMatch("OrderService", "ORDERSERVICE")).toBe(1.0);
  });

  it("returns 0.8 for prefix match", () => {
    expect(scoreSymbolMatch("OrderService", "Order")).toBe(0.8);
    expect(scoreSymbolMatch("OrderService", "order")).toBe(0.8);
  });

  it("returns 0.8 for PascalCase boundary match", () => {
    expect(scoreSymbolMatch("IOrderService", "Order")).toBe(0.8);
    expect(scoreSymbolMatch("MyOrderService", "Order")).toBe(0.8);
    expect(scoreSymbolMatch("IOrderService", "Service")).toBe(0.8);
  });

  it("returns 0.6 for non-boundary substring match", () => {
    expect(scoreSymbolMatch("ReorderHelper", "order")).toBe(0.6);
    expect(scoreSymbolMatch("Recorder", "eco")).toBe(0.6);
  });

  it("returns 0 for no match", () => {
    expect(scoreSymbolMatch("OrderService", "Customer")).toBe(0);
    expect(scoreSymbolMatch("Foo", "FooBar")).toBe(0);
  });

  it("returns 0 for empty keyword", () => {
    expect(scoreSymbolMatch("OrderService", "")).toBe(0);
  });

  it("returns 0 for keyword longer than symbol", () => {
    expect(scoreSymbolMatch("A", "ABC")).toBe(0);
  });

  it("handles single-character keyword", () => {
    expect(scoreSymbolMatch("A", "a")).toBe(1.0);
    expect(scoreSymbolMatch("IService", "I")).toBe(0.8);
  });

  it("handles uppercase interior as boundary", () => {
    expect(scoreSymbolMatch("XMLParser", "Parser")).toBe(0.8);
    expect(scoreSymbolMatch("V2Order", "Order")).toBe(0.8);
  });
});

// ── computeRefCounts ──

describe("computeRefCounts", () => {
  it("counts base class implementors", () => {
    const entries: IndexEntry[] = [
      { symbol: "Base", kind: "class", filePath: "Base.cs" },
      { symbol: "ChildA", kind: "class", filePath: "ChildA.cs", baseTypes: ["Base"] },
      { symbol: "ChildB", kind: "class", filePath: "ChildB.cs", baseTypes: ["Base"] },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBe(2);
    expect(entries[1]!.refCount).toBeUndefined();
    expect(entries[2]!.refCount).toBeUndefined();
  });

  it("counts interface implementors", () => {
    const entries: IndexEntry[] = [
      { symbol: "IService", kind: "interface", filePath: "IService.cs" },
      { symbol: "SvcA", kind: "class", filePath: "SvcA.cs", baseTypes: ["IService"] },
      { symbol: "SvcB", kind: "class", filePath: "SvcB.cs", baseTypes: ["IService"] },
      { symbol: "SvcC", kind: "class", filePath: "SvcC.cs", baseTypes: ["IService"] },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBe(3);
  });

  it("leaves types with no implementors without refCount", () => {
    const entries: IndexEntry[] = [
      { symbol: "Lonely", kind: "class", filePath: "Lonely.cs" },
      { symbol: "Other", kind: "class", filePath: "Other.cs" },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBeUndefined();
    expect(entries[1]!.refCount).toBeUndefined();
  });

  it("counts multiple base types separately", () => {
    const entries: IndexEntry[] = [
      { symbol: "IFoo", kind: "interface", filePath: "IFoo.cs" },
      { symbol: "IBar", kind: "interface", filePath: "IBar.cs" },
      { symbol: "Impl", kind: "class", filePath: "Impl.cs", baseTypes: ["IFoo", "IBar"] },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBe(1);
    expect(entries[1]!.refCount).toBe(1);
    expect(entries[2]!.refCount).toBeUndefined();
  });

  it("ignores external base types not in index", () => {
    const entries: IndexEntry[] = [
      { symbol: "Svc", kind: "class", filePath: "Svc.cs", baseTypes: ["IDisposable"] },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBeUndefined();
  });

  it("does not set refCount on method entries", () => {
    const entries: IndexEntry[] = [
      { symbol: "Base", kind: "class", filePath: "Base.cs" },
      { symbol: "Child", kind: "class", filePath: "Child.cs", baseTypes: ["Base"] },
      { symbol: "Run", kind: "method", parentType: "Base", filePath: "Base.cs" },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBe(1);
    expect(entries[2]!.refCount).toBeUndefined();
  });

  it("skips self-references", () => {
    const entries: IndexEntry[] = [
      { symbol: "Weird", kind: "class", filePath: "Weird.cs", baseTypes: ["Weird"] },
    ];
    computeRefCounts(entries);
    expect(entries[0]!.refCount).toBeUndefined();
  });
});

// ── serializeIndex / parseIndex — refCount ──

describe("serializeIndex / parseIndex — refCount", () => {
  it("round-trips entry with refCount only", () => {
    const entries: IndexEntry[] = [
      { symbol: "Base", kind: "class", filePath: "Base.cs", refCount: 5 },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]!.refCount).toBe(5);
  });

  it("round-trips entry with all optional fields and refCount", () => {
    const entries: IndexEntry[] = [
      {
        symbol: "Entity", kind: "class", filePath: "Entity.cs",
        baseTypes: ["IEntity"], generics: "<TId>", modifiers: "abstract", refCount: 3,
      },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]!.baseTypes).toEqual(["IEntity"]);
    expect(parsed[0]!.generics).toBe("<TId>");
    expect(parsed[0]!.modifiers).toBe("abstract");
    expect(parsed[0]!.refCount).toBe(3);
  });

  it("does not serialize refCount of 0 or undefined", () => {
    const entries: IndexEntry[] = [
      { symbol: "Plain", kind: "class", filePath: "Plain.cs" },
      { symbol: "Zero", kind: "class", filePath: "Zero.cs", refCount: 0 },
    ];
    const raw = serializeIndex(entries);
    expect(raw).toBe("Plain|class|Plain.cs\nZero|class|Zero.cs");
  });

  it("parses old 3-6 field format without refCount", () => {
    const raw = [
      "Foo|class|Foo.cs",
      "Bar|class|Bar.cs|IBar",
      "Baz|class|Baz.cs|IBaz|<T>|sealed",
    ].join("\n");
    const parsed = parseIndex(raw);
    expect(parsed[0]!.refCount).toBeUndefined();
    expect(parsed[1]!.refCount).toBeUndefined();
    expect(parsed[2]!.refCount).toBeUndefined();
  });

  it("handles invalid refCount values gracefully", () => {
    const raw = "Foo|class|Foo.cs||||NaN\nBar|class|Bar.cs||||-1";
    const parsed = parseIndex(raw);
    expect(parsed[0]!.refCount).toBeUndefined();
    expect(parsed[1]!.refCount).toBeUndefined();
  });

  it("method entries are unaffected by refCount serialization", () => {
    const entries: IndexEntry[] = [
      { symbol: "Base", kind: "class", filePath: "Base.cs", refCount: 2 },
      { symbol: "Run", kind: "method", parentType: "Base", filePath: "Base.cs" },
    ];
    const raw = serializeIndex(entries);
    const parsed = parseIndex(raw);
    expect(parsed[0]!.refCount).toBe(2);
    expect(parsed[1]!.kind).toBe("method");
    expect(parsed[1]!.refCount).toBeUndefined();
  });
});

// ── extractIndex — refCount integration ──

describe("extractIndex — refCount", () => {
  it("sets refCount on types referenced as base types", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/IService.cs": [
        "namespace MyLib;",
        "public interface IService",
        "{",
        "    void Execute();",
        "}",
      ].join("\n"),
      "src/MyLib/SvcA.cs": [
        "namespace MyLib;",
        "public class SvcA : IService",
        "{",
        "    public void Execute() { }",
        "}",
      ].join("\n"),
      "src/MyLib/SvcB.cs": [
        "namespace MyLib;",
        "public class SvcB : IService",
        "{",
        "    public void Execute() { }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "src/MyLib");
    const entries = await extractIndex(repoDir, pkg);

    const iservice = entries.find((e) => e.symbol === "IService");
    expect(iservice?.refCount).toBe(2);

    const svcA = entries.find((e) => e.symbol === "SvcA");
    expect(svcA?.refCount).toBeUndefined();
  });
});
