# mcp-digger

> **Code context for AI coding agents.** Progressive, on-demand access to your internal .NET / NuGet package source — agents browse, search, and read private C# libraries autonomously, with zero workspace pollution.

> ⚠ **Scope: .NET / C# only.** mcp-digger indexes NuGet-style repos containing `.csproj` packages and `.cs` source files. It is not a general-purpose source indexer — other languages (TypeScript, Python, Java, Go, etc.) are out of scope.

---

## ✨ Why

Public NuGet packages have documentation ecosystems — API references, tutorials, community Q&A. Tools like `context7` serve that well.

Internal .NET packages often have source code as their primary documentation. mcp-digger turns that source into structured, searchable, token-efficient context that any MCP-compatible agent can consume — bridging the documentation gap in private C# library ecosystems.

**Without it:**

- 🐢 **Slow context gathering** — `git clone` + `find` + `grep` + `cat` chains burn tokens on infrastructure before useful context is retrieved.
- 🔍 **No semantic search** — file system tools find text, not API surfaces. "Every type implementing this interface" means writing extraction scripts on demand.
- 💸 **Token waste** — agents read whole files when a single method signature would do.
- 🖱 **Permission click fatigue** — dozens of shell-command approvals per session.
- 🧹 **Workspace noise** — referenced repos pollute file search, git status, and the agent's context window.

**With it:**

- ✅ **Correct code on the first try** — real signatures, generic constraints, interface contracts, base class patterns.
- ⚡ **Self-service context** — point the agent at your NuGet repos once; it browses, searches, and reads autonomously.
- 🪙 **Progressive disclosure** — 200-token overview before 5,000 tokens of source. Most questions resolve at L1 or L2.
- 🧼 **Zero workspace pollution** — managed clones live outside your project tree.
- 🌐 **Any Git host** — GitHub, GitLab, Azure DevOps, Bitbucket, self-hosted — HTTPS or SSH.

---

## 🛠 How it works

Ten purpose-built tools, escalating from broad to deep. The agent picks the cheapest tool that answers its question.

```
                                                           ┌─→ 📦 dig_package_overview ─┐
                                                           │   (docs, key types)        │
   🩺 dig_status  →  📋 dig_list  →  📖 dig_repo_overview  ┤                            ├─→  🔎 dig_lookup     →  📄 dig_file
   (health)          (discover)      (README + summaries)  │                            │   (symbol → file)       (full source)
                                                           ├─→ 📁 dig_package_files ────┤
                                                           │   (file listing)           │
                                                           └────────────────────────────┴─→  📝 dig_signatures
                                                                                            (stripped API)

   Operational:  🔄 dig_refresh   (force cache invalidation, on demand)
   Bootstrap:    🌱 dig_init      (only when no config exists)
```

---

## 🧰 Tools (10)

| Tier | Tool | What it does |
|------|------|-------------|
| **Health** | 🩺 `dig_status` | Config summary, connectivity check per repo, index health stats |
| **Discovery** | 📋 `dig_list` | Lists configured repos + their packages with one-line `.csproj` summaries |
| **L1 Overview** | 📖 `dig_repo_overview` | Repo `README.md` (filtered to architecture sections) + package count |
| **L1 Overview** | 📦 `dig_package_overview` | Package docs, key interfaces, abstract classes, file count |
| **L1 Overview** | 📁 `dig_package_files` | `.cs` file listing for a package, with directory summary header |
| **L2 Search** | 🔎 `dig_lookup` | Indexed symbol search — `symbol`, `implements`, or `references` mode. Cross-package supported. |
| **L2 Search** | 📝 `dig_signatures` | Stripped C# public API surface filtered by keyword (no method bodies) |
| **L3 Source** | 📄 `dig_file` | Full source of a single file (capped at 1 MB) |
| **Operational** | 🔄 `dig_refresh` | Force-rebuild caches for one or all repos |
| **Bootstrap** | 🌱 `dig_init` | Creates starter `.digger/config.json` (registered only when no config is found) |

**Search modes for `dig_lookup`:**

| Mode | Finds |
|------|-------|
| `symbol` (default) | Type/method declarations matching a name substring |
| `implements` | Classes/structs implementing an interface or extending a base class |
| `references` | Files referencing a given type name (word-boundary, case-sensitive) |

---

## 🚀 Quick start

### Install

```bash
npm install -g mcp-digger
# or run directly
npx mcp-digger
```

Requires Node.js 20+, `git` on `PATH`, and a .NET / C# source repo (NuGet packages with `.csproj` + `.cs` sources).

### Minimal config

Create `.digger/config.json` in your workspace root:

```jsonc
{
  "repos": [
    {
      "name": "my-libraries",
      "url": "https://github.com/org/shared-libs.git",
      "packageFilter": "MyCompany.*",
      "auth": {
        "strategy": "pat",
        "PAT-EnvVarName": "GIT_PAT"
      }
    }
  ]
}
```

Don't have a config yet? Start the server, then call `dig_init` to scaffold one.

### Agent setup

<details>
<summary><strong>Claude Code</strong></summary>

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
</details>

<details>
<summary><strong>Codex CLI</strong></summary>

Add to `~/.codex/config.toml` (or `.codex/config.toml` for project-scoped):

```toml
[mcp_servers.mcp-digger]
command = "npx"
args = ["-y", "mcp-digger"]
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

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
</details>

<details>
<summary><strong>VS Code</strong></summary>

Add to `.vscode/mcp.json` (workspace) or your user `mcp.json`:

```json
{
  "servers": {
    "digger": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-digger"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

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
</details>

### Verify

Once connected, ask your agent to call `dig_status` — it reports config validation, per-repo connectivity, and index health.

---

## ⚙ Configuration

### Repos & packages

A `repos[]` entry has three ways to declare packages:

| Option | Behavior |
|--------|----------|
| `"packages": ["A", "B"]` | Explicit list — these packages plus any local sibling project they pull in via `<ProjectReference>` (transitive, sibling-only). |
| `"packageFilter": "MyCompany.*"` | Wildcard — narrows to packages matching the prefix, found via `.sln`/`.slnx`/`Directory.Packages.props` workspace scan. Follows transitive `ProjectReference` links automatically. |
| *(omit both)* | Auto-discover all non-test `.csproj` directories under `sourceRoot` (recursive — nested layouts supported). |

`sourceRoot` defaults to `"src"` — set it to whichever directory holds your package folders. The walk is recursive, so nested layouts like `src/Group/Foo/Foo.csproj` are picked up.

<details>
<summary><strong>Branch tracking</strong></summary>

By default, managed clones use the repo's default branch. Pin to a specific one:

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

The branch is used for both initial clone and subsequent fetches. Only applies to managed clones — for local repos, you control the checked-out branch yourself.
</details>

<details>
<summary><strong>Local repos (Mode B)</strong></summary>

Skip managed cloning when the repo is already on disk. The local path is read-only — mcp-digger never fetches or modifies it.

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
</details>

<details>
<summary><strong>Auth strategies</strong></summary>

| Strategy | Behavior |
|----------|----------|
| `auto` *(default)* | Try unauthenticated, fall back to PAT if set |
| `pat` | Always use PAT (fatal if not set) |
| `none` | Never authenticate |

PATs can be inline (`"PAT": "..."`) or via environment variable indirection (`"PAT-EnvVarName": "MY_TOKEN"`). The `.env` file in your workspace root is loaded automatically — values containing ` #` should be quoted.
</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Default | Purpose |
|----------|---------|---------|
| `DIGGER_CONFIG` | `.digger/config.json` | Override config file path |
| `MANAGED_SOURCE_DIR` | `.digger/source` | Override managed clone directory |
| `CACHE_DIR` | `.digger/cache` | Override cache directory |

Secrets (PAT values) belong in `.env` or the real environment — never as env vars in this table.
</details>

---

## 🩺 Diagnostics & recovery

| Symptom | First call | Then |
|---------|-----------|------|
| Connection / auth issues | `dig_status` | Reports auth attempts, exact error, actionable hints |
| "No matches" but you expect some | `dig_refresh <repo>` | Force-rebuilds index, picks up new extraction logic |
| Server starts but no tools visible | `dig_status` | If unconfigured, only `dig_status` + `dig_init` are registered |
| Need a config from scratch | `dig_init` | Scaffolds `.digger/config.json` (atomic — won't overwrite existing) |

### Debug log

Enable debug logging in your config:

```jsonc
{ "debug": true, "repos": [...] }
```

Logs go to `.digger/debug.log` (capped at 5 MB, auto-truncated). Critical errors and crash output land in `.digger/error.log`.

---

## 💬 Feedback

Tried mcp-digger on your codebase? Share what worked, what broke, what's missing in [GitHub Discussions](https://github.com/janeksm/mcp-digger/discussions). Bug reports go in [Issues](https://github.com/janeksm/mcp-digger/issues).

---

## 📜 License

MIT License — see [LICENSE](LICENSE).
