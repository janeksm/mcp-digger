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
  readFile,
  revParse,
} from "./gitClient.js";

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

/** Init a git repo with one commit containing the given files. */
async function initRepo(
  files: Record<string, string>,
): Promise<string> {
  const repoDir = path.join(tmpDir, "repo-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(repoDir, { recursive: true });

  await execFile("git", ["init", repoDir]);
  await execFile("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execFile("git", ["-C", repoDir, "config", "user.name", "Test"]);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  await execFile("git", ["-C", repoDir, "add", "."]);
  await execFile("git", ["-C", repoDir, "commit", "-m", "initial"]);

  return repoDir;
}

/** Create a non-bare git repo with one commit. */
async function createRepo(files: Record<string, string>): Promise<string> {
  return initRepo(files);
}

/** Create a bare git repo with one commit containing the given files. */
async function createBareRepo(files: Record<string, string>): Promise<string> {
  const workDir = await initRepo(files);
  const bareDir = path.join(tmpDir, "bare-" + Math.random().toString(36).slice(2) + ".git");
  await execFile("git", ["clone", "--bare", workDir, bareDir]);
  return bareDir;
}

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
    const bareDir = await createBareRepo({ "hello.txt": "world" });
    const cloneDir = path.join(tmpDir, "cloned");

    await clone(bareDir, cloneDir, noAuth);

    expect(fs.existsSync(path.join(cloneDir, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(cloneDir, "hello.txt"), "utf-8")).toBe("world");
  });

  it("clones with specified depth", async () => {
    const bareDir = await createBareRepo({ "file.txt": "content" });
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
    const bareDir = await createBareRepo({ "a.txt": "ok" });
    const cloneDir = path.join(tmpDir, "auto-clone");

    await clone(bareDir, cloneDir, autoAuth);

    expect(fs.existsSync(path.join(cloneDir, "a.txt"))).toBe(true);
  });

  it("with strategy 'pat' uses url directly when no PAT (non-HTTPS)", async () => {
    // Local file paths aren't HTTPS, so injectPat returns undefined → uses original URL
    const bareDir = await createBareRepo({ "b.txt": "ok" });
    const cloneDir = path.join(tmpDir, "pat-clone");
    const patAuth: GitAuth = { strategy: "pat", pat: "fake-token" };

    await clone(bareDir, cloneDir, patAuth);

    expect(fs.existsSync(path.join(cloneDir, "b.txt"))).toBe(true);
  });
});

// ── fetch ──

describe("fetch", () => {
  it("fetches latest changes from origin", async () => {
    const bareDir = await createBareRepo({ "file.txt": "v1" });
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
