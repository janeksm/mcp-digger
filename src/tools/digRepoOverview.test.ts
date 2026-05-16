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
  makeRepoConfig,
} from "../testHelpers.js";
import { digRepoOverview } from "./digRepoOverview.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-repo-overview-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// ── Basic functionality ──

describe("digRepoOverview", () => {
  it("returns repo root README without duplicate package listing", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "README.md": "# My Repo\n\nThis is the repo root readme.",
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <PackageDescription>Core domain library</PackageDescription>",
        "    <PackageTags>core</PackageTags>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRepoOverview(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# myrepo");
    expect(result.text).toContain("This is the repo root readme.");
    expect(result.text).not.toContain("## Packages");
    expect(result.text).toContain("1 package");
    expect(result.text).toContain("dig_package_overview");
  });

  it("shows redirect line without README", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <TargetFramework>net8.0</TargetFramework>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRepoOverview(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("1 package");
    expect(result.text).toContain("dig_list");
    expect(result.text).not.toContain("## Packages");
  });

  it("omits separator when no README exists", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/MyLib.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRepoOverview(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("1 package");
    expect(result.text).not.toContain("---");
  });

  it("returns unknown repo error", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digRepoOverview(config, "nonexistent");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown repo");
  });

  it("shows package count in redirect line", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/PkgA/PkgA.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
      "src/PkgA/A.cs": "namespace PkgA; public class A { }",
      "src/PkgB/PkgB.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
      "src/PkgB/B.cs": "namespace PkgB; public class B { }",
    });

    const pkgA = makePkg("PkgA", "myrepo", "src", cacheDir);
    const pkgB = makePkg("PkgB", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkgA, pkgB], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRepoOverview(config, "myrepo");

    expect(result.text).toContain("*2 packages");
    expect(result.text).toContain("dig_list");
  });

  it("filters noise sections from repo README", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const readme = [
      "# My Repo",
      "",
      "## Architecture",
      "",
      "Domain-driven design with CQRS.",
      "",
      "## Installation",
      "",
      "```",
      "dotnet add package MyRepo",
      "```",
    ].join("\n");
    const repoDir = await initRepo(tmpDir, {
      "README.md": readme,
      "src/MyLib/MyLib.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
      "src/MyLib/Class1.cs": "namespace MyLib; public class Class1 { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digRepoOverview(config, "myrepo");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Domain-driven design with CQRS.");
    expect(result.text).not.toContain("## Installation");
    expect(result.text).not.toContain("dotnet add package");
  });

  it("returns error when repo is unreachable", async () => {
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

    const result = await digRepoOverview(config, "norepo");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("norepo");
  });
});
