import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = (rel: string): string =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

const read = (rel: string): string => fs.readFileSync(repoRoot(rel), "utf-8");

const exists = (rel: string): boolean => fs.existsSync(repoRoot(rel));

describe("release metadata (V1)", () => {
  it("package.json version is a valid semver string", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("package.json has prepublishOnly script chaining typecheck, lint, test, build", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts?.prepublishOnly).toBe(
      "npm run typecheck && npm run lint && npm test && npm run build",
    );
  });

  it("package-lock.json root and packages[''] version match package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version).toBe(pkg.version);
  });

  it("README mentions both dig_init and dig_refresh and has no stale 8-tool references", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/dig_init/);
    expect(readme).toMatch(/dig_refresh/);
    expect(readme).not.toMatch(/8 tools/i);
    expect(readme).not.toMatch(/Tools \(8\)/);
    expect(readme).not.toMatch(/eight tools/i);
  });

  it("README license footer mentions MIT and links LICENSE", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/MIT License/);
    expect(readme).toMatch(/\[LICENSE\]\(LICENSE\)/);
  });

  it("LICENSE is MIT and names the copyright holder", () => {
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License/m);
    expect(license).toMatch(/Janeks Malinovskis/);
  });

  it("package.json declares MIT license", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.license).toBe("MIT");
  });

  it("CHANGELOG.md exists at repo root with a 1.0.0 heading", () => {
    expect(exists("CHANGELOG.md")).toBe(true);
    const changelog = read("CHANGELOG.md");
    expect(changelog).toMatch(/^##\s*\[?1\.0\.0\]?/m);
  });

  it("server.json version + packages[0].version match package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const server = JSON.parse(read("server.json"));
    expect(server.version).toBe(pkg.version);
    expect(server.packages?.[0]?.version).toBe(pkg.version);
  });

  it("server.json name matches package.json mcpName", () => {
    const pkg = JSON.parse(read("package.json"));
    const server = JSON.parse(read("server.json"));
    expect(pkg.mcpName).toBeTruthy();
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.mcpName).toMatch(/^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/i);
  });
});
