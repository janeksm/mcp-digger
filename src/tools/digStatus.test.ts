import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitAuth } from "../config.js";
import { markFresh, writeIndex } from "../cacheManager.js";
import {
  cleanupTmpDir,
  createBareRepo,
  initRepo,
  makeConfig,
  makeLocalRepo,
  makePkg,
  makeRepoConfig,
  makeWildcardRepo,
  writeCsprojFile,
  writeSlnFile,
} from "../testHelpers.js";
import { digStatus, formatCacheAge } from "./digStatus.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-dig-status-"));
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// ── Unconfigured mode ──

describe("unconfigured mode", () => {
  it("returns not-configured message when config is null", async () => {
    const result = await digStatus(null);

    expect(result).toContain("unconfigured mode");
    expect(result).toContain("no `.digger/config.json` found");
  });

  it("includes setup instructions mentioning dig_init", async () => {
    const result = await digStatus(null);

    expect(result).toContain("dig_init");
    expect(result).toContain(".digger/config.json");
  });
});

// ── Config summary ──

describe("config summary", () => {
  it("renders repo count in the configuration section", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digStatus(config);

    expect(result).toContain("Repos:** 0");
  });

  it("returns sensible output with no repos configured", async () => {
    const config = makeConfig([], tmpDir);

    const result = await digStatus(config);

    expect(result).toContain("No repositories configured");
    expect(result).toContain("Repos:** 0");
  });

  it("displays config warnings", async () => {
    const config = makeConfig([], tmpDir);
    config.warnings = ["Orphan localRepos entry 'stale'"];

    const result = await digStatus(config);

    expect(result).toContain("Config warnings");
    expect(result).toContain("Orphan localRepos entry 'stale'");
  });
});

// ── Per-repo auth display ──

describe("per-repo auth display", () => {
  it("renders auth strategy and PAT status under each repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const auth: GitAuth = { strategy: "auto", pat: "some-token" };
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir, "src", auth);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Auth strategy:** auto");
    expect(result).toContain("PAT:** configured");
  });

  it("shows PAT as not set when repo has no PAT", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Auth strategy:** none");
    expect(result).toContain("PAT:** not set");
  });
});

// ── Local repo checks ──

describe("local repo checks", () => {
  it("reports OK for valid local repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Local repo valid:** OK");
    expect(result).toContain("All checks passed");
  });

  it("reports FAILED for invalid local path", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeRepoConfig(
      {
        name: "myrepo",
        localPath: path.join(tmpDir, "nonexistent"),
        packages: [pkg],
      },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Local repo valid:** FAILED");
    expect(result).toContain("1 of 1 repo(s) have issues");
  });
});

// ── Remote connectivity checks ──

describe("remote connectivity checks", () => {
  it("reports OK for reachable bare repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const bareDir = await createBareRepo(tmpDir, { "file.txt": "content" });

    const repo = makeRepoConfig({ name: "remoterepo", url: bareDir }, tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Remote connectivity:** OK");
    expect(result).toContain("branch refs found");
    expect(result).toContain("All checks passed");
  });

  it("reports FAILED for unreachable URL", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repo = makeRepoConfig(
      { name: "badrepo", url: "/nonexistent/repo.git" },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Remote connectivity:** FAILED");
    expect(result).toContain("Error:");
    expect(result).toContain("1 of 1 repo(s) have issues");
  });
});

// ── Mixed results ──

describe("mixed results", () => {
  it("counts issues correctly with mixed repos", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Good/A.cs": "namespace Good;" });

    const goodPkg = makePkg("Good", "good", "src", cacheDir);
    const goodRepo = makeLocalRepo("good", repoDir, [goodPkg], tmpDir);

    const badRepo = makeRepoConfig(
      { name: "bad", localPath: path.join(tmpDir, "nonexistent") },
      tmpDir,
    );

    const config = makeConfig([goodRepo, badRepo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Repo: good");
    expect(result).toContain("Repo: bad");
    expect(result).toContain("1 of 2 repo(s) have issues");
  });
});

// ── Wildcard repos ──

describe("wildcard repo rendering", () => {
  it("renders Workspace scan section and per-repo cross-check counts", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/A.cs": "namespace Core;",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), [
      "MyCompany.Core",
      "Newtonsoft.Json",
    ]);
    writeSlnFile(tmpDir, "Sample.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("## Workspace scan");
    expect(result).toContain("Solution files:** 1");
    expect(result).toContain("Total referenced packages:** 2");
    expect(result).toContain('Discovery:** wildcard (filter "MyCompany.*")');
    expect(result).toContain("Referenced matching prefix:** 1");
    expect(result).toContain("MyCompany.Core");
  });

  it("shows diagnostic when no solution files exist for wildcard repo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/A.cs": "namespace Core;",
    });
    const repo = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain('Discovery:** wildcard (filter "MyCompany.*")');
    expect(result).toContain("Matched packages:** 0");
    expect(result).toContain("no .sln/.slnx files found in workspace");
  });

  it("shows diagnostic when refs exist but none match prefix", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/A.cs": "namespace Core;",
    });
    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json", "SomeOther.Lib"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.Libs", tmpDir, { packageFilter: "MyCompany.*", localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Matched packages:** 0");
    expect(result).toContain("no workspace-referenced packages match prefix");
  });
});

// ── Repo info display ──

describe("repo info display", () => {
  it("shows mode, source root, discovery, and packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "lib/Core/C.cs": "namespace Core;" });

    const pkg = makePkg("Core", "myrepo", "lib", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir, "lib");
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Mode:** local");
    expect(result).toContain("Source root:** lib");
    expect(result).toContain("Discovery:** explicit (1)");
    expect(result).toContain("Packages:** Core");
  });

  it("shows managed mode for repos with URL only", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const bareDir = await createBareRepo(tmpDir, { "f.txt": "x" });

    const repo = makeRepoConfig(
      { name: "managed", url: bareDir, discoveryMode: "auto" },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Mode:** managed");
    expect(result).toContain("auto");
  });

  it("shows auto discovery with not yet discovered when no packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "content" });

    const repo = makeLocalRepo("myrepo", repoDir, [], tmpDir);
    repo.discoveryMode = "auto";
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("auto (not yet discovered)");
  });

  it("shows branch when configured", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "content" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    repo.branch = "develop";
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("Branch:** develop");
  });

  it("omits branch line when not configured", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "content" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).not.toContain("Branch:**");
  });
});

// ── Index stats ──

describe("index stats", () => {
  it("shows 'not yet built' when no meta or index cache exists", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("not yet built");
    expect(result).toContain("dig_lookup");
  });

  it("shows cache age and commit when meta exists but no index", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");

    const result = await digStatus(config);

    expect(result).toContain("no packages indexed");
    expect(result).toContain("Commit:** abcdef1");
    expect(result).toContain("Cache:");
  });

  it("shows file count, types, and methods from index data", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");
    await writeIndex(pkg, [
      "MyClass|class|Services/MyClass.cs",
      "IMyService|interface|Interfaces/IMyService.cs",
      "DoWork|method|MyClass|Services/MyClass.cs",
      "Execute|method|MyClass|Services/MyClass.cs",
    ].join("\n"));

    const result = await digStatus(config);

    expect(result).toContain("Index:** 2 files");
    expect(result).toContain("2 types");
    expect(result).toContain("2 methods");
    expect(result).toContain("Commit:** abcdef1");
  });

  it("aggregates stats across multiple packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/A.cs": "namespace Core;",
      "src/Web/B.cs": "namespace Web;",
    });

    const pkg1 = makePkg("Core", "myrepo", "src", cacheDir);
    const pkg2 = makePkg("Web", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg1, pkg2], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");
    await writeIndex(pkg1, "Entity|class|Entity.cs\nGetById|method|Entity|Entity.cs");
    await writeIndex(pkg2, "Controller|class|Controller.cs\nIndex|method|Controller|Controller.cs\nCreate|method|Controller|Controller.cs");

    const result = await digStatus(config);

    expect(result).toContain("Index:** 2 files");
    expect(result).toContain("2 types");
    expect(result).toContain("3 methods");
  });

  it("counts unique files when multiple symbols share one file", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "namespace Lib;" });

    const pkg = makePkg("Lib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");
    await writeIndex(pkg, [
      "MyClass|class|Same.cs",
      "DoA|method|MyClass|Same.cs",
      "DoB|method|MyClass|Same.cs",
      "DoC|method|MyClass|Same.cs",
    ].join("\n"));

    const result = await digStatus(config);

    expect(result).toContain("Index:** 1 file");
    expect(result).toContain("1 type");
    expect(result).toContain("3 methods");
  });

  it("reports missing packages when only some have index data", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/A.cs": "namespace Core;",
      "src/Web/B.cs": "namespace Web;",
    });

    const pkg1 = makePkg("Core", "myrepo", "src", cacheDir);
    const pkg2 = makePkg("Web", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg1, pkg2], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");
    await writeIndex(pkg1, "Entity|class|Entity.cs");
    // pkg2 has no index

    const result = await digStatus(config);

    expect(result).toContain("Index:** 1 file");
    expect(result).toContain("Index coverage:** 1/2 packages indexed");
    expect(result).toContain("missing: Web");
  });

  it("counts files separately across packages with same relative path", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/Core/A.cs": "namespace Core;",
      "src/Web/A.cs": "namespace Web;",
    });

    const pkg1 = makePkg("Core", "myrepo", "src", cacheDir);
    const pkg2 = makePkg("Web", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg1, pkg2], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    await markFresh(cacheDir, "myrepo", "abcdef1234567890abcdef1234567890abcdef12");
    await writeIndex(pkg1, "CoreClass|class|Shared.cs");
    await writeIndex(pkg2, "WebClass|class|Shared.cs");

    const result = await digStatus(config);

    expect(result).toContain("Index:** 2 files");
  });

  it("shows 'not yet discovered' for auto repos with 0 packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, { "src/Lib/A.cs": "content" });

    const repo = makeLocalRepo("myrepo", repoDir, [], tmpDir);
    repo.discoveryMode = "auto";
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digStatus(config);

    expect(result).toContain("not yet discovered");
  });
});

// ── formatCacheAge ──

describe("formatCacheAge", () => {
  it("formats seconds as '< 1m'", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("2026-05-15T11:59:30Z", now)).toBe("< 1m");
  });

  it("formats minutes", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("2026-05-15T11:45:00Z", now)).toBe("15m");
  });

  it("formats hours and minutes", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("2026-05-15T09:46:00Z", now)).toBe("2h 14m");
  });

  it("formats days and hours", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("2026-05-12T10:00:00Z", now)).toBe("3d 2h");
  });

  it("returns 'unknown' for empty string", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("", now)).toBe("unknown");
  });

  it("returns 'unknown' for invalid date", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("not-a-date", now)).toBe("unknown");
  });

  it("clamps future dates to '< 1m'", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatCacheAge("2026-05-15T13:00:00Z", now)).toBe("< 1m");
  });
});
