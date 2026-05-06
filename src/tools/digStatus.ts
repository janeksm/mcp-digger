import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterPrefix, type DiggerConfig, type GitAuth, type RepoConfig } from "../config.js";
import { TOOL_ANNOTATIONS, extractErrorMessage } from "./shared.js";
import * as gitClient from "../gitClient.js";
import type { LsRemoteResult } from "../gitClient.js";
import { debug, error } from "../logger.js";
import {
  readScanCache,
  scanCachePath,
  scanWorkspace,
  writeScanCache,
  type ScanResult,
} from "../solutionScanner.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Health-check tool — validates mcp-digger configuration and tests git connectivity
for all configured repositories. Call this to verify setup is correct, diagnose
auth or network issues, or confirm repos are reachable before digging into source.`;

// ── Public API ──

export function registerDigStatus(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_status",
    {
      title: "Dig Status",
      description: DESCRIPTION,
      annotations: TOOL_ANNOTATIONS,
    },
    async () => ({
      content: [{ type: "text" as const, text: await digStatus(config) }],
    }),
  );
}

/**
 * Generate a health-check report for config and repo connectivity.
 *
 * Never throws — returns a usable response even when repos are unreachable.
 */
export async function digStatus(config: DiggerConfig): Promise<string> {
  debug("digStatus", "called");
  const sections: string[] = [];
  let issueCount = 0;

  // ── Config summary ──
  sections.push("# mcp-digger status");
  sections.push("## Configuration");
  sections.push(`- **Config file:** ${config.configPath}`);
  sections.push(`- **Repos:** ${config.repos.length}`);

  if (config.warnings.length > 0) {
    sections.push(`- **Config warnings:**`);
    for (const w of config.warnings) {
      sections.push(`  - ${w}`);
    }
  }

  // ── Workspace scan ──
  // Prefer the cache (cheap). If no cache exists yet but we have wildcard
  // repos, run the scan now so the health report is useful on first call.
  const hasWildcard = config.repos.some((r) => r.discoveryMode === "wildcard");
  let scan: ScanResult | null = await readScanCache(config.cacheDir);
  if (!scan && hasWildcard) {
    try {
      scan = await scanWorkspace(config.workspaceRoot);
      await writeScanCache(config.cacheDir, scan);
    } catch (err) {
      const msg = extractErrorMessage(err);
      error("digStatus", "scan failed:", msg);
    }
  }
  if (scan) {
    sections.push("");
    sections.push("## Workspace scan");
    sections.push(`- **Last scanned:** ${scan.scannedAt}`);
    const slnCount = scan.solutionFiles.filter((f) =>
      f.toLowerCase().endsWith(".sln"),
    ).length;
    const slnxCount = scan.solutionFiles.length - slnCount;
    sections.push(
      `- **Solution files:** ${scan.solutionFiles.length} (.sln: ${slnCount}, .slnx: ${slnxCount})`,
    );
    sections.push(
      `- **Directory.Packages.props:** ${scan.directoryPackagesProps.length}${formatRelPaths(scan.directoryPackagesProps, scan.workspaceRoot)}`,
    );
    sections.push(
      `- **Directory.Build.props:** ${scan.directoryBuildProps.length}${formatRelPaths(scan.directoryBuildProps, scan.workspaceRoot)}`,
    );
    sections.push(
      `- **Directory.Build.targets:** ${scan.directoryBuildTargets.length}${formatRelPaths(scan.directoryBuildTargets, scan.workspaceRoot)}`,
    );
    sections.push(`- **csproj files resolved:** ${scan.csprojFiles.length}`);
    sections.push(`- **Total referenced packages:** ${scan.packages.length}`);
    sections.push(`- **Cache file:** ${scanCachePath(config.cacheDir)}`);
    if (scan.warnings.length > 0) {
      sections.push(`- **Scan warnings:**`);
      for (const w of scan.warnings) {
        sections.push(`  - ${w}`);
      }
    }
  } else if (hasWildcard) {
    sections.push("");
    sections.push("## Workspace scan");
    sections.push(
      `- Scan failed or cache unavailable — wildcard repos cannot resolve packages.`,
    );
  }

  if (config.repos.length === 0) {
    sections.push("");
    sections.push("No repositories configured.");
    return sections.join("\n");
  }

  // ── Per-repo checks (sequential to avoid network contention) ──
  for (const repo of config.repos) {
    const repoIssues: string[] = [];
    sections.push("");
    sections.push(`## Repo: ${repo.name}`);

    // Mode and basic info
    const mode = repo.localPath ? "local" : "managed (clone from URL)";
    sections.push(`- **Mode:** ${mode}`);
    if (repo.localPath) {
      sections.push(`- **Local path:** ${repo.localPath}`);
    }
    if (repo.url) {
      sections.push(`- **URL:** configured`);
    }
    sections.push(`- **Source root:** ${repo.sourceRoot}`);

    // Auth info (per-repo)
    sections.push(`- **Auth strategy:** ${repo.auth.strategy}`);
    sections.push(`- **PAT:** ${repo.auth.pat ? "configured" : "not set"}`);

    // Package info
    sections.push(...formatDiscovery(repo, scan));

    // Local path check
    if (repo.localPath) {
      try {
        const valid = await gitClient.isValidRepo(repo.localPath);
        if (valid) {
          sections.push(`- **Local repo valid:** OK`);
        } else {
          sections.push(`- **Local repo valid:** FAILED — path exists but is not a git repository`);
          repoIssues.push("local repo invalid");
        }
      } catch (err) {
        const msg = extractErrorMessage(err);
        error("digStatus", `repo '${repo.name}' local repo check failed:`, msg);
        sections.push(`- **Local repo valid:** FAILED — ${msg}`);
        repoIssues.push("local repo check error");
      }
    }

    // Remote connectivity check
    if (repo.url) {
      const result = await gitClient.lsRemote(repo.url, repo.auth);
      sections.push(...formatConnectivityResult(result, repo.auth, repo.name));
      if (!result.reachable) {
        repoIssues.push("remote unreachable");
      }
    }

    if (repoIssues.length > 0) {
      issueCount++;
    }
  }

  // ── Summary ──
  sections.push("");
  sections.push("---");
  if (issueCount === 0) {
    sections.push("All checks passed.");
  } else {
    sections.push(`${issueCount} of ${config.repos.length} repo(s) have issues. Check the details above.`);
  }

  return sections.join("\n");
}

// ── Internal ──

function formatDiscovery(repo: RepoConfig, scan: ScanResult | null): string[] {
  const lines: string[] = [];
  if (repo.discoveryMode === "wildcard") {
    const prefix = filterPrefix(repo.packageFilter!);
    lines.push(`- **Discovery:** wildcard (filter "${repo.packageFilter}")`);
    if (scan) {
      const matchingRefs = scan.packages.filter((p) => p.startsWith(prefix));
      lines.push(
        `- **Referenced matching prefix:** ${matchingRefs.length}${matchingRefs.length > 0 ? ` (${matchingRefs.join(", ")})` : ""}`,
      );
    } else {
      lines.push(`- **Referenced matching prefix:** unavailable — run dig_list to trigger a scan`);
    }
    if (repo.packages.length > 0) {
      const names = repo.packages.map((p) => p.name).join(", ");
      lines.push(`- **Matched packages:** ${repo.packages.length} (${names})`);
    } else {
      lines.push(
        `- **Matched packages:** not yet resolved — run dig_list to clone the repo and compute the intersection`,
      );
    }
  } else {
    const pkgInfo =
      repo.discoveryMode === "auto"
        ? `auto (${repo.packages.length > 0 ? repo.packages.length + " discovered" : "not yet discovered"})`
        : `explicit (${repo.packages.length})`;
    lines.push(`- **Discovery:** ${pkgInfo}`);
    if (repo.packages.length > 0) {
      const names = repo.packages.map((p) => p.name).join(", ");
      lines.push(`- **Packages:** ${names}`);
    }
  }
  return lines;
}

function formatRelPaths(absPaths: string[], workspaceRoot: string): string {
  if (absPaths.length === 0) return "";
  const rel = absPaths
    .map((p) => path.relative(workspaceRoot, p).replace(/\\/g, "/"))
    .join(", ");
  return ` (${rel})`;
}

function formatConnectivityResult(
  result: LsRemoteResult,
  auth: GitAuth,
  repoName: string,
): string[] {
  if (result.reachable) {
    return [`- **Remote connectivity:** OK (${result.refCount} branch refs found)`];
  }

  const lines: string[] = [];
  lines.push(`- **Remote connectivity:** FAILED`);

  // Auth context
  const patStatus = auth.pat ? "PAT configured" : "no PAT";
  const urlType = result.isHttps ? "HTTPS URL" : "non-HTTPS URL";
  lines.push(`  - Auth strategy: ${auth.strategy} (${patStatus}, ${urlType})`);

  // Attempts made
  if (result.attempts.length > 0) {
    const desc = result.attempts.map((a) =>
      a === "unauthenticated" ? "unauthenticated attempt" : "PAT-authenticated attempt",
    ).join(", then ");
    lines.push(`  - Tried: ${desc}`);
  }

  // Error
  if (result.error) {
    lines.push(`  - Error: ${result.error}`);
  }

  // Actionable hints
  const hint = inferHint(result, auth, repoName);
  if (hint) {
    lines.push(`  - Hint: ${hint}`);
  }

  return lines;
}

function inferHint(
  result: LsRemoteResult,
  auth: GitAuth,
  repoName: string,
): string | undefined {
  const err = result.error?.toLowerCase() ?? "";

  if (err.includes("could not resolve host") || err.includes("name or service not known")) {
    return "DNS resolution failed — check the repository URL or network connectivity";
  }
  if (err.includes("access denied") || err.includes("401") || err.includes("403") || err.includes("authentication failed")) {
    if (auth.pat) {
      return "authentication failed despite PAT — the PAT may be expired, revoked, or lack read permissions";
    }
    return `authentication required — configure 'auth.PAT' or 'auth.PAT-EnvVarName' on repo '${repoName}'`;
  }
  if (err.includes("repository not found") || err.includes("404")) {
    return "repository not found — check the URL or ensure the PAT has access to this project";
  }
  if (err.includes("timed out") || err.includes("connection refused")) {
    return "connection failed — the git server may be down or blocked by a firewall";
  }
  if (!result.isHttps && auth.pat && auth.strategy !== "none") {
    return `PAT is configured but URL is not HTTPS — PAT can only be injected into HTTPS URLs. Consider changing the repo URL for '${repoName}' to HTTPS`;
  }
  return undefined;
}
