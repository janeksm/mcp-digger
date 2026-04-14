import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  discoverPackages,
  findPackage,
  findRepo,
  loadConfig,
  type ConfigFile,
  type RepoConfig,
} from "./config.js";

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a config file and return env + cwd for loadConfig. */
function setupConfig(
  config: ConfigFile,
  extra: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; cwd: string } {
  const configDir = path.join(tmpDir, ".digger");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(config),
  );
  return {
    env: { DIGGER_CONFIG: ".digger/config.json", ...extra },
    cwd: tmpDir,
  };
}

/** Minimal valid config: one repo with URL and explicit package. */
function minimalConfig(
  overrides: Partial<ConfigFile["repos"][number]> = {},
): ConfigFile {
  return {
    repos: [
      {
        name: "bsf",
        url: "https://gitlab.company.com/shared/bsf.git",
        packages: ["MyCompany.Core"],
        ...overrides,
      },
    ],
  };
}

// ── Phase 1: loadConfig tests ──

describe("loadConfig — happy path", () => {
  it("parses config file with explicit packages", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "bsf",
          url: "https://gitlab.company.com/shared/bsf.git",
          sourceRoot: "src",
          packages: ["MyCompany.Core", "MyCompany.Auth", "MyCompany.Messaging"],
        },
        {
          name: "standalone-auth",
          url: "https://gitlab.company.com/shared/auth.git",
          packages: ["Company.Auth"],
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);

    expect(cfg.workspaceRoot).toBe(cwd);
    expect(cfg.repos).toHaveLength(2);

    const bsf = cfg.repos.find((r) => r.name === "bsf")!;
    expect(bsf.url).toBe("https://gitlab.company.com/shared/bsf.git");
    expect(bsf.sourceRoot).toBe("src");
    expect(bsf.discoveryMode).toBe("explicit");
    expect(bsf.packages).toHaveLength(3);

    const core = bsf.packages.find((p) => p.name === "MyCompany.Core")!;
    expect(core.repoName).toBe("bsf");
    expect(core.pathInRepo).toBe("src/MyCompany.Core");
    expect(core.cachePath).toBe(
      path.join(cwd, ".digger/cache", "MyCompany.Core"),
    );

    expect(cfg.warnings).toEqual([]);
  });

  it("defaults auth to { strategy: 'auto', pat: undefined } when nothing set", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth).toEqual({ strategy: "auto", pat: undefined });
  });

  it("marks repos without packages array as auto-discover", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "bsf",
          url: "https://gitlab.company.com/shared/bsf.git",
          // no packages → auto
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);

    expect(cfg.repos[0]!.discoveryMode).toBe("auto");
    expect(cfg.repos[0]!.packages).toEqual([]);
  });

  it("defaults sourceRoot to 'src' when omitted", () => {
    const { env, cwd } = setupConfig(minimalConfig({ sourceRoot: undefined }));
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.sourceRoot).toBe("src");
  });

  it("defaults MANAGED_SOURCE_DIR and CACHE_DIR when unset", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.managedSourceDir).toBe(path.resolve(cwd, ".digger/source"));
    expect(cfg.cacheDir).toBe(path.resolve(cwd, ".digger/cache"));
  });

  it("defaults DIGGER_CONFIG to .digger/config.json when unset", () => {
    const configDir = path.join(tmpDir, ".digger");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(minimalConfig()),
    );
    // No DIGGER_CONFIG in env
    const cfg = loadConfig({}, tmpDir);
    expect(cfg.configPath).toBe(path.resolve(tmpDir, ".digger/config.json"));
  });
});

describe("loadConfig — env var merging", () => {
  it("merges MCP_DIGGER_LOCAL_REPOS by repo name", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MCP_DIGGER_LOCAL_REPOS: "bsf:C:/dev/bsf-monorepo",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.localPath).toBe(
      path.resolve("C:/dev/bsf-monorepo"),
    );
  });

  it("captures MCP_DIGGER_PAT with default auto strategy", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MCP_DIGGER_PAT: "glpat-xxxx",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth.strategy).toBe("auto");
    expect(cfg.auth.pat).toBe("glpat-xxxx");
  });

  it("allows repo with only LOCAL_REPOS and no url", () => {
    const config: ConfigFile = {
      repos: [{ name: "bsf", packages: ["MyCompany.Core"] }],
    };
    const { env, cwd } = setupConfig(config, {
      MCP_DIGGER_LOCAL_REPOS: "bsf:C:/dev/bsf",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBeUndefined();
    expect(cfg.repos[0]!.localPath).toBe(path.resolve("C:/dev/bsf"));
  });

  it("retains both url and localPath when both are set for the same repo", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MCP_DIGGER_LOCAL_REPOS: "bsf:C:/dev/bsf-monorepo",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBe(
      "https://gitlab.company.com/shared/bsf.git",
    );
    expect(cfg.repos[0]!.localPath).toBe(
      path.resolve("C:/dev/bsf-monorepo"),
    );
  });

  it("overrides DIGGER_CONFIG path via env var", () => {
    const customDir = path.join(tmpDir, "custom");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, "my-config.json"),
      JSON.stringify(minimalConfig()),
    );
    const cfg = loadConfig(
      { DIGGER_CONFIG: "custom/my-config.json" },
      tmpDir,
    );
    expect(cfg.configPath).toBe(
      path.resolve(tmpDir, "custom/my-config.json"),
    );
  });

  it("ignores legacy unprefixed env vars (LOCAL_REPOS, GIT_TOKEN)", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      LOCAL_REPOS: "bsf:C:/dev/bsf",
      GIT_TOKEN: "legacy-token",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.localPath).toBeUndefined();
    expect(cfg.auth.pat).toBeUndefined();
  });
});

describe("loadConfig — path resolution", () => {
  it("resolves relative MANAGED_SOURCE_DIR against cwd", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MANAGED_SOURCE_DIR: "vendor/sources",
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.managedSourceDir).toBe(path.resolve(cwd, "vendor/sources"));
  });

  it("uses absolute MANAGED_SOURCE_DIR verbatim (normalized)", () => {
    const absDir = path.resolve("/custom/managed");
    const { env, cwd } = setupConfig(minimalConfig(), {
      MANAGED_SOURCE_DIR: absDir,
    });
    const cfg = loadConfig(env, cwd);
    expect(cfg.managedSourceDir).toBe(absDir);
  });

  it("builds managedSourcePath as <managedSourceDir>/<repoName>", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.managedSourcePath).toBe(
      path.join(cwd, ".digger/source", "bsf"),
    );
  });

  it("builds pathInRepo using sourceRoot (forward slashes)", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "bsf",
          url: "https://gitlab.com/bsf.git",
          sourceRoot: "libs/packages",
          packages: ["MyCompany.Core"],
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.packages[0]!.pathInRepo).toBe(
      "libs/packages/MyCompany.Core",
    );
  });

  it('uses package name alone as pathInRepo when sourceRoot is "."', () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "auth",
          url: "https://gitlab.com/auth.git",
          sourceRoot: ".",
          packages: ["Company.Auth"],
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.packages[0]!.pathInRepo).toBe("Company.Auth");
  });
});

describe("loadConfig — fatal errors", () => {
  it("throws when config file is not found", () => {
    try {
      loadConfig({ DIGGER_CONFIG: "nonexistent.json" }, tmpDir);
      expect.fail("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/not found/);
    }
  });

  it("throws when config file is invalid JSON", () => {
    const configDir = path.join(tmpDir, ".digger");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "not json{{{");
    expect(() =>
      loadConfig({ DIGGER_CONFIG: ".digger/config.json" }, tmpDir),
    ).toThrow(ConfigError);
  });

  it("throws when repos array is missing", () => {
    const configDir = path.join(tmpDir, ".digger");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{}");
    expect(() =>
      loadConfig({ DIGGER_CONFIG: ".digger/config.json" }, tmpDir),
    ).toThrow(/repos/);
  });

  it("throws when repos array is empty", () => {
    const { env, cwd } = setupConfig({ repos: [] });
    expect(() => loadConfig(env, cwd)).toThrow(/repos/);
  });

  it("throws when a repo has no name", () => {
    const config = { repos: [{ name: "", url: "https://x.git" }] };
    const { env, cwd } = setupConfig(config as ConfigFile);
    expect(() => loadConfig(env, cwd)).toThrow(/name/);
  });

  it("throws on duplicate repo names", () => {
    const config: ConfigFile = {
      repos: [
        { name: "bsf", url: "https://a.git", packages: ["A"] },
        { name: "bsf", url: "https://b.git", packages: ["B"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/Duplicate repo name.*bsf/);
  });

  it("throws on duplicate package names across repos", () => {
    const config: ConfigFile = {
      repos: [
        { name: "repo1", url: "https://a.git", packages: ["Shared.Lib"] },
        { name: "repo2", url: "https://b.git", packages: ["Shared.Lib"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(
      /Duplicate package name.*Shared\.Lib/,
    );
  });

  it("throws when a repo has neither url nor LOCAL_REPOS entry", () => {
    const config: ConfigFile = {
      repos: [{ name: "bsf", packages: ["MyCompany.Core"] }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/bsf/);
    expect(() => loadConfig(env, cwd)).toThrow(/no 'url'/);
  });

  it("throws on malformed MCP_DIGGER_LOCAL_REPOS entry with no colon", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MCP_DIGGER_LOCAL_REPOS: "bsf",
    });
    expect(() => loadConfig(env, cwd)).toThrow(/malformed/);
  });

  it("aggregates multiple errors into a single ConfigError", () => {
    // Empty repos + a repo with no source
    const { env, cwd } = setupConfig({ repos: [] });
    try {
      loadConfig(env, cwd);
      throw new Error("expected ConfigError");
    } catch (e) {
      const err = e as ConfigError;
      expect(err.problems.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("loadConfig — warnings (non-fatal)", () => {
  it("warns on MCP_DIGGER_LOCAL_REPOS entries not matching any repo name", () => {
    const { env, cwd } = setupConfig(minimalConfig(), {
      MCP_DIGGER_LOCAL_REPOS: "bsf:C:/dev/bsf,ghost-repo:C:/dev/ghost",
    });
    const cfg = loadConfig(env, cwd);
    expect(
      cfg.warnings.some((w) => w.includes("ghost-repo")),
    ).toBe(true);
  });
});

describe("loadConfig — authStrategy", () => {
  /** Config with a given auth strategy. */
  function authConfig(
    strategy: string,
    extra: NodeJS.ProcessEnv = {},
  ): { env: NodeJS.ProcessEnv; cwd: string } {
    return setupConfig(
      { authStrategy: strategy as ConfigFile["authStrategy"], ...minimalConfig() },
      extra,
    );
  }

  it("defaults to 'auto' when authStrategy is omitted from config", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth.strategy).toBe("auto");
  });

  it("reads authStrategy from config file", () => {
    const { env, cwd } = authConfig("none");
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth.strategy).toBe("none");
  });

  it("strategy 'auto' with PAT set — PAT is available for fallback", () => {
    const { env, cwd } = authConfig("auto", { MCP_DIGGER_PAT: "glpat-xxx" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth).toEqual({ strategy: "auto", pat: "glpat-xxx" });
  });

  it("strategy 'auto' without PAT — no error, pat is undefined", () => {
    const { env, cwd } = authConfig("auto");
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth).toEqual({ strategy: "auto", pat: undefined });
  });

  it("strategy 'pat' with PAT set — succeeds", () => {
    const { env, cwd } = authConfig("pat", { MCP_DIGGER_PAT: "glpat-xxx" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth).toEqual({ strategy: "pat", pat: "glpat-xxx" });
  });

  it("strategy 'pat' without PAT — fatal error", () => {
    const { env, cwd } = authConfig("pat");
    expect(() => loadConfig(env, cwd)).toThrow(/MCP_DIGGER_PAT/);
  });

  it("strategy 'none' — pat is cleared even if MCP_DIGGER_PAT is set", () => {
    const { env, cwd } = authConfig("none", { MCP_DIGGER_PAT: "glpat-xxx" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.auth).toEqual({ strategy: "none", pat: undefined });
  });

  it("strategy 'none' with PAT set — warns that PAT will be ignored", () => {
    const { env, cwd } = authConfig("none", { MCP_DIGGER_PAT: "glpat-xxx" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.warnings.some((w) => w.includes("PAT will be ignored"))).toBe(
      true,
    );
  });

  it("rejects invalid authStrategy value", () => {
    const { env, cwd } = authConfig("oauth");
    expect(() => loadConfig(env, cwd)).toThrow(/Invalid authStrategy/);
  });
});

// ── Phase 2: discoverPackages tests ──

describe("discoverPackages", () => {
  function makeRepo(sourceRoot: string, packages: string[]): string {
    const repoDir = path.join(tmpDir, "repo");
    const srcDir = path.join(repoDir, sourceRoot);
    fs.mkdirSync(srcDir, { recursive: true });
    for (const pkg of packages) {
      const pkgDir = path.join(srcDir, pkg);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, `${pkg}.csproj`), "<Project />");
    }
    return repoDir;
  }

  function makeRepoConfig(
    overrides: Partial<RepoConfig> = {},
  ): RepoConfig {
    return {
      name: "test-repo",
      managedSourcePath: "/tmp/managed/test-repo",
      sourceRoot: "src",
      discoveryMode: "auto",
      packages: [],
      ...overrides,
    };
  }

  it("discovers packages by finding dirs with matching .csproj", async () => {
    const repoDir = makeRepo("src", [
      "MyCompany.Core",
      "MyCompany.Auth",
      "MyCompany.Messaging",
    ]);
    const rc = makeRepoConfig();
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");

    expect(result).toHaveLength(3);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(["MyCompany.Auth", "MyCompany.Core", "MyCompany.Messaging"]);

    const core = result.find((p) => p.name === "MyCompany.Core")!;
    expect(core.repoName).toBe("test-repo");
    expect(core.pathInRepo).toBe("src/MyCompany.Core");
    expect(core.cachePath).toBe(path.join("/tmp/cache", "MyCompany.Core"));
  });

  it("excludes test projects (.Tests, .Specs, .Benchmarks, .IntegrationTests)", async () => {
    const repoDir = makeRepo("src", [
      "MyCompany.Core",
      "MyCompany.Core.Tests",
      "MyCompany.Core.Specs",
      "MyCompany.Core.Benchmarks",
      "MyCompany.Core.IntegrationTests",
    ]);
    const rc = makeRepoConfig();
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("MyCompany.Core");
  });

  it("skips directories without a matching .csproj file", async () => {
    const repoDir = path.join(tmpDir, "repo");
    const srcDir = path.join(repoDir, "src");
    // Dir with .csproj
    const goodDir = path.join(srcDir, "MyCompany.Core");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, "MyCompany.Core.csproj"), "<Project />");
    // Dir without matching .csproj
    const badDir = path.join(srcDir, "SomeFolder");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "README.md"), "hello");
    // Dir with a differently-named .csproj
    const mismatchDir = path.join(srcDir, "MyCompany.Auth");
    fs.mkdirSync(mismatchDir, { recursive: true });
    fs.writeFileSync(
      path.join(mismatchDir, "WrongName.csproj"),
      "<Project />",
    );

    const rc = makeRepoConfig();
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("MyCompany.Core");
  });

  it("returns empty array when sourceRoot does not exist", async () => {
    const repoDir = path.join(tmpDir, "empty-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const rc = makeRepoConfig({ sourceRoot: "nonexistent" });
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result).toEqual([]);
  });

  it('handles sourceRoot "." (packages at repo root)', async () => {
    const repoDir = makeRepo(".", ["Company.Auth"]);
    const rc = makeRepoConfig({ sourceRoot: "." });
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result).toHaveLength(1);
    expect(result[0]!.pathInRepo).toBe("Company.Auth");
  });

  it("handles custom sourceRoot", async () => {
    const repoDir = makeRepo("libs/packages", ["MyCompany.Core"]);
    const rc = makeRepoConfig({ sourceRoot: "libs/packages" });
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result).toHaveLength(1);
    expect(result[0]!.pathInRepo).toBe("libs/packages/MyCompany.Core");
  });
});

// ── Lookup helpers ──

describe("findPackage", () => {
  it("finds a package by name across repos", () => {
    const { env, cwd } = setupConfig({
      repos: [
        {
          name: "bsf",
          url: "https://a.git",
          packages: ["MyCompany.Core", "MyCompany.Auth"],
        },
        {
          name: "auth",
          url: "https://b.git",
          packages: ["Company.Auth"],
        },
      ],
    });
    const cfg = loadConfig(env, cwd);

    const pkg = findPackage(cfg, "Company.Auth");
    expect(pkg).toBeDefined();
    expect(pkg!.repoName).toBe("auth");
    expect(pkg!.pathInRepo).toBe("src/Company.Auth");
  });

  it("returns undefined for unknown package name", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(findPackage(cfg, "NonExistent")).toBeUndefined();
  });
});

describe("findRepo", () => {
  it("finds the repo owning a package", () => {
    const { env, cwd } = setupConfig({
      repos: [
        { name: "bsf", url: "https://a.git", packages: ["MyCompany.Core"] },
        { name: "auth", url: "https://b.git", packages: ["Company.Auth"] },
      ],
    });
    const cfg = loadConfig(env, cwd);

    const repo = findRepo(cfg, "MyCompany.Core");
    expect(repo).toBeDefined();
    expect(repo!.name).toBe("bsf");
  });

  it("returns undefined for unknown package", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(findRepo(cfg, "NonExistent")).toBeUndefined();
  });
});
