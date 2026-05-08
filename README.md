# mcp-digger

An MCP server that gives Claude Code progressive, on-demand access to .NET NuGet package source code. Point it at your NuGet library repos and Claude can browse packages, search symbols, read signatures, and pull full source — without cloning anything into your working directory.

## How it works

mcp-digger exposes eight tools that Claude calls automatically, escalating from broad to deep:

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

Claude decides when to escalate based on tool descriptions — you just ask questions about your libraries.

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

## Claude Code setup

Add to your Claude Code MCP config (`.claude/settings.json` or project settings):

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

## Debugging

Enable debug logging in your config:

```jsonc
{
  "debug": true,
  "repos": [...]
}
```

Logs are written to `.digger/debug.log`.

## License

MIT
