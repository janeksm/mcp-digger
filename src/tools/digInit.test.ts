import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digInit } from "./digInit.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-digger-dig-init-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("digInit", () => {
  it("creates config file with valid JSON when no config exists", () => {
    const configPath = path.join(tmpDir, ".digger", "config.json");

    const result = digInit(configPath);

    expect(result.isError).toBe(false);
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
  });

  it("created config contains repos array with sample entry", () => {
    const configPath = path.join(tmpDir, ".digger", "config.json");

    digInit(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(Array.isArray(parsed.repos)).toBe(true);
    expect(parsed.repos.length).toBe(1);
    expect(parsed.repos[0]).toHaveProperty("name");
    expect(parsed.repos[0]).toHaveProperty("url");
    expect(parsed.repos[0]).toHaveProperty("packages");
  });

  it("returns success message mentioning restart", () => {
    const configPath = path.join(tmpDir, ".digger", "config.json");

    const result = digInit(configPath);

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/restart/i);
    expect(result.text).toContain(configPath);
  });

  it("creates .digger directory if it does not exist", () => {
    const diggerDir = path.join(tmpDir, ".digger");
    const configPath = path.join(diggerDir, "config.json");

    expect(fs.existsSync(diggerDir)).toBe(false);

    digInit(configPath);

    expect(fs.existsSync(diggerDir)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("returns error when config file already exists", () => {
    const configPath = path.join(tmpDir, ".digger", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");

    const result = digInit(configPath);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/already exists/i);
  });

  it("does not overwrite existing config", () => {
    const configPath = path.join(tmpDir, ".digger", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"custom": true}');

    digInit(configPath);

    const content = fs.readFileSync(configPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ custom: true });
  });

  it("returns error when .digger exists as a file", () => {
    const diggerPath = path.join(tmpDir, ".digger");
    fs.writeFileSync(diggerPath, "not a directory");
    const configPath = path.join(diggerPath, "config.json");

    const result = digInit(configPath);

    expect(result.isError).toBe(true);
  });

  it("works when config path is in a custom location", () => {
    const configPath = path.join(tmpDir, "custom", "dir", "my-config.json");

    const result = digInit(configPath);

    expect(result.isError).toBe(false);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});
