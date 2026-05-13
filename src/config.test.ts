import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  discoverPackages,
  findPackage,
  findRepo,
  isValidPackageName,
  loadConfig,
  parseEnvFile,
  validateBranchName,
  validateRepoUrl,
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

// ── isValidPackageName ──

describe("isValidPackageName", () => {
  it.each([
    "MyCompany.Core",
    "My-Package_v2.0",
    "A",
    "123",
    "System.Text.Json",
  ])("accepts valid name: %s", (name) => {
    expect(isValidPackageName(name)).toBe(true);
  });

  it.each([
    ["../evil", "path traversal"],
    ["foo/bar", "forward slash"],
    ["foo\\bar", "backslash"],
    ["", "empty string"],
    ["foo bar", "space"],
    [".", "single dot"],
    ["..", "double dot"],
    ["pkg\0name", "null byte"],
    ["pkg@1.0", "at sign"],
  ])("rejects invalid name: %s (%s)", (name) => {
    expect(isValidPackageName(name)).toBe(false);
  });
});

// ── validateRepoUrl ──

describe("validateRepoUrl", () => {
  it.each([
    "https://gitlab.company.com/shared/bsf.git",
    "ssh://git@gitlab.company.com/shared/bsf.git",
    "git@gitlab.company.com:shared/bsf.git",
  ])("accepts valid URL: %s", (url) => {
    expect(validateRepoUrl(url)).toBeUndefined();
  });

  it.each([
    ["http://example.com/repo.git", "http:"],
    ["git://example.com/repo.git", "git:"],
    ["file:///tmp/repo.git", "file:"],
    ["ftp://example.com/repo", "ftp:"],
  ])("rejects disallowed scheme: %s", (url, scheme) => {
    expect(validateRepoUrl(url)).toMatch(new RegExp(`'${scheme}'.*not allowed`));
  });

  it("rejects garbage input", () => {
    expect(validateRepoUrl("not a url at all")).toMatch(/is not a valid URL/);
  });
});

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

  it("defaults repo auth to { strategy: 'auto' } when auth block is omitted", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "auto" });
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

  it("treats packages:[] the same as omitted → auto-discover", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "bsf",
          url: "https://gitlab.company.com/shared/bsf.git",
          packages: [],
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

  it("reads debug flag from config file", () => {
    const { env, cwd } = setupConfig({ debug: true, ...minimalConfig() });
    const cfg = loadConfig(env, cwd);
    expect(cfg.debug).toBe(true);
  });
});

describe("loadConfig — localRepos", () => {
  it("maps repo name → absolute local path", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "C:/dev/bsf-monorepo" },
      ...minimalConfig(),
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.localPath).toBe(path.resolve("C:/dev/bsf-monorepo"));
  });

  it("resolves relative localRepos paths against cwd", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "../some/local/bsf" },
      ...minimalConfig(),
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.localPath).toBe(
      path.resolve(cwd, "../some/local/bsf"),
    );
  });

  it("allows repo with only localRepos entry and no url", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "C:/dev/bsf" },
      repos: [{ name: "bsf", packages: ["MyCompany.Core"] }],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBeUndefined();
    expect(cfg.repos[0]!.localPath).toBe(path.resolve("C:/dev/bsf"));
  });

  it("retains both url and localPath when both are set for the same repo", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "C:/dev/bsf-monorepo" },
      ...minimalConfig(),
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBe(
      "https://gitlab.company.com/shared/bsf.git",
    );
    expect(cfg.repos[0]!.localPath).toBe(
      path.resolve("C:/dev/bsf-monorepo"),
    );
  });

  it("warns on localRepos entries not matching any repo name", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "C:/dev/bsf", "ghost-repo": "C:/dev/ghost" },
      ...minimalConfig(),
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(
      cfg.warnings.some((w) => w.includes("ghost-repo")),
    ).toBe(true);
  });

  it("rejects non-object localRepos", () => {
    // Pass a clearly-invalid value via type assertion
    const config = {
      localRepos: ["bsf:path"] as unknown,
      ...minimalConfig(),
    } as ConfigFile;
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/localRepos.*object/i);
  });

  it("rejects localRepos entry with empty path", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "   " },
      ...minimalConfig(),
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/non-empty string/);
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
  it("returns null when config file is not found at default path", () => {
    const result = loadConfig({}, tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when config file is not found at custom DIGGER_CONFIG path", () => {
    const result = loadConfig({ DIGGER_CONFIG: "custom/path/config.json" }, tmpDir);
    expect(result).toBeNull();
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

  it("throws when a repo has neither url nor localRepos entry", () => {
    const config: ConfigFile = {
      repos: [{ name: "bsf", packages: ["MyCompany.Core"] }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/bsf/);
    expect(() => loadConfig(env, cwd)).toThrow(/no 'url'/);
  });

  it("throws with migration guidance when legacy top-level authStrategy is present", () => {
    // Forge the legacy shape via a cast so TS still type-checks the new schema.
    const legacy = {
      authStrategy: "pat",
      ...minimalConfig(),
    } as unknown as ConfigFile;
    const { env, cwd } = setupConfig(legacy);
    expect(() => loadConfig(env, cwd)).toThrow(/authStrategy.*no longer supported/i);
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

  it("throws on package name with path traversal characters", () => {
    const config: ConfigFile = {
      repos: [
        { name: "bsf", url: "https://a.git", packages: ["../evil"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/invalid characters/);
  });

  it("throws on package name with forward slash", () => {
    const config: ConfigFile = {
      repos: [
        { name: "bsf", url: "https://a.git", packages: ["foo/bar"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/invalid characters/);
  });

  it("throws on repo name with path traversal characters", () => {
    const config: ConfigFile = {
      repos: [
        { name: "../evil", url: "https://a.git", packages: ["Pkg"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/invalid characters/);
  });

  it("throws on packageFilter with invalid prefix characters", () => {
    const config: ConfigFile = {
      repos: [
        { name: "Libs", url: "https://a.git", packageFilter: "my repo.*" },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/invalid characters/);
  });

  it.each([
    ["file:///tmp/repo.git", /not allowed/],
    ["git://example.com/repo.git", /not allowed/],
    ["http://example.com/repo.git", /not allowed/],
  ])("throws on disallowed URL scheme: %s", (url, pattern) => {
    const config: ConfigFile = {
      repos: [{ name: "bsf", url, packages: ["Pkg"] }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(pattern);
  });
});

describe("loadConfig — URL schemes", () => {
  it("accepts SSH shorthand URL", () => {
    const config: ConfigFile = {
      repos: [
        { name: "bsf", url: "git@gitlab.company.com:shared/bsf.git", packages: ["Pkg"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBe("git@gitlab.company.com:shared/bsf.git");
  });

  it("accepts ssh:// URL", () => {
    const config: ConfigFile = {
      repos: [
        { name: "bsf", url: "ssh://git@gitlab.company.com/shared/bsf.git", packages: ["Pkg"] },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.url).toBe("ssh://git@gitlab.company.com/shared/bsf.git");
  });
});

describe("loadConfig — per-repo auth", () => {
  /** Build a config with one repo and the given auth block. */
  function authConfig(
    auth: ConfigFile["repos"][number]["auth"],
    extra: NodeJS.ProcessEnv = {},
  ): { env: NodeJS.ProcessEnv; cwd: string } {
    return setupConfig(minimalConfig({ auth }), extra);
  }

  it("defaults to { strategy: 'auto' } when auth is omitted", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "auto" });
  });

  it("reads auth.strategy from config file", () => {
    const { env, cwd } = authConfig({ strategy: "none" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth.strategy).toBe("none");
  });

  it("resolves inline auth.PAT", () => {
    const { env, cwd } = authConfig({ strategy: "pat", PAT: "glpat-inline" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "pat", pat: "glpat-inline" });
  });

  it("resolves auth.PAT-EnvVarName from environment", () => {
    const { env, cwd } = authConfig(
      { strategy: "pat", "PAT-EnvVarName": "MY_CUSTOM_PAT" },
      { MY_CUSTOM_PAT: "glpat-from-env" },
    );
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "pat", pat: "glpat-from-env" });
  });

  it("rejects when both auth.PAT and auth.PAT-EnvVarName are set", () => {
    const { env, cwd } = authConfig({
      strategy: "pat",
      PAT: "inline",
      "PAT-EnvVarName": "SOME_VAR",
    });
    expect(() => loadConfig(env, cwd)).toThrow(/mutually exclusive/);
  });

  it("fails when strategy 'pat' has no PAT or PAT-EnvVarName", () => {
    const { env, cwd } = authConfig({ strategy: "pat" });
    expect(() => loadConfig(env, cwd)).toThrow(/no PAT or PAT-EnvVarName/);
  });

  it("fails when strategy 'pat' references an unset env var", () => {
    const { env, cwd } = authConfig({
      strategy: "pat",
      "PAT-EnvVarName": "MISSING_ENV_VAR",
    });
    expect(() => loadConfig(env, cwd)).toThrow(/MISSING_ENV_VAR/);
  });

  it("strategy 'auto' without PAT — no error, pat is undefined", () => {
    const { env, cwd } = authConfig({ strategy: "auto" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "auto" });
  });

  it("strategy 'auto' with PAT — PAT is retained for fallback", () => {
    const { env, cwd } = authConfig({ strategy: "auto", PAT: "glpat-auto" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "auto", pat: "glpat-auto" });
  });

  it("strategy 'none' with PAT — PAT is cleared and a warning is emitted", () => {
    const { env, cwd } = authConfig({ strategy: "none", PAT: "glpat-xxx" });
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth).toEqual({ strategy: "none" });
    expect(cfg.warnings.some((w) => w.includes("will be ignored"))).toBe(true);
  });

  it("rejects invalid auth.strategy value", () => {
    const { env, cwd } = authConfig({
      strategy: "oauth" as unknown as "auto",
    });
    expect(() => loadConfig(env, cwd)).toThrow(/invalid auth\.strategy/i);
  });

  it("each repo can have its own auth — both are resolved independently", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "public",
          url: "https://github.com/owner/public.git",
          packages: ["Pub"],
          auth: { strategy: "none" },
        },
        {
          name: "private",
          url: "https://gitlab.com/owner/private.git",
          packages: ["Priv"],
          auth: { strategy: "pat", "PAT-EnvVarName": "PRIV_PAT" },
        },
      ],
    };
    const { env, cwd } = setupConfig(config, { PRIV_PAT: "glpat-priv" });
    const cfg = loadConfig(env, cwd);

    const pub = cfg.repos.find((r) => r.name === "public")!;
    const priv = cfg.repos.find((r) => r.name === "private")!;
    expect(pub.auth).toEqual({ strategy: "none" });
    expect(priv.auth).toEqual({ strategy: "pat", pat: "glpat-priv" });
  });
});

// ── .env file loading ──

describe("parseEnvFile", () => {
  it("parses KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result.get("FOO")).toBe("bar");
    expect(result.get("BAZ")).toBe("qux");
  });

  it("skips blank lines and comments", () => {
    const result = parseEnvFile("# comment\n\nFOO=bar\n  # indented comment\n");
    expect(result.size).toBe(1);
    expect(result.get("FOO")).toBe("bar");
  });

  it("strips double quotes from values", () => {
    const result = parseEnvFile('FOO="hello world"');
    expect(result.get("FOO")).toBe("hello world");
  });

  it("strips single quotes from values", () => {
    const result = parseEnvFile("FOO='hello world'");
    expect(result.get("FOO")).toBe("hello world");
  });

  it("handles values containing equals signs", () => {
    const result = parseEnvFile("FOO=a=b=c");
    expect(result.get("FOO")).toBe("a=b=c");
  });

  it("handles values containing colons", () => {
    const result = parseEnvFile("PATH_LIKE=a:b:c");
    expect(result.get("PATH_LIKE")).toBe("a:b:c");
  });

  it("strips inline comments for unquoted values", () => {
    const result = parseEnvFile("FOO=bar # this is a comment");
    expect(result.get("FOO")).toBe("bar");
  });

  it("preserves # inside quoted values", () => {
    const result = parseEnvFile('FOO="bar # not a comment"');
    expect(result.get("FOO")).toBe("bar # not a comment");
  });

  it("skips lines without = sign", () => {
    const result = parseEnvFile("NOEQUALS\nFOO=bar");
    expect(result.size).toBe(1);
    expect(result.get("FOO")).toBe("bar");
  });

  it("trims whitespace around keys and values", () => {
    const result = parseEnvFile("  FOO  =  bar  ");
    expect(result.get("FOO")).toBe("bar");
  });
});

describe("loadConfig — .env file loading", () => {
  /** Write a .env file in tmpDir. */
  function writeEnvFile(content: string): void {
    fs.writeFileSync(path.join(tmpDir, ".env"), content);
  }

  it("resolves PAT-EnvVarName via values in .env", () => {
    const { env, cwd } = setupConfig(
      minimalConfig({
        auth: { strategy: "pat", "PAT-EnvVarName": "MY_PAT" },
      }),
    );
    writeEnvFile("MY_PAT=glpat-from-env-file");
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth.pat).toBe("glpat-from-env-file");
  });

  it("actual env vars take precedence over .env file values", () => {
    const { env, cwd } = setupConfig(
      minimalConfig({
        auth: { strategy: "pat", "PAT-EnvVarName": "MY_PAT" },
      }),
      { MY_PAT: "glpat-from-actual-env" },
    );
    writeEnvFile("MY_PAT=glpat-from-env-file");
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth.pat).toBe("glpat-from-actual-env");
  });

  it("works when no .env file exists", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    // no .env file written
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.auth.pat).toBeUndefined();
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
      auth: { strategy: "none" },
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

  it("caps discovery at MAX_DISCOVERED_PACKAGES (200)", async () => {
    const repoDir = path.join(tmpDir, "repo");
    const srcDir = path.join(repoDir, "src");
    for (let i = 0; i < 210; i++) {
      const name = `Pkg${String(i).padStart(3, "0")}`;
      const pkgDir = path.join(srcDir, name);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, `${name}.csproj`), "<Project />");
    }
    const rc = makeRepoConfig();
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("skips directories with invalid names", async () => {
    const repoDir = path.join(tmpDir, "repo");
    const srcDir = path.join(repoDir, "src");
    // Valid package
    const goodDir = path.join(srcDir, "MyCompany.Core");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, "MyCompany.Core.csproj"), "<Project />");
    // Invalid name — contains space
    const badDir = path.join(srcDir, "Bad Package");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "Bad Package.csproj"), "<Project />");

    const rc = makeRepoConfig();
    const result = await discoverPackages(repoDir, rc, "/tmp/cache");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("MyCompany.Core");
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

// ── packageFilter ──

describe("loadConfig — packageFilter", () => {
  it("packageFilter 'MyCompany.*' → discoveryMode 'wildcard', managedSourcePath uses repo name", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "MyCompany.Libs",
          url: "https://gitlab.company.com/shared/libs.git",
          packageFilter: "MyCompany.*",
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);

    expect(cfg.repos[0]!.discoveryMode).toBe("wildcard");
    expect(cfg.repos[0]!.packageFilter).toBe("MyCompany.*");
    expect(cfg.repos[0]!.packages).toEqual([]);
    expect(cfg.repos[0]!.managedSourcePath).toBe(
      path.join(cwd, ".digger/source", "MyCompany.Libs"),
    );
  });

  it("rejects '*' in repo name (must use packageFilter instead)", () => {
    const config: ConfigFile = {
      repos: [{ name: "MyCompany.*", url: "https://g.com/x.git" }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(
      /name must not contain '\*'.*packageFilter/i,
    );
  });

  it("rejects repo name with trailing '.'", () => {
    const config: ConfigFile = {
      repos: [{ name: "BSF.", url: "https://g.com/x.git" }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/must not end with '\.'/);
  });

  it("rejects packageFilter without trailing '*'", () => {
    const config: ConfigFile = {
      repos: [{ name: "Libs", url: "https://g.com/x.git", packageFilter: "MyCompany." }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(
      /packageFilter.*must end with '\*'/i,
    );
  });

  it("rejects packageFilter '*' (too broad)", () => {
    const config: ConfigFile = {
      repos: [{ name: "Libs", url: "https://g.com/x.git", packageFilter: "*" }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/too broad/i);
  });

  it("rejects packageFilter '.*' (too broad after stripping)", () => {
    const config: ConfigFile = {
      repos: [{ name: "Libs", url: "https://g.com/x.git", packageFilter: ".*" }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/too broad/i);
  });

  it("rejects packageFilter with invalid characters", () => {
    const config: ConfigFile = {
      repos: [{ name: "Libs", url: "https://g.com/x.git", packageFilter: "My Company.*" }],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(/invalid characters/i);
  });

  it("rejects packageFilter combined with explicit packages", () => {
    const config: ConfigFile = {
      repos: [
        {
          name: "Libs",
          url: "https://g.com/x.git",
          packageFilter: "MyCompany.*",
          packages: ["MyCompany.Core"],
        },
      ],
    };
    const { env, cwd } = setupConfig(config);
    expect(() => loadConfig(env, cwd)).toThrow(
      /'packageFilter' and 'packages' are mutually exclusive/i,
    );
  });
});

// ── validateBranchName ──

describe("validateBranchName", () => {
  it.each([
    "main",
    "develop",
    "feature/my-branch",
    "release/1.0",
    "hotfix-123",
    "v1.0.0",
    "my_branch",
    "feature/nested/deep",
  ])("accepts valid branch name: %s", (name) => {
    expect(validateBranchName(name)).toBeUndefined();
  });

  it.each([
    ["..evil", "must not contain '..'"],
    ["foo/../bar", "must not contain '..'"],
    ["/leading", "must not start or end with '/'"],
    ["trailing/", "must not start or end with '/'"],
    ["foo//bar", "must not contain '//'"],
    ["-dash-start", "must not start with '-'"],
    ["back\\slash", "must not contain backslashes"],
    ["  ", "must not be empty"],
    ["has space", "invalid characters"],
  ])("rejects invalid branch name: %s (%s)", (name, expectedMsg) => {
    const result = validateBranchName(name);
    expect(result).toBeDefined();
    expect(result).toMatch(new RegExp(expectedMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  });
});

// ── loadConfig — branch ──

describe("loadConfig — branch", () => {
  it("passes branch through to RepoConfig", () => {
    const { env, cwd } = setupConfig(minimalConfig({ branch: "develop" }));
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.branch).toBe("develop");
  });

  it("branch is undefined when omitted", () => {
    const { env, cwd } = setupConfig(minimalConfig());
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.branch).toBeUndefined();
  });

  it("accepts branch with slashes", () => {
    const { env, cwd } = setupConfig(minimalConfig({ branch: "feature/my-work" }));
    const cfg = loadConfig(env, cwd);
    expect(cfg.repos[0]!.branch).toBe("feature/my-work");
  });

  it("rejects invalid branch name", () => {
    const { env, cwd } = setupConfig(minimalConfig({ branch: "../traversal" }));
    expect(() => loadConfig(env, cwd)).toThrow(/branch name must not contain/);
  });

  it("warns when branch is set on local-only repo", () => {
    const config: ConfigFile = {
      localRepos: { bsf: "C:/dev/bsf" },
      repos: [{ name: "bsf", branch: "develop", packages: ["MyCompany.Core"] }],
    };
    const { env, cwd } = setupConfig(config);
    const cfg = loadConfig(env, cwd);
    expect(cfg.warnings.some((w) => w.includes("branch") && w.includes("local-only"))).toBe(true);
  });

  it("does not warn when branch is set on repo with URL", () => {
    const { env, cwd } = setupConfig(minimalConfig({ branch: "develop" }));
    const cfg = loadConfig(env, cwd);
    expect(cfg.warnings.some((w) => w.includes("branch"))).toBe(false);
  });
});
