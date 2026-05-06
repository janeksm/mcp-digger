import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackageConfig } from "./config.js";
import {
  invalidate,
  isFresh,
  markFresh,
  readIndex,
  readOverview,
  readSignatures,
  writeIndex,
  writeOverview,
  writeSignature,
} from "./cacheManager.js";

// ── Test helpers ──

let tmpDir: string;
let cacheDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-cache-test-"));
  cacheDir = path.join(tmpDir, "cache");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePkg(name: string, repoName: string = "myrepo"): PackageConfig {
  return {
    name,
    repoName,
    pathInRepo: `src/${name}`,
    cachePath: path.join(cacheDir, name),
  };
}

// ── isFresh / markFresh ──

describe("isFresh / markFresh", () => {
  it("returns false when no meta exists", async () => {
    expect(await isFresh(cacheDir, "myrepo", "abc123")).toBe(false);
  });

  it("returns true when hash matches", async () => {
    await markFresh(cacheDir, "myrepo", "abc123");

    expect(await isFresh(cacheDir, "myrepo", "abc123")).toBe(true);
  });

  it("returns false when hash differs", async () => {
    await markFresh(cacheDir, "myrepo", "abc123");

    expect(await isFresh(cacheDir, "myrepo", "def456")).toBe(false);
  });

  it("updates hash on re-mark", async () => {
    await markFresh(cacheDir, "myrepo", "old");
    await markFresh(cacheDir, "myrepo", "new");

    expect(await isFresh(cacheDir, "myrepo", "old")).toBe(false);
    expect(await isFresh(cacheDir, "myrepo", "new")).toBe(true);
  });

  it("handles multiple repos independently", async () => {
    await markFresh(cacheDir, "repo-a", "hash-a");
    await markFresh(cacheDir, "repo-b", "hash-b");

    expect(await isFresh(cacheDir, "repo-a", "hash-a")).toBe(true);
    expect(await isFresh(cacheDir, "repo-b", "hash-b")).toBe(true);
    expect(await isFresh(cacheDir, "repo-a", "hash-b")).toBe(false);
  });

  it("safeRepoSlug strips trailing wildcards for defense-in-depth", async () => {
    await markFresh(cacheDir, "BSF.*", "abc123");

    expect(await isFresh(cacheDir, "BSF.*", "abc123")).toBe(true);
    expect(await isFresh(cacheDir, "BSF.*", "other")).toBe(false);

    const metaDir = path.join(cacheDir, "meta");
    const files = fs.readdirSync(metaDir);
    expect(files).toEqual(["BSF.json"]);
  });

  it("returns false for corrupted meta file", async () => {
    const metaDir = path.join(cacheDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, "myrepo.json"), "not json");

    expect(await isFresh(cacheDir, "myrepo", "anything")).toBe(false);
  });

  it("returns false for meta file missing commitHash", async () => {
    const metaDir = path.join(cacheDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, "myrepo.json"), '{"updatedAt":"2026-01-01"}');

    expect(await isFresh(cacheDir, "myrepo", "anything")).toBe(false);
  });

  it("ignores __proto__ keys in meta JSON (prototype-pollution defense)", async () => {
    const metaDir = path.join(cacheDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, "myrepo.json"),
      '{"commitHash":"abc123","__proto__":{"polluted":true}}',
    );

    expect(await isFresh(cacheDir, "myrepo", "abc123")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ── invalidate ──

describe("invalidate", () => {
  it("removes meta file and package cache dirs", async () => {
    const pkg1 = makePkg("MyLib");
    const pkg2 = makePkg("MyUtils");
    await markFresh(cacheDir, "myrepo", "abc");
    await writeOverview(pkg1, "# MyLib");
    await writeOverview(pkg2, "# MyUtils");

    await invalidate(cacheDir, "myrepo", [pkg1, pkg2]);

    expect(await isFresh(cacheDir, "myrepo", "abc")).toBe(false);
    expect(await readOverview(pkg1)).toBeUndefined();
    expect(await readOverview(pkg2)).toBeUndefined();
  });

  it("only invalidates packages belonging to the specified repo", async () => {
    const pkg1 = makePkg("PkgA", "repo1");
    const pkg2 = makePkg("PkgB", "repo2");
    await markFresh(cacheDir, "repo1", "h1");
    await markFresh(cacheDir, "repo2", "h2");
    await writeOverview(pkg1, "# A");
    await writeOverview(pkg2, "# B");

    await invalidate(cacheDir, "repo1", [pkg1, pkg2]);

    expect(await isFresh(cacheDir, "repo1", "h1")).toBe(false);
    expect(await readOverview(pkg1)).toBeUndefined();
    // repo2's cache is untouched
    expect(await isFresh(cacheDir, "repo2", "h2")).toBe(true);
    expect(await readOverview(pkg2)).toBe("# B");
  });

  it("is a no-op when nothing is cached", async () => {
    const pkg = makePkg("NoPkg");

    // Should not throw
    await invalidate(cacheDir, "myrepo", [pkg]);
  });
});

// ── writeOverview / readOverview ──

describe("writeOverview / readOverview", () => {
  it("round-trips overview content", async () => {
    const pkg = makePkg("MyLib");
    const content = "# MyLib\n\nCore utilities.";

    await writeOverview(pkg, content);
    const result = await readOverview(pkg);

    expect(result).toBe(content);
  });

  it("returns undefined when no overview cached", async () => {
    const pkg = makePkg("NoPkg");

    expect(await readOverview(pkg)).toBeUndefined();
  });

  it("overwrites existing overview", async () => {
    const pkg = makePkg("MyLib");

    await writeOverview(pkg, "old");
    await writeOverview(pkg, "new");

    expect(await readOverview(pkg)).toBe("new");
  });
});

// ── writeSignature / readSignatures ──

describe("writeSignature / readSignatures", () => {
  it("round-trips a single signature file", async () => {
    const pkg = makePkg("MyLib");

    await writeSignature(pkg, "src/MyLib/IService.cs", "public interface IService { }");
    const sigs = await readSignatures(pkg);

    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.filePath).toBe("src/MyLib/IService.cs");
    expect(sigs[0]!.content).toBe("public interface IService { }");
  });

  it("handles multiple files in nested directories", async () => {
    const pkg = makePkg("MyLib");

    await writeSignature(pkg, "src/MyLib/Models/User.cs", "public class User { }");
    await writeSignature(pkg, "src/MyLib/Services/Auth.cs", "public class Auth { }");
    await writeSignature(pkg, "src/MyLib/ICore.cs", "public interface ICore { }");

    const sigs = await readSignatures(pkg);

    expect(sigs).toHaveLength(3);
    expect(sigs[0]!.filePath).toBe("src/MyLib/ICore.cs");
    expect(sigs[1]!.filePath).toBe("src/MyLib/Models/User.cs");
    expect(sigs[2]!.filePath).toBe("src/MyLib/Services/Auth.cs");
  });

  it("returns empty array when no signatures cached", async () => {
    const pkg = makePkg("NoPkg");

    expect(await readSignatures(pkg)).toEqual([]);
  });

  it("overwrites existing signature", async () => {
    const pkg = makePkg("MyLib");

    await writeSignature(pkg, "src/MyLib/A.cs", "v1");
    await writeSignature(pkg, "src/MyLib/A.cs", "v2");

    const sigs = await readSignatures(pkg);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.content).toBe("v2");
  });
});

// ── writeIndex / readIndex ──

describe("writeIndex / readIndex", () => {
  it("round-trips index content", async () => {
    const pkg = makePkg("MyLib");
    const content = "FooService|class|Services/FooService.cs\nIFoo|interface|IFoo.cs";

    await writeIndex(pkg, content);
    const result = await readIndex(pkg);

    expect(result).toBe(content);
  });

  it("returns undefined when no index cached", async () => {
    const pkg = makePkg("NoPkg");

    expect(await readIndex(pkg)).toBeUndefined();
  });

  it("overwrites existing index", async () => {
    const pkg = makePkg("MyLib");

    await writeIndex(pkg, "old");
    await writeIndex(pkg, "new");

    expect(await readIndex(pkg)).toBe("new");
  });

  it("leaves no .tmp file after writing", async () => {
    const pkg = makePkg("MyLib");

    await writeIndex(pkg, "content");

    const files = fs.readdirSync(pkg.cachePath);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("index.dat");
  });
});

// ── Integration: full cycle ──

describe("full cache cycle", () => {
  it("mark fresh → write cache → check fresh → invalidate → stale", async () => {
    const pkg = makePkg("MyLib");
    const hash = "abc123def456";

    // Fresh after marking
    await markFresh(cacheDir, "myrepo", hash);
    expect(await isFresh(cacheDir, "myrepo", hash)).toBe(true);

    // Write cached content
    await writeOverview(pkg, "# Overview");
    await writeIndex(pkg, "FooService|class|Foo.cs");

    // Content is readable
    expect(await readOverview(pkg)).toBe("# Overview");
    expect(await readIndex(pkg)).toBe("FooService|class|Foo.cs");

    // Invalidate
    await invalidate(cacheDir, "myrepo", [pkg]);

    // Now stale and empty
    expect(await isFresh(cacheDir, "myrepo", hash)).toBe(false);
    expect(await readOverview(pkg)).toBeUndefined();
    expect(await readIndex(pkg)).toBeUndefined();
  });
});

// ── Atomic write ──

describe("markFresh atomic write", () => {
  it("leaves no .tmp file after writing", async () => {
    await markFresh(cacheDir, "myrepo", "abc123");

    const metaDir = path.join(cacheDir, "meta");
    const files = fs.readdirSync(metaDir);
    expect(files).toEqual(["myrepo.json"]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("writes valid JSON that isFresh can read", async () => {
    await markFresh(cacheDir, "myrepo", "abc123");
    expect(await isFresh(cacheDir, "myrepo", "abc123")).toBe(true);
  });
});
