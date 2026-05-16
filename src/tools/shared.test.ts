import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cleanupTmpDir, initRepo, makeConfig, makeLocalRepo, makePkg, makeRepoConfig } from "../testHelpers.js";
import {
  FILE_CHAR_LIMIT,
  PACKAGE_NAME_PARAM,
  TOOL_ANNOTATIONS,
  extractErrorMessage,
  requirePackage,
  toCallToolResult,
  toolError,
  toolSuccess,
  withRepoReady,
} from "./shared.js";

// ── Constants ──

describe("shared constants", () => {
  it("FILE_CHAR_LIMIT is one million", () => {
    expect(FILE_CHAR_LIMIT).toBe(1_000_000);
  });

  it("TOOL_ANNOTATIONS marks tools read-only, non-destructive, idempotent, open-world", () => {
    expect(TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("PACKAGE_NAME_PARAM is a zod string schema", () => {
    expect(PACKAGE_NAME_PARAM).toBeInstanceOf(z.ZodString);
    expect(PACKAGE_NAME_PARAM.safeParse("MyCompany.Core").success).toBe(true);
    expect(PACKAGE_NAME_PARAM.safeParse(123).success).toBe(false);
  });
});

// ── toolSuccess / toolError ──

describe("toolSuccess / toolError", () => {
  it("toolSuccess sets isError to false", () => {
    const r = toolSuccess("ok");
    expect(r).toEqual({ text: "ok", isError: false });
  });

  it("toolError sets isError to true", () => {
    const r = toolError("bad");
    expect(r).toEqual({ text: "bad", isError: true });
  });
});

// ── toCallToolResult ──

describe("toCallToolResult", () => {
  it("returns content array with text payload on success", () => {
    const wire = toCallToolResult(toolSuccess("hello"));
    expect(wire).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("omits isError field on success", () => {
    const wire = toCallToolResult(toolSuccess("hello"));
    expect("isError" in wire).toBe(false);
  });

  it("sets isError to true on error", () => {
    const wire = toCallToolResult(toolError("oops"));
    expect(wire).toEqual({
      content: [{ type: "text", text: "oops" }],
      isError: true,
    });
  });
});

// ── extractErrorMessage ──

describe("extractErrorMessage", () => {
  it("returns message from Error instance", () => {
    expect(extractErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("preserves message from Error subclass", () => {
    class MyError extends Error {
      constructor() {
        super("custom");
      }
    }
    expect(extractErrorMessage(new MyError())).toBe("custom");
  });

  it("stringifies non-Error values", () => {
    expect(extractErrorMessage("plain string")).toBe("plain string");
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(undefined)).toBe("undefined");
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("stringifies plain object", () => {
    expect(extractErrorMessage({ a: 1 })).toBe("[object Object]");
  });
});

// ── requirePackage ──

describe("requirePackage", () => {
  it("returns pkg + repo for a known package", () => {
    const cacheDir = "/tmp/cache";
    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", "/tmp/repo", [pkg], "/tmp", "src");
    const config = makeConfig([repo], "/tmp", cacheDir);

    const result = requirePackage(config, "MyLib");

    expect("pkg" in result && "repo" in result).toBe(true);
    if ("pkg" in result) {
      expect(result.pkg.name).toBe("MyLib");
      expect(result.repo.name).toBe("myrepo");
    }
  });

  it("returns toolError with available packages for unknown name", () => {
    const cacheDir = "/tmp/cache";
    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", "/tmp/repo", [pkg], "/tmp", "src");
    const config = makeConfig([repo], "/tmp", cacheDir);

    const result = requirePackage(config, "NotReal");

    expect("isError" in result && result.isError).toBe(true);
    if ("isError" in result) {
      expect(result.text).toContain("Unknown package 'NotReal'");
      expect(result.text).toContain("MyLib");
    }
  });

  it("returns toolError when no packages configured", () => {
    const config = makeConfig([], "/tmp", "/tmp/cache");

    const result = requirePackage(config, "Anything");

    expect("isError" in result && result.isError).toBe(true);
    if ("isError" in result) {
      expect(result.text).toContain("Unknown package 'Anything'");
      expect(result.text).toContain("No packages are configured");
    }
  });
});

// ── withRepoReady ──

describe("withRepoReady", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-shared-"));
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("invokes callback with ensureReady result on success", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/File.cs": "namespace MyLib;\npublic class C {}\n",
    });
    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await withRepoReady(repo, config, "test-tool", async (ready) => {
      expect(ready.sourcePath).toBe(repoDir);
      expect(ready.mode).toBe("local");
      expect(ready.currentHash).toMatch(/^[a-f0-9]{40}$/);
      return toolSuccess("ran");
    });

    expect(result).toEqual({ text: "ran", isError: false });
  });

  it("returns toolError with repo name prefix when ensureReady throws", async () => {
    const repo = makeRepoConfig(
      { name: "badrepo", localPath: path.join(tmpDir, "does-not-exist") },
      tmpDir,
    );
    const config = makeConfig([repo], tmpDir, path.join(tmpDir, "cache"));

    const result = await withRepoReady(repo, config, "test-tool", async () => {
      throw new Error("callback should not run");
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Repo 'badrepo'");
  });

  it("propagates callback errors through extractErrorMessage", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const repoDir = await initRepo(tmpDir, {
      "src/MyLib/File.cs": "namespace MyLib;\npublic class C {}\n",
    });
    const pkg = makePkg("MyLib", "myrepo", "src", cacheDir);
    const repo = makeLocalRepo("myrepo", repoDir, [pkg], tmpDir);
    const config = makeConfig([repo], tmpDir, cacheDir);

    const result = await withRepoReady(repo, config, "test-tool", async () => {
      throw new Error("callback exploded");
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Repo 'myrepo': callback exploded");
  });
});
