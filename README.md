# mcp-digger

> **Your internal libraries have source — mcp-digger turns it into the context AI agents need to use your APIs correctly**, saving time, tokens, and manual intervention.

## Built for Internal Libraries

Public NuGet packages have documentation ecosystems — API references, tutorials, community Q&A. Tools like context7 serve that well.

Internal packages often have source code as their primary documentation. mcp-digger turns that source into structured, searchable, token-efficient context that any MCP-compatible agent can consume — bridging the documentation gap in private library ecosystems.

## The Pain

- **Slow context gathering.** AI agents can search referenced library source via shell commands or local clones, but it's a multi-step process — `git clone`, `find`, `grep`, `cat` chains — that burns tokens on infrastructure before any useful context is retrieved.
- **No semantic search.** File system tools find text matches, not API surfaces. Finding "every type that implements this interface" requires the agent to build extraction scripts on demand, every session, from scratch.
- **Token waste on raw source.** Without progressive disclosure, the agent reads entire files when it only needs a method signature or a type's public surface.
- **Permission click fatigue.** Each shell command the agent runs to explore library source requires manual approval — dozens of clicks across a session that purpose-built tools eliminate.
- **Workspace noise.** Cloning reference repos into the project tree pollutes file search, git status, and the agent's own context window with thousands of irrelevant files.

## The Solution

An MCP server that gives AI coding agents direct, read-only access to .NET library source code — on demand, progressively, without cloning anything into the working directory.

Point it at your NuGet repos once. The agent browses packages, searches symbols, reads signatures, and pulls source autonomously — building the context it needs to use your libraries correctly.

## Key Benefits

- **Correct code on the first try.** The agent sees actual method signatures, generic constraints, interface contracts, and base class patterns — not guesses. Code generated against real API surfaces works.
- **Time back in your day.** The agent self-serves library context in seconds, without manual lookup or copy-paste.
- **Fewer permission clicks.** Eight purpose-built tools replace dozens of ad-hoc shell commands. One allowed MCP server vs. approving every `git clone`, `find`, `grep`, and `cat` individually.
- **Lower token cost.** Progressive disclosure means the agent reads a 200-token overview before pulling 5,000 tokens of source. Most questions resolve at L1 or L2 — full source is the exception, not the default.
- **Zero workspace pollution.** Managed clones live outside your project tree. Your git status, your file tree, your search results — all stay clean.

## Key Features

| Feature | Why it matters |
|---------|---------------|
| **Progressive disclosure** (L1→L2→L3) | Overview → signatures → full source. The agent reads only what it needs at each step. |
| **Cross-package symbol search** | Find every class implementing a given interface — across all repos, all packages, one call. |
| **Three search modes** | `symbol` (find declarations), `implements` (find implementors), `references` (find usages) — the queries agents actually need to understand API usage. |
| **Stripped signature view** | Public API surface without method bodies — the agent sees the shape of a type without drowning in implementation detail. |
| **Wildcard package discovery** | `"packageFilter": "MyCompany.*"` — no manual package list maintenance as your repo grows. Follows transitive `ProjectReference` links automatically. |
| **Branch tracking** | Pin to `develop`, `release/2.0`, or any branch — the agent sees the code you're actually building against. |
| **Smart README filtering** | Strips install badges, CI/CD, license boilerplate — keeps only architecture and design sections that help understand the library. |
| **Self-healing** | `dig_refresh` force-rebuilds indexes. Zero-result messages include actionable hints. `dig_status` diagnoses connectivity and auth issues. |
| **Secure by default** | PATs never logged, path traversal blocked, package names validated, repo URLs restricted to HTTPS/SSH. |
| **Any Git host** | GitHub, GitLab, Azure DevOps, Bitbucket, self-hosted — anything reachable over HTTPS or SSH. |

## How it works

mcp-digger exposes eight tools that AI agents call automatically, escalating from broad to deep:

| Tool | Level | What it does |
|------|-------|-------------|
| `dig_status` | Health | Config summary + connectivity check per repo |
| `dig_list` | Discovery | Lists all configured repos and their packages |
| `dig_repo_overview` | L1 | Repo README + package listing with .csproj summaries |
| `dig_package_overview` | L1 | Full package docs, key interfaces, abstract classes |
| `dig_package_files` | L1 | Source file listing for a package |
| `dig_lookup` | L2 | Keyword search over type/method index (supports cross-package) |
| `dig_signatures` | L2 | Stripped C# public API signatures filtered by keyword |
| `dig_file` | L3 | Full source of a single file |

The agent decides when to escalate based on tool descriptions — you just ask questions about your libraries.

## Install

```bash
npm install -g mcp-digger
```

Or run directly:

```bash
npx mcp-digger
```

Requires Node.js 20+ and `git` on PATH.

## Configuration

Create `.digger/config.json` in your workspace root:

```jsonc
{
  "repos": [
    {
      "name": "my-libraries",
      "url": "https://github.com/org/shared-libs.git",
      "sourceRoot": "src",       // where package dirs live (default: "src")
      "branch": "develop",      // git branch to track (default: repo default branch)
      "packages": ["MyCompany.Core", "MyCompany.Data"],  // or omit for auto-discovery
      "auth": {
        "strategy": "pat",
        "PAT-EnvVarName": "GIT_PAT"  // reads from .env or environment
      }
    }
  ]
}
```

Works with any Git host (GitHub, GitLab, Azure DevOps, Bitbucket, self-hosted, etc.).

### Auto-discovery

Omit `packages` to auto-discover all non-test `.csproj` directories, or use `packageFilter` for prefix matching:

```jsonc
{
  "repos": [
    {
      "name": "my-libraries",
      "url": "https://github.com/org/shared-libs.git",
      "packageFilter": "MyCompany.*"
    }
  ]
}
```

### Local repos (Mode B)

If you already have the repo cloned locally, skip managed cloning:

```jsonc
{
  "localRepos": {
    "my-libraries": "C:/repos/shared-libs"
  },
  "repos": [
    {
      "name": "my-libraries",
      "sourceRoot": "src"
    }
  ]
}
```

### Branch tracking

By default, managed clones use the repo's default branch. Set `branch` to track a specific branch instead:

```jsonc
{
  "repos": [
    {
      "name": "my-libraries",
      "url": "https://github.com/org/shared-libs.git",
      "branch": "develop"
    }
  ]
}
```

The branch is used for both initial clone and subsequent fetches. Only applies to managed clones (Mode A) — for local repos, you control the checked-out branch yourself.

### Auth strategies

| Strategy | Behavior |
|----------|----------|
| `auto` (default) | Try unauthenticated, fall back to PAT if set |
| `pat` | Always use PAT (fatal if not set) |
| `none` | Never authenticate |

PATs can be inline (`"PAT": "..."`) or via environment variable indirection (`"PAT-EnvVarName": "MY_TOKEN"`). The `.env` file in your workspace root is loaded automatically.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DIGGER_CONFIG` | `.digger/config.json` | Override config file path |
| `MANAGED_SOURCE_DIR` | `.digger/source` | Override managed clone directory |
| `CACHE_DIR` | `.digger/cache` | Override cache directory |

## Agent setup

### Claude Code

Add to `.claude/settings.json` or project settings:

```json
{
  "mcpServers": {
    "digger": {
      "command": "npx",
      "args": ["-y", "mcp-digger"]
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml` (or `.codex/config.toml` for project-scoped):

```toml
[mcp_servers.mcp-digger]
command = "npx"
args = ["-y", "mcp-digger"]
```

## Debugging

Enable debug logging in your config:

```jsonc
{
  "debug": true,
  "repos": [...]
}
```

Logs are written to `.digger/debug.log`.
