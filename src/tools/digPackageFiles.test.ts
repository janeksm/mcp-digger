import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTmpDir,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
} from "../testHelpers.js";
import { buildDirectorySummary, digPackageFiles } from "./digPackageFiles.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-pkg-files-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// ── Basic functionality ──

describe("digPackageFiles", () => {
  it("lists .cs files for a valid package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Domain/User.cs": "namespace MyLib.Domain;\npublic class User { }",
      "src/MyLib/Services/Auth.cs": "namespace MyLib.Services;\npublic class Auth { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# MyLib — Source Files");
    expect(result.text).toContain("Domain/ (1) · Services/ (1)");
    expect(result.text).toContain("- Domain/User.cs");
    expect(result.text).toContain("- Services/Auth.cs");
    expect(result.text).toContain("*2 files —");
  });

  it("excludes generated files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
      "src/MyLib/Class1.g.cs": "// generated",
      "src/MyLib/Model.generated.cs": "// generated",
      "src/MyLib/View.Designer.cs": "// generated",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.text).toContain("- Class1.cs");
    expect(result.text).not.toContain("Class1.g.cs");
    expect(result.text).not.toContain("Model.generated.cs");
    expect(result.text).not.toContain("View.Designer.cs");
    expect(result.text).toContain("*1 file —");
  });

  it("returns empty message when package has no .cs files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/README.md": "Just docs, no source.",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("No C# source files found");
  });
});

// ── Contextual hints ──

describe("contextual hints", () => {
  it("hints dig_file for small package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/A.cs": "public class A { }",
      "src/MyLib/B.cs": "public class B { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.text).toContain("dig_file");
    expect(result.text).toContain("dig_lookup");
  });

  it("hints dig_lookup for large package", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      files[`src/MyLib/Services/Svc${i}.cs`] = `public class Svc${i} { }`;
    }
    const repoDir = await initRepo(tmpDir, files);

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.text).toContain("dig_lookup");
    expect(result.text).toContain("instead of browsing");
  });
});

// ── Error handling ──

describe("error handling", () => {
  it("returns error for unknown repo", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digPackageFiles(config, "nonexistent", "MyLib");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown repo");
  });

  it("returns error for unknown package in repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "NonExistent");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown package 'NonExistent'");
    expect(result.text).toContain("MyLib");
  });
});

// ── Directory summary ──

describe("buildDirectorySummary", () => {
  it("groups by top-level directory, sorted alphabetically", () => {
    const paths = [
      "Cqrs/Handler.cs",
      "Attributes/MyAttr.cs",
      "Attributes/OtherAttr.cs",
      "Cqrs/Query.cs",
      "Extensions/StringExt.cs",
    ];
    expect(buildDirectorySummary(paths)).toBe(
      "Attributes/ (2) · Cqrs/ (2) · Extensions/ (1)",
    );
  });

  it("appends root file count when present", () => {
    const paths = [
      "Domain/Entity.cs",
      "BaseClass.cs",
      "IService.cs",
    ];
    expect(buildDirectorySummary(paths)).toBe(
      "Domain/ (1) · 2 root files",
    );
  });

  it("uses singular for a single root file", () => {
    const paths = [
      "Services/Auth.cs",
      "Root.cs",
    ];
    expect(buildDirectorySummary(paths)).toBe(
      "Services/ (1) · 1 root file",
    );
  });

  it("returns undefined when all files are at root", () => {
    const paths = ["Class1.cs", "Class2.cs", "Interface1.cs"];
    expect(buildDirectorySummary(paths)).toBeUndefined();
  });
});

describe("directory summary in tool output", () => {
  it("includes summary with subdirectories and root files", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Attributes/MyAttr.cs": "public class MyAttr { }",
      "src/MyLib/Attributes/OtherAttr.cs": "public class OtherAttr { }",
      "src/MyLib/Services/Auth.cs": "public class Auth { }",
      "src/MyLib/Root.cs": "public class Root { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.text).toContain("Attributes/ (2) · Services/ (1) · 1 root file");
    expect(result.text).toContain("- Attributes/MyAttr.cs");
    expect(result.text).toContain("- Root.cs");
  });

  it("omits summary when all files are at package root", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/Class1.cs": "public class Class1 { }",
      "src/MyLib/Class2.cs": "public class Class2 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digPackageFiles(config, "myrepo", "MyLib");

    expect(result.text).toContain("# MyLib — Source Files");
    expect(result.text).toContain("- Class1.cs");
    expect(result.text).not.toMatch(/\(\d+\)/);
  });
});
