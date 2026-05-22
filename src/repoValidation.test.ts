import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildNotNetCSharpError, validateNetCSharpRepo } from "./repoValidation.js";
import { cleanupTmpDir, initBareRepo, initRepo } from "./testHelpers.js";

const execFile = util.promisify(child_process.execFile);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-validation-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("validateNetCSharpRepo", () => {
  it("valid: repo with nested .csproj", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/Lib.csproj": "<Project />",
    });

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(true);
    expect(result.csprojCount).toBe(1);
  });

  it("invalid: repo with only README", async () => {
    const repoDir = await initBareRepo(tmpDir, { "README.md": "# project" });

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });

  it("invalid: repo with only .cs files (no .csproj)", async () => {
    const repoDir = await initBareRepo(tmpDir, {
      "src/Lib/Class1.cs": "namespace Lib;",
    });

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });

  it("invalid: repo with only .vbproj (not C#)", async () => {
    const repoDir = await initBareRepo(tmpDir, {
      "src/Lib/Lib.vbproj": "<Project />",
    });

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });

  it("invalid: untracked .csproj does not count", async () => {
    const repoDir = await initBareRepo(tmpDir, { "README.md": "# project" });
    // Create a .csproj in the working tree but do NOT commit it.
    const csprojPath = path.join(repoDir, "src", "Lib", "Lib.csproj");
    fs.mkdirSync(path.dirname(csprojPath), { recursive: true });
    fs.writeFileSync(csprojPath, "<Project />");

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });

  it("valid: case-insensitive .CSPROJ extension", async () => {
    const repoDir = await initRepo(tmpDir, {
      "src/Lib/MyLib.CSPROJ": "<Project />",
    });

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(true);
    expect(result.csprojCount).toBe(1);
  });

  it("invalid: staged but uncommitted .csproj does not count", async () => {
    // Validation must read HEAD, not the index — otherwise downstream tools
    // that `git show HEAD:<path>` would fail on a repo that passed validation.
    const repoDir = await initBareRepo(tmpDir, { "README.md": "# project" });
    const csprojPath = path.join(repoDir, "src", "Lib", "Lib.csproj");
    fs.mkdirSync(path.dirname(csprojPath), { recursive: true });
    fs.writeFileSync(csprojPath, "<Project />");
    await execFile("git", ["-C", repoDir, "add", "src/Lib/Lib.csproj"]);
    // Intentionally NOT committed.

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });

  it("invalid: file literally named '.csproj' with no stem does not count", async () => {
    // Belt-and-suspenders edge case — guard the suffix match so a file
    // literally named ".csproj" (no basename) isn't accepted as a valid
    // .NET project marker.
    const repoDir = path.join(tmpDir, "repo-no-stem-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(repoDir, { recursive: true });
    await execFile("git", ["init", repoDir]);
    await execFile("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
    await execFile("git", ["-C", repoDir, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, ".csproj"), "<Project />");
    await execFile("git", ["-C", repoDir, "add", "."]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "initial"]);

    const result = await validateNetCSharpRepo(repoDir);

    expect(result.valid).toBe(false);
    expect(result.csprojCount).toBe(0);
  });
});

describe("buildNotNetCSharpError", () => {
  it("contains required user-facing substrings", () => {
    const msg = buildNotNetCSharpError("myrepo", "C:\\workspace\\myrepo");

    expect(msg).toContain("'myrepo'");
    expect(msg).toContain("only supports .NET C# repositories");
    expect(msg).toContain("no .csproj");
    expect(msg).toContain("C:\\workspace\\myrepo");
    expect(msg).toMatch(/verify.*(url|local path|configured)/i);
  });
});
