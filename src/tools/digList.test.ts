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
  makeWildcardRepo,
  writeCsprojFile,
  writeSlnFile,
} from "../testHelpers.js";
import { digList } from "./digList.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-dig-list-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("digList", () => {
  it("lists repos and their package names with bold formatting", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Available Packages");
    expect(result.text).toContain("## myrepo");
    expect(result.text).toContain("- **MyLib**");
  });

  it("lists multiple repos with their packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repo1Dir = await initRepo(tmpDir, {
      "src/Alpha/A.cs": "namespace Alpha; public class A { }",
    });
    const repo2Dir = await initRepo(tmpDir, {
      "src/Beta/B.cs": "namespace Beta; public class B { }",
    });

    const pkgA = makePkg("Alpha", "repo1", "src", cacheDir);
    const pkgB = makePkg("Beta", "repo2", "src", cacheDir);
    const repoA = makeLocalRepo("repo1", repo1Dir, [pkgA], tmpDir);
    const repoB = makeLocalRepo("repo2", repo2Dir, [pkgB], tmpDir);
    const config = makeConfig([repoA, repoB], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## repo1");
    expect(result.text).toContain("- **Alpha**");
    expect(result.text).toContain("## repo2");
    expect(result.text).toContain("- **Beta**");
  });

  it("shows wildcard repos with resolved packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Core/X.cs": "namespace MyCompany.Core; public class X { }",
    });

    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("## MyCompany.Libs");
    expect(result.text).toContain("- **MyCompany.Core**");
  });

  it("includes .csproj summaries when available", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const csproj = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <PackageDescription>Core domain primitives</PackageDescription>",
      "    <PackageTags>ddd shared-kernel</PackageTags>",
      "  </PropertyGroup>",
      "</Project>",
    ].join("\n");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": csproj,
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.text).toContain("- **MyLib** — Core domain primitives (tags: ddd shared-kernel)");
  });

  it("renders cleanly when .csproj has no description", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.text).toContain("- **MyLib**");
    expect(result.text).not.toContain("— ");
  });

  it("shows 'no packages resolved' for wildcard with zero matches", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });

    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.text).toContain("No packages resolved");
    expect(result.text).toContain("Diagnostic:");
    expect(result.text).toContain("matched zero packages");
  });

  it("returns isError when all repos fail to resolve", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("MyLib", "badrepo", "src", cacheDir);
    const repo = makeLocalRepo("badrepo", path.join(tmpDir, "nonexistent"), [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Warning:");
  });

  it("returns success when at least one repo resolves", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const goodPkg = makePkg("MyLib", "goodrepo", "src", cacheDir);
    const goodRepo = makeLocalRepo("goodrepo", repoDir, [goodPkg], tmpDir);
    const badPkg = makePkg("BadLib", "badrepo", "src", cacheDir);
    const badRepo = makeLocalRepo("badrepo", path.join(tmpDir, "nonexistent"), [badPkg], tmpDir);
    const config = makeConfig([goodRepo, badRepo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("- **MyLib**");
  });
});
