# mcp-digger

MCP server that gives Claude Code progressive, on-demand access to internal .NET NuGet shared library source code. Claude starts with a lightweight overview and digs deeper only when needed — minimising token usage while preserving full fidelity when required.

## How It Works

Three MCP tools, each level digs deeper:

| Tool | What it returns | Token cost |
|------|----------------|------------|
| `dig_overview` | Markdown summary of all packages: purpose, key types, conventions | Low |
| `dig_signatures` | Stripped .cs files: public signatures + XML docs, bodies removed | Medium |
| `dig_file` | Full source of a single file | High |

Claude Code decides when to escalate based on the tool descriptions — no manual intervention needed.

## Quick Start

### 1. Install

```bash
npm install -g mcp-digger
# or use npx (no install needed)
```

### 2. Create `.digger/config.json` in your .NET solution root

```json
{
  "repos": [
    {
      "name": "my-shared-libs",
      "url": "https://gitlab.company.com/shared/libs.git",
      "sourceRoot": "src",
      "packages": ["MyCompany.Core", "MyCompany.Auth"]
    }
  ]
}
```

### 3. Add MCP server config

Create `.mcp/mcp-config.json` in your .NET solution root:

```json
{
  "mcpServers": {
    "mcp-digger": {
      "command": "npx",
      "args": ["mcp-digger"]
    }
  }
}
```

### 4. Add `.gitignore` entries

```
.digger/source/
.digger/cache/
.digger/debug.log
```

### 5. Add to your solution's `CLAUDE.md`

```markdown
## Shared Internal Libraries

This project uses internal NuGet packages. Use mcp-digger tools to understand them:

- **`dig_overview`** — call first for any task involving shared libraries
- **`dig_signatures`** — when you need exact type or method signatures
- **`dig_file`** — only when you need implementation detail of a specific file

Do not modify anything under `.digger/source/` or `.digger/cache/`.
```

## Testing Locally with Claude Code

### Option A: Run from source (during development)

Build and register the server pointing at a test .NET solution:

```bash
# In the mcp-digger repo
npm install
npm run build

# In your .NET solution, create .mcp/mcp-config.json:
```

```json
{
  "mcpServers": {
    "mcp-digger": {
      "command": "node",
      "args": ["C:/path/to/mcp-digger/dist/index.js"]
    }
  }
}
```

Then open Claude Code in your .NET solution directory. The MCP server starts automatically when Claude invokes a tool.

### Option B: Use npx (after publishing)

With the `.mcp/mcp-config.json` shown in Quick Start, just open Claude Code in your .NET solution directory.

### Verifying it works

1. Open Claude Code in the .NET solution directory
2. Ask Claude something like: *"What shared internal packages are available?"*
3. Claude should call `dig_overview` and return a summary
4. Ask a follow-up like: *"Show me the signatures for MyCompany.Core"*
5. Claude should call `dig_signatures` and return stripped .cs files

### Debug logging

Enable file-based debug logging to see what the MCP server is doing:

```json
{
  "mcpServers": {
    "mcp-digger": {
      "command": "npx",
      "args": ["mcp-digger"],
      "env": {
        "MCP_DIGGER_DEBUG": "1"
      }
    }
  }
}
```

Or set `"debug": true` in `.digger/config.json`. Logs are written to `.digger/debug.log`.

## Configuration

### `.digger/config.json`

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `repos` | Yes | — | Array of repo definitions |
| `authStrategy` | No | `"auto"` | Git auth: `"auto"`, `"pat"`, or `"none"` |
| `debug` | No | `false` | Enable debug logging to `.digger/debug.log` |

Per repo:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Repo label, used as clone dir name |
| `url` | No | — | Git clone URL (required unless using local repos) |
| `sourceRoot` | No | `"src"` | Relative path where package dirs live |
| `packages` | No | auto-discover | Explicit list of package names |

When `packages` is omitted, mcp-digger scans the repo for directories containing a matching `.csproj` file (excluding test projects).

### Environment Variables

Set these per-machine (never commit):

| Variable | Description |
|----------|-------------|
| `MCP_DIGGER_LOCAL_REPOS` | Use local clones instead of managed downloads. Format: `repoName:path,repoName:path` |
| `MCP_DIGGER_PAT` | Personal Access Token for private git repos |
| `MCP_DIGGER_DEBUG` | Set to `1` to enable debug logging (overrides config file) |
| `DIGGER_CONFIG` | Override config file path (default: `.digger/config.json`) |
| `MANAGED_SOURCE_DIR` | Override managed clone dir (default: `.digger/source`) |
| `CACHE_DIR` | Override cache dir (default: `.digger/cache`) |

### Two Repo Modes

**Mode A — Managed download** (default): mcp-digger shallow-clones the repo into `.digger/source/<repoName>` and keeps it updated automatically.

**Mode B — Local repo**: When `MCP_DIGGER_LOCAL_REPOS` maps a repo name to a local path, mcp-digger reads from your existing clone. It never fetches or modifies your repo.

### Auth Strategies

| Strategy | Behaviour |
|----------|-----------|
| `"auto"` | Try unauthenticated clone first; fall back to PAT if set |
| `"pat"` | Always use PAT (fails if `MCP_DIGGER_PAT` not set) |
| `"none"` | Never inject credentials |

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm test             # run all tests
npm run test:watch   # watch mode
npm run lint         # eslint
```

## Tech Stack

- Node.js 20+, TypeScript
- `@modelcontextprotocol/sdk` (official MCP SDK)
- Git CLI via `child_process` (no git libraries)
- Vitest for testing
