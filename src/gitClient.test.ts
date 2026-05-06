import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitAuth } from "./config.js";
import {
  GitError,
  clone,
  fetch,
  injectPat,
  isValidRepo,
  listFiles,
  lsRemote,
  readFile,
  revParse,
} from "./gitClient.js";
import { createBareRepo, createBareRepoWithBranch, initRepo } from "./testHelpers.js";

const execFile = util.promisify(child_process.execFile);

// ── Test helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-git-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const noAuth: GitAuth = { strategy: "none" };
const autoAuth: GitAuth = { strategy: "auto" };

const createRepo = (files: Record<string, string>) => initRepo(tmpDir, files);
const createBare = (files: Record<string, string>) => createBareRepo(tmpDir, files);
const createBareWithBranch = (
  defaultFiles: Record<string, string>,
  branchName: string,
  branchFiles: Record<string, string>,
) => createBareRepoWithBranch(tmpDir, defaultFiles, branchName, branchFiles);

// ── injectPat ──

describe("injectPat", () => {
  it("injects oauth2 credentials into HTTPS URL", () => {
    const result = injectPat("https://gitlab.example.com/group/repo.git", "my-token");
    expect(result).toBe("https://oauth2:my-token@gitlab.example.com/group/repo.git");
  });

  it("replaces existing credentials in HTTPS URL", () => {
    const result = injectPat("https://old:cred@gitlab.example.com/repo.git", "new-token");
    expect(result).toBe("https://oauth2:new-token@gitlab.example.com/repo.git");
  });

  it("returns undefined for SSH URLs", () => {
    expect(injectPat("git@gitlab.example.com:group/repo.git", "tok")).toBeUndefined();
  });

  it("returns undefined for file:// URLs", () => {
    expect(injectPat("file:///local/path", "tok")).toBeUndefined();
  });

  it("returns undefined for invalid URLs", () => {
    expect(injectPat("not-a-url", "tok")).toBeUndefined();
  });

  it("handles URL-unsafe characters in PAT", () => {
    const result = injectPat("https://gitlab.com/repo.git", "tok/with=special&chars");
    expect(result).toContain("gitlab.com");
    // URL class percent-encodes special chars in the href, but decodeURIComponent recovers them
    const parsed = new URL(result!);
    expect(decodeURIComponent(parsed.password)).toBe("tok/with=special&chars");
  });
});

// ── clone ──

describe("clone", () => {
  it("clones a local bare repo", async () => {
    const bareDir = await createBare({ "hello.txt": "world" });
    const cloneDir = path.join(tmpDir, "cloned");

    await clone(bareDir, cloneDir, noAuth);

    expect(fs.existsSync(path.join(cloneDir, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(cloneDir, "hello.txt"), "utf-8")).toBe("world");
  });

  it("clones with specified depth", async () => {
    const bareDir = await createBare({ "file.txt": "content" });
    const cloneDir = path.join(tmpDir, "shallow");

    await clone(bareDir, cloneDir, noAuth, 1);

    const { stdout } = await execFile("git", ["-C", cloneDir, "rev-list", "--count", "HEAD"]);
    expect(stdout.trim()).toBe("1");
  });

  it("throws GitError when cloning invalid URL", async () => {
    const cloneDir = path.join(tmpDir, "fail");

    await expect(clone("/nonexistent/repo.git", cloneDir, noAuth)).rejects.toThrow(GitError);
  });

  it("with strategy 'auto' succeeds on accessible repo without PAT", async () => {
    const bareDir = await createBare({ "a.txt": "ok" });
    const cloneDir = path.join(tmpDir, "auto-clone");

    await clone(bareDir, cloneDir, autoAuth);

    expect(fs.existsSync(path.join(cloneDir, "a.txt"))).toBe(true);
  });

  it("with strategy 'pat' uses url directly when no PAT (non-HTTPS)", async () => {
    // Local file paths aren't HTTPS, so injectPat returns undefined → uses original URL
    const bareDir = await createBare({ "b.txt": "ok" });
    const cloneDir = path.join(tmpDir, "pat-clone");
    const patAuth: GitAuth = { strategy: "pat", pat: "fake-token" };

    await clone(bareDir, cloneDir, patAuth);

    expect(fs.existsSync(path.join(cloneDir, "b.txt"))).toBe(true);
  });
});

// ── fetch ──

describe("fetch", () => {
  it("fetches latest changes from origin", async () => {
    const bareDir = await createBare({ "file.txt": "v1" });
    const cloneDir = path.join(tmpDir, "to-fetch");
    await clone(bareDir, cloneDir, noAuth);

    const hashBefore = await revParse(cloneDir, "HEAD");

    // Push a new commit to bare repo via a temp working copy
    const pushDir = path.join(tmpDir, "pusher");
    await execFile("git", ["clone", bareDir, pushDir]);
    await execFile("git", ["-C", pushDir, "config", "user.email", "test@test.com"]);
    await execFile("git", ["-C", pushDir, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(pushDir, "file.txt"), "v2");
    await execFile("git", ["-C", pushDir, "add", "."]);
    await execFile("git", ["-C", pushDir, "commit", "-m", "update"]);
    await execFile("git", ["-C", pushDir, "push"]);

    await fetch(cloneDir, noAuth);

    // After fetch, FETCH_HEAD should point to the new commit
    const fetchHead = await revParse(cloneDir, "FETCH_HEAD");
    expect(fetchHead).not.toBe(hashBefore);
  });

  it("throws GitError when repo has no origin", async () => {
    const repoDir = await createRepo({ "a.txt": "x" });
    // createRepo has no origin, so fetch should fail
    await expect(fetch(repoDir, noAuth)).rejects.toThrow(GitError);
  });
});

// ── revParse ──

describe("revParse", () => {
  it("returns HEAD commit hash", async () => {
    const repoDir = await createRepo({ "file.txt": "content" });

    const hash = await revParse(repoDir, "HEAD");

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("throws for invalid ref", async () => {
    const repoDir = await createRepo({ "file.txt": "content" });

    await expect(revParse(repoDir, "NONEXISTENT_REF")).rejects.toThrow(GitError);
  });
});

// ── isValidRepo ──

describe("isValidRepo", () => {
  it("returns true for a git repo", async () => {
    const repoDir = await createRepo({ "file.txt": "x" });

    expect(await isValidRepo(repoDir)).toBe(true);
  });

  it("returns false for a non-repo directory", async () => {
    const dir = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(dir, { recursive: true });

    await expect(isValidRepo(dir)).resolves.toBe(false);
  });

  it("returns false for nonexistent path", async () => {
    await expect(isValidRepo(path.join(tmpDir, "nope"))).resolves.toBe(false);
  });
});

// ── readFile ──

describe("readFile", () => {
  it("reads a committed file from HEAD", async () => {
    const repoDir = await createRepo({
      "src/MyLib/Class1.cs": "namespace MyLib;\npublic class Class1 { }",
    });

    const content = await readFile(repoDir, "src/MyLib/Class1.cs");

    expect(content).toBe("namespace MyLib;\npublic class Class1 { }");
  });

  it("reads a file in a subdirectory", async () => {
    const repoDir = await createRepo({
      "deep/nested/file.txt": "found it",
    });

    const content = await readFile(repoDir, "deep/nested/file.txt");

    expect(content).toBe("found it");
  });

  it("throws GitError for nonexistent file", async () => {
    const repoDir = await createRepo({ "exists.txt": "yes" });

    await expect(readFile(repoDir, "nope.txt")).rejects.toThrow(GitError);
  });

  it("rejects path traversal with '..' segments", async () => {
    const repoDir = await createRepo({ "exists.txt": "yes" });

    await expect(readFile(repoDir, "../escape")).rejects.toThrow("unsafe file path");
    await expect(readFile(repoDir, "sub/../../escape")).rejects.toThrow("unsafe file path");
  });

  it("allows '..' within segment names (not traversal)", async () => {
    const repoDir = await createRepo({ "My..Lib/A.cs": "content" });

    const content = await readFile(repoDir, "My..Lib/A.cs");

    expect(content).toBe("content");
  });

  it("rejects paths containing null bytes", async () => {
    const repoDir = await createRepo({ "exists.txt": "yes" });

    await expect(readFile(repoDir, "file\0.txt")).rejects.toThrow("unsafe file path");
  });
});

// ── listFiles ──

describe("listFiles", () => {
  it("lists all tracked files", async () => {
    const repoDir = await createRepo({
      "a.txt": "1",
      "src/b.cs": "2",
      "src/c.cs": "3",
    });

    const files = await listFiles(repoDir);

    expect(files).toContain("a.txt");
    expect(files).toContain("src/b.cs");
    expect(files).toContain("src/c.cs");
    expect(files).toHaveLength(3);
  });

  it("filters by pathspec pattern", async () => {
    const repoDir = await createRepo({
      "readme.md": "x",
      "src/A.cs": "1",
      "src/B.cs": "2",
      "tests/T.cs": "3",
    });

    const files = await listFiles(repoDir, "src/");

    expect(files).toContain("src/A.cs");
    expect(files).toContain("src/B.cs");
    expect(files).not.toContain("readme.md");
    expect(files).not.toContain("tests/T.cs");
  });

  it("returns empty array for empty pattern match", async () => {
    const repoDir = await createRepo({ "file.txt": "x" });

    const files = await listFiles(repoDir, "nonexistent/");

    expect(files).toEqual([]);
  });
});

// ── GitError ──

describe("GitError", () => {
  it("has name, message, exitCode, and stderr", async () => {
    const repoDir = await createRepo({ "file.txt": "x" });

    try {
      await revParse(repoDir, "DOES_NOT_EXIST");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      const gitErr = err as GitError;
      expect(gitErr.name).toBe("GitError");
      expect(gitErr.message).toContain("failed");
      expect(gitErr.stderr).toBeDefined();
    }
  });
});

// ── PAT redaction on clone/fetch errors ──

describe("PAT redaction", () => {
  const PAT = "glpat-SECRET-TOKEN-xyz123";

  it("redacts PAT from clone error message when strategy='pat'", async () => {
    // Unreachable HTTPS URL so clone fails and git stderr echoes the auth URL
    const unreachable = "https://nonexistent.invalid.example/repo.git";
    const cloneDir = path.join(tmpDir, "pat-fail");
    const patAuth: GitAuth = { strategy: "pat", pat: PAT };

    try {
      await clone(unreachable, cloneDir, patAuth);
      expect.fail("clone should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      const gitErr = err as GitError;
      // The PAT must not appear anywhere in the surfaced error
      expect(gitErr.message).not.toContain(PAT);
      expect(gitErr.stderr).not.toContain(PAT);
    }
  });

  it("redacts PAT on the auto-strategy PAT retry", async () => {
    // Unreachable HTTPS URL — unauthenticated attempt fails (unredacted, no PAT
    // in URL so nothing to leak), then PAT retry fails and must redact.
    const unreachable = "https://nonexistent.invalid.example/repo.git";
    const cloneDir = path.join(tmpDir, "auto-pat-fail");
    const autoWithPat: GitAuth = { strategy: "auto", pat: PAT };

    try {
      await clone(unreachable, cloneDir, autoWithPat);
      expect.fail("clone should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      const gitErr = err as GitError;
      expect(gitErr.message).not.toContain(PAT);
      expect(gitErr.stderr).not.toContain(PAT);
    }
  });

  it("does not affect errors when no PAT is used", async () => {
    // Plain error path — unchanged behaviour, no PAT involved
    const cloneDir = path.join(tmpDir, "noauth-fail");
    try {
      await clone("/nonexistent/repo.git", cloneDir, noAuth);
      expect.fail("clone should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).message).toContain("failed");
    }
  });
});

// ── lsRemote ──

describe("lsRemote", () => {
  it("returns reachable with ref count for a local bare repo", async () => {
    const bareDir = await createBare({ "file.txt": "content" });

    const result = await lsRemote(bareDir, noAuth);

    expect(result.reachable).toBe(true);
    expect(result.refCount).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
    expect(result.attempts).toContain("unauthenticated");
  });

  it("returns unreachable with error for nonexistent path", async () => {
    const result = await lsRemote("/nonexistent/repo.git", noAuth);

    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("failed");
  });

  it("tracks attempts for auto strategy", async () => {
    const bareDir = await createBare({ "file.txt": "content" });

    const result = await lsRemote(bareDir, autoAuth);

    expect(result.reachable).toBe(true);
    expect(result.attempts).toContain("unauthenticated");
  });

  it("reports isHttps correctly", async () => {
    const bareDir = await createBare({ "file.txt": "x" });

    const localResult = await lsRemote(bareDir, noAuth);
    expect(localResult.isHttps).toBe(false);

    // Unreachable HTTPS URL to test isHttps=true
    const httpsResult = await lsRemote("https://nonexistent.invalid.example/repo.git", noAuth);
    expect(httpsResult.isHttps).toBe(true);
  });

  it("redacts PAT from error when strategy is pat", async () => {
    const PAT = "glpat-SECRET-LSREMOTE-xyz";
    const patAuth: GitAuth = { strategy: "pat", pat: PAT };

    const result = await lsRemote("https://nonexistent.invalid.example/repo.git", patAuth);

    expect(result.reachable).toBe(false);
    expect(result.error).not.toContain(PAT);
    expect(result.attempts).toContain("pat");
  });

  it("redacts PAT from error on auto-strategy retry", async () => {
    const PAT = "glpat-SECRET-AUTO-xyz";
    const autoWithPat: GitAuth = { strategy: "auto", pat: PAT };

    const result = await lsRemote("https://nonexistent.invalid.example/repo.git", autoWithPat);

    expect(result.reachable).toBe(false);
    expect(result.error).not.toContain(PAT);
    expect(result.attempts).toContain("unauthenticated");
    expect(result.attempts).toContain("pat");
  });
});

// ── clone with branch ──

describe("clone — branch", () => {
  it("clones a specific branch", async () => {
    const bareDir = await createBareWithBranch(
      { "default.txt": "on-default" },
      "develop",
      { "develop.txt": "on-develop" },
    );
    const cloneDir = path.join(tmpDir, "branch-clone");

    await clone(bareDir, cloneDir, noAuth, 1, "develop");

    expect(fs.existsSync(path.join(cloneDir, "develop.txt"))).toBe(true);
    const { stdout } = await execFile("git", ["-C", cloneDir, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(stdout.trim()).toBe("develop");
  });

  it("clones default branch when branch is undefined", async () => {
    const bareDir = await createBareWithBranch(
      { "default.txt": "on-default" },
      "develop",
      { "develop.txt": "on-develop" },
    );
    const cloneDir = path.join(tmpDir, "default-clone");

    await clone(bareDir, cloneDir, noAuth);

    expect(fs.existsSync(path.join(cloneDir, "default.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cloneDir, "develop.txt"))).toBe(false);
  });

  it("throws GitError for nonexistent branch", async () => {
    const bareDir = await createBare({ "file.txt": "content" });
    const cloneDir = path.join(tmpDir, "bad-branch");

    await expect(clone(bareDir, cloneDir, noAuth, 1, "nonexistent-branch")).rejects.toThrow(GitError);
  });
});

// ── fetch with branch ──

describe("fetch — branch", () => {
  it("fetches a specific branch", async () => {
    const bareDir = await createBareWithBranch(
      { "default.txt": "on-default" },
      "develop",
      { "develop.txt": "on-develop" },
    );
    const cloneDir = path.join(tmpDir, "fetch-branch");
    await clone(bareDir, cloneDir, noAuth, 1, "develop");

    const hashBefore = await revParse(cloneDir, "HEAD");

    // Push a new commit to the develop branch via a temp working copy
    const pushDir = path.join(tmpDir, "pusher");
    await execFile("git", ["clone", "-b", "develop", bareDir, pushDir]);
    await execFile("git", ["-C", pushDir, "config", "user.email", "test@test.com"]);
    await execFile("git", ["-C", pushDir, "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(pushDir, "new-file.txt"), "new content");
    await execFile("git", ["-C", pushDir, "add", "."]);
    await execFile("git", ["-C", pushDir, "commit", "-m", "update develop"]);
    await execFile("git", ["-C", pushDir, "push"]);

    await fetch(cloneDir, noAuth, undefined, "develop");

    const fetchHead = await revParse(cloneDir, "FETCH_HEAD");
    expect(fetchHead).not.toBe(hashBefore);
  });
});
