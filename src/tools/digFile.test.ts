import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
} from "../testHelpers.js";
import { digFile } from "./digFile.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-digger-dig-file-"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic functionality ──

describe("digFile", () => {
  it("returns full file content for a valid path", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/Entity.cs": [
        "namespace MyLib.Domain;",
        "",
        "public class Entity",
        "{",
        "    public int Id { get; set; }",
        "    public string Name { get; set; }",
        "",
        "    public void DoStuff()",
        "    {",
        "        Console.WriteLine(Name);",
        "    }",
        "}",
      ].join("\n"),
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digFile(config, "MyLib", "Domain/Entity.cs");

    expect(result).toContain("# MyLib — Domain/Entity.cs");
    expect(result).toContain("```csharp");
    expect(result).toContain("Console.WriteLine(Name)");
    expect(result).toContain("public void DoStuff()");
  });

  it("returns non-cs files with correct language hint", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/config.json": '{ "key": "value" }',
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digFile(config, "MyLib", "config.json");

    expect(result).toContain("```json");
    expect(result).toContain('"key": "value"');
  });
});

// ── Unknown package ──

describe("unknown package", () => {
  it("lists available packages when package not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Alpha/A.cs": "namespace Alpha;",
    });

    const pkg = makePkg("Alpha", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digFile(config, "NonExistent", "Any.cs");

    expect(result).toContain("Unknown package 'NonExistent'");
    expect(result).toContain("Alpha");
  });

  it("returns message when no packages configured", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digFile(config, "Anything", "Any.cs");

    expect(result).toContain("Unknown package 'Anything'");
    expect(result).toContain("No packages are configured");
  });
});

// ── Invalid file path ──

describe("invalid file path", () => {
  it("lists valid files when path not found", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Service.cs": "namespace MyLib;",
      "src/MyLib/Models/User.cs": "namespace MyLib.Models;",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digFile(config, "MyLib", "DoesNotExist.cs");

    expect(result).toContain("File 'DoesNotExist.cs' not found");
    expect(result).toContain("Available files:");
    expect(result).toContain("Service.cs");
    expect(result).toContain("Models/User.cs");
  });

  it("handles package with no files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/other/file.txt": "something",
    });

    const pkg = makePkg("EmptyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digFile(config, "EmptyLib", "Missing.cs");

    expect(result).toContain("File 'Missing.cs' not found");
    expect(result).toContain("No files available");
  });
});

// ── Path traversal protection ──

describe("path traversal protection", () => {
  const traversalCases = [
    { name: "parent directory escape", input: "../../../etc/passwd" },
    { name: "sibling package escape", input: "../OtherPkg/Service.cs" },
    { name: "normalized escape via subdir", input: "sub/../../../outside.cs" },
    { name: "absolute POSIX path", input: "/etc/passwd" },
    { name: "backslash traversal", input: "..\\..\\evil" },
    { name: "null byte injection", input: "File.cs\0.txt" },
    { name: "current directory", input: "." },
    { name: "parent directory only", input: ".." },
    { name: "empty string", input: "" },
  ];

  for (const { name, input } of traversalCases) {
    it(`rejects ${name}: ${JSON.stringify(input)}`, async () => {
      const cacheDir = path.join(tmpDir, "cache");
      const repoDir = await initRepo(tmpDir, {
        "src/MyLib/Service.cs": "namespace MyLib;",
        "src/OtherPkg/Secret.cs": "namespace OtherPkg; // secret",
      });

      const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
      const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
      const config = makeConfig([repo], tmpDir, cacheDir);

      const result = await digFile(config, "MyLib", input);

      expect(result).toContain("Invalid file path");
      // Must not leak contents of a sibling package
      expect(result).not.toContain("secret");
      expect(result).not.toContain("namespace OtherPkg");
    });
  }

  it("accepts normalized paths that stay within the package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Models/User.cs": "public class User { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    // `sub/../Models/User.cs` → `Models/User.cs` after normalization
    const result = await digFile(config, "MyLib", "sub/../Models/User.cs");

    expect(result).not.toContain("Invalid file path");
    expect(result).toContain("public class User");
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

    const result = await digFile(config, "Missing", "Any.cs");

    expect(result).toContain("Missing");
    expect(result).toContain("Source unavailable");
  });
});
