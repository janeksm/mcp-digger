import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readScanCache,
  scanCachePath,
  scanWorkspace,
  writeScanCache,
} from "./solutionScanner.js";
import {
  cleanupTmpDir,
  writeCsprojFile,
  writeDirectoryBuildProps,
  writeDirectoryBuildTargets,
  writeDirectoryPackagesProps,
  writeSlnFile,
  writeSlnxFile,
} from "./testHelpers.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-scan-test-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// ── scanWorkspace ──

describe("scanWorkspace — .sln / .slnx parsing", () => {
  it("collects PackageReference entries from .sln-referenced .csproj files", async () => {
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json", "Serilog"]);
    writeCsprojFile(path.join(tmpDir, "Lib/Lib.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "Sample.sln", ["App/App.csproj", "Lib/Lib.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual(["MyCompany.Core", "Newtonsoft.Json", "Serilog"]);
    expect(scan.solutionFiles).toHaveLength(1);
    expect(scan.csprojFiles).toHaveLength(2);
  });

  it("parses .slnx in addition to .sln", async () => {
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["FromSlnx"]);
    writeSlnxFile(tmpDir, "Sample.slnx", ["App/App.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("FromSlnx");
    expect(scan.solutionFiles.some((f) => f.endsWith(".slnx"))).toBe(true);
  });

  it("discovers a solution nested in a subdirectory (recursive walk)", async () => {
    const nestedDir = path.join(tmpDir, "src", "apps");
    writeCsprojFile(path.join(nestedDir, "App/App.csproj"), ["NestedPackage"]);
    writeSlnFile(nestedDir, "Nested.sln", ["App/App.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("NestedPackage");
    expect(scan.solutionFiles[0]).toBe(path.join(nestedDir, "Nested.sln"));
  });

  it("dedupes package names when two solutions reference the same .csproj", async () => {
    writeCsprojFile(path.join(tmpDir, "Shared/Shared.csproj"), ["SharedPackage"]);
    writeSlnFile(tmpDir, "First.sln", ["Shared/Shared.csproj"]);
    writeSlnFile(tmpDir, "Second.sln", ["Shared/Shared.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual(["SharedPackage"]);
    expect(scan.csprojFiles).toHaveLength(1); // deduped in the Set
  });

  it("warns and skips when .sln points to a missing .csproj", async () => {
    writeSlnFile(tmpDir, "Broken.sln", ["Missing/Missing.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual([]);
    expect(
      scan.warnings.some((w) => w.includes("file not found") && w.includes(".csproj")),
    ).toBe(true);
  });

  it("handles a .csproj with no PackageReference entries gracefully", async () => {
    writeCsprojFile(path.join(tmpDir, "Empty/Empty.csproj"), []);
    writeSlnFile(tmpDir, "E.sln", ["Empty/Empty.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual([]);
    expect(scan.warnings).toEqual([]);
  });

  it("returns empty result when no solution files exist", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "readme.md"), "hi");

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual([]);
    expect(scan.solutionFiles).toEqual([]);
  });

  it("resolves Windows backslash paths written into .sln files", async () => {
    // writeSlnFile already writes backslashes; just make sure they resolve.
    writeCsprojFile(path.join(tmpDir, "A/B/App.csproj"), ["DeepPackage"]);
    writeSlnFile(tmpDir, "W.sln", ["A/B/App.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("DeepPackage");
  });
});

describe("scanWorkspace — Directory.*.props / targets", () => {
  it("contributes PackageVersion entries from Directory.Packages.props at workspace root", async () => {
    writeDirectoryPackagesProps(tmpDir, ["CpmPackage.A", "CpmPackage.B"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual(["CpmPackage.A", "CpmPackage.B"]);
    expect(scan.directoryPackagesProps).toHaveLength(1);
  });

  it("discovers Directory.Packages.props in a subdirectory", async () => {
    writeDirectoryPackagesProps(path.join(tmpDir, "src"), ["NestedCpm"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("NestedCpm");
  });

  it("contributes PackageReference entries from Directory.Build.props", async () => {
    writeDirectoryBuildProps(path.join(tmpDir, "src"), ["BuildPropPkg"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("BuildPropPkg");
    expect(scan.directoryBuildProps).toHaveLength(1);
  });

  it("contributes PackageReference entries from Directory.Build.targets", async () => {
    writeDirectoryBuildTargets(path.join(tmpDir, "src"), ["TargetsPkg"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toContain("TargetsPkg");
    expect(scan.directoryBuildTargets).toHaveLength(1);
  });

  it("unions packages across props, targets, and csproj with dedupe", async () => {
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Shared", "FromCsproj"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);
    writeDirectoryPackagesProps(tmpDir, ["Shared", "FromProps"]);
    writeDirectoryBuildProps(path.join(tmpDir, "src"), ["FromBuildProps"]);
    writeDirectoryBuildTargets(path.join(tmpDir, "src"), ["FromTargets"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual([
      "FromBuildProps",
      "FromCsproj",
      "FromProps",
      "FromTargets",
      "Shared",
    ]);
  });
});

describe("scanWorkspace — ignored dirs", () => {
  it("skips .git, node_modules, bin, obj, .vs, .idea, .digger, packages", async () => {
    for (const ignored of [".git", "node_modules", "bin", "obj", ".vs", ".idea", ".digger", "packages"]) {
      writeCsprojFile(path.join(tmpDir, ignored, "pkg", "pkg.csproj"), ["IgnoredPkg"]);
      writeSlnFile(path.join(tmpDir, ignored), "Ignored.sln", ["pkg/pkg.csproj"]);
    }
    // Also add one legitimate solution so the scan isn't totally empty
    writeCsprojFile(path.join(tmpDir, "src/App/App.csproj"), ["RealPkg"]);
    writeSlnFile(path.join(tmpDir, "src"), "Real.sln", ["App/App.csproj"]);

    const scan = await scanWorkspace(tmpDir);

    expect(scan.packages).toEqual(["RealPkg"]);
    expect(scan.solutionFiles).toHaveLength(1);
  });
});

// ── Cache file ──

describe("writeScanCache / readScanCache", () => {
  it("round-trips a scan result through the cache file", async () => {
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["RoundTrip"]);
    writeSlnFile(tmpDir, "R.sln", ["App/App.csproj"]);

    const scan = await scanWorkspace(tmpDir);
    const cacheDir = path.join(tmpDir, "cache");
    const target = await writeScanCache(cacheDir, scan);

    expect(target).toBe(scanCachePath(cacheDir));
    expect(fs.existsSync(target)).toBe(true);

    const read = await readScanCache(cacheDir);
    expect(read).not.toBeNull();
    expect(read!.packages).toEqual(scan.packages);
    expect(read!.workspaceRoot).toBe(scan.workspaceRoot);
  });

  it("readScanCache returns null when no cache file exists", async () => {
    const cacheDir = path.join(tmpDir, "missing-cache");
    const result = await readScanCache(cacheDir);
    expect(result).toBeNull();
  });

  it("readScanCache ignores __proto__ keys (prototype-pollution defense)", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      scanCachePath(cacheDir),
      JSON.stringify({
        scannedAt: "2026-01-01",
        workspaceRoot: "/tmp",
        solutionFiles: [],
        csprojFiles: [],
        directoryPackagesProps: [],
        directoryBuildProps: [],
        directoryBuildTargets: [],
        packages: ["Test"],
        warnings: [],
        __proto__: { polluted: true },
      }),
    );

    const result = await readScanCache(cacheDir);
    expect(result).not.toBeNull();
    expect(result!.packages).toEqual(["Test"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
