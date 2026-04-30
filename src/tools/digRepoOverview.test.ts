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
import { digRepoOverview } from "./digRepoOverview.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-repo-overview-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic functionality ──

describe("digRepoOverview", () => {
  it("returns repo root README and package listing with summaries", async () => {
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
    expect(result.text).toContain("**MyLib** — Core domain library (tags: core)");
    expect(result.text).toContain("dig_package_overview");
  });

  it("handles packages without PackageDescription", async () => {
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
    expect(result.text).toContain("- **MyLib**");
    expect(result.text).not.toContain("**MyLib** —");
  });

  it("handles missing repo root README", async () => {
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
    expect(result.text).toContain("## Packages");
    expect(result.text).toContain("**MyLib**");
    expect(result.text).not.toContain("---");
  });

  it("returns unknown repo error", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digRepoOverview(config, "nonexistent");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown repo");
  });

  it("shows package count", async () => {
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
