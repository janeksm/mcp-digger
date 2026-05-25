#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const serverPath = resolve(repoRoot, "server.json");
const server = JSON.parse(readFileSync(serverPath, "utf8"));

server.version = pkg.version;
if (Array.isArray(server.packages) && server.packages[0]) {
  server.packages[0].version = pkg.version;
}
if (server.name !== pkg.mcpName) {
  throw new Error(
    `server.json name "${server.name}" does not match package.json mcpName "${pkg.mcpName}"`,
  );
}

writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json synced to version ${pkg.version}`);
