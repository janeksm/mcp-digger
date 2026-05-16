import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = (rel: string): string =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

const read = (rel: string): string => fs.readFileSync(repoRoot(rel), "utf-8");

const exists = (rel: string): boolean => fs.existsSync(repoRoot(rel));

describe("release metadata (V1)", () => {
  it("package.json version is 1.0.0", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe("1.0.0");
  });

  it("package.json has prepublishOnly script chaining typecheck, lint, test, build", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts?.prepublishOnly).toBe(
      "npm run typecheck && npm run lint && npm test && npm run build",
    );
  });

  it("package-lock.json root and packages[''] version are 1.0.0", () => {
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe("1.0.0");
    expect(lock.packages?.[""]?.version).toBe("1.0.0");
  });

  it("LICENSE names mcp-digger 1.0.0 on the Licensed Work line", () => {
    const license = read("LICENSE");
    expect(license).toMatch(/^Licensed Work: mcp-digger 1\.0\.0$/m);
  });

  it("README mentions both dig_init and dig_refresh and has no stale 8-tool references", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/dig_init/);
    expect(readme).toMatch(/dig_refresh/);
    expect(readme).not.toMatch(/8 tools/i);
    expect(readme).not.toMatch(/Tools \(8\)/);
    expect(readme).not.toMatch(/eight tools/i);
  });

  it("README license footer is not bare MIT and mentions BUSL-1.1", () => {
    const readme = read("README.md");
    expect(readme).not.toMatch(/^MIT\s*$/m);
    expect(readme).toMatch(/BUSL-1\.1/);
  });

  it("CHANGELOG.md exists at repo root with a 1.0.0 heading", () => {
    expect(exists("CHANGELOG.md")).toBe(true);
    const changelog = read("CHANGELOG.md");
    expect(changelog).toMatch(/^##\s*\[?1\.0\.0\]?/m);
  });
});
