import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("digList", () => {
  it("lists repos and their package names", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/X.cs": "namespace MyLib; public class X { }",
    });

    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result).toContain("# Available Packages");
    expect(result).toContain("## myrepo");
    expect(result).toContain("- MyLib");
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

    expect(result).toContain("## repo1");
    expect(result).toContain("- Alpha");
    expect(result).toContain("## repo2");
    expect(result).toContain("- Beta");
  });

  it("shows wildcard repos with resolved packages", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
      "src/MyCompany.Core/X.cs": "namespace MyCompany.Core; public class X { }",
    });

    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["MyCompany.Core"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.*", tmpDir, { localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result).toContain("(wildcard)");
    expect(result).toContain("- MyCompany.Core");
  });

  it("shows 'no packages resolved' for wildcard with zero matches", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyCompany.Core/MyCompany.Core.csproj": "<Project />",
    });

    writeCsprojFile(path.join(tmpDir, "App/App.csproj"), ["Newtonsoft.Json"]);
    writeSlnFile(tmpDir, "S.sln", ["App/App.csproj"]);

    const repo = makeWildcardRepo("MyCompany.*", tmpDir, { localPath: repoDir });
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await digList(config);

    expect(result).toContain("No packages resolved");
  });
});
