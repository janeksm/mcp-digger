import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
} from "../testHelpers.js";
import { digPackageFiles } from "./digPackageFiles.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-pkg-files-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    expect(result.text).toContain("- Domain/User.cs");
    expect(result.text).toContain("- Services/Auth.cs");
    expect(result.text).toContain("*2 files*");
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
    expect(result.text).toContain("*1 file*");
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
