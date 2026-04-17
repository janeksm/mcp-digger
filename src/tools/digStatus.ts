import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiggerConfig, GitAuth } from "../config.js";
import * as gitClient from "../gitClient.js";
import type { LsRemoteResult } from "../gitClient.js";
import { debug } from "../logger.js";

// ── Tool description (shown to Claude Code) ──

const DESCRIPTION = `Health-check tool — validates mcp-digger configuration and tests git connectivity
for all configured repositories. Call this to verify setup is correct, diagnose
auth or network issues, or confirm repos are reachable before digging into source.`;

// ── Public API ──

/**
 * Register the dig_status tool on an MCP server.
 */
export function registerDigStatus(
  server: McpServer,
  config: DiggerConfig,
): void {
  server.registerTool(
    "dig_status",
    {
      title: "Dig Status",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, destructiveHint: false },
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
    const pkgInfo = repo.discoveryMode === "auto"
      ? `auto (${repo.packages.length > 0 ? repo.packages.length + " discovered" : "not yet discovered"})`
      : `explicit (${repo.packages.length})`;
    sections.push(`- **Discovery:** ${pkgInfo}`);
    if (repo.packages.length > 0) {
      const names = repo.packages.map((p) => p.name).join(", ");
      sections.push(`- **Packages:** ${names}`);
    }

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
        const msg = err instanceof Error ? err.message : String(err);
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
