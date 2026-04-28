# mcp-digger

MCP server that gives Claude Code progressive, on-demand access to internal .NET NuGet shared library source code. Claude starts with a lightweight overview and digs deeper only when needed — minimising token usage while preserving full fidelity when required.

## How It Works

Five MCP tools. One for diagnosing setup, one for discovery, three for escalating detail as needed:

| Tool | What it returns | Token cost |
|------|----------------|------------|
| `dig_status` | Health check — validates config and tests git connectivity for every configured repo | Very low |
| `dig_list` | Lists all configured repos and their resolved package names | Very low |
| `dig_overview` | Markdown summary of all packages in a repo: purpose, key types, conventions | Low |
| `dig_lookup` | Searches a package's type/method index by keyword, returns matching file paths | Low |
| `dig_file` | Full source of a single file | High |

Claude Code decides when to escalate based on the tool descriptions — no manual intervention needed. Call `dig_status` first when something looks off (auth error, stale data) to see exactly what the server sees.

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
      "packages": ["MyCompany.Core", "MyCompany.Auth"],
      "auth": {
        "strategy": "pat",
        "PAT-EnvVarName": "MY_GITLAB_PAT"
      }
    }
  ]
}
```

Then put `MY_GITLAB_PAT=glpat-...` in a `.env` file in the solution root (never commit it).

### 3. Add MCP server config

Create `.mcp.json` in your .NET solution root:

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
.env
```

### 5. Add to your solution's `CLAUDE.md`

```markdown
## Shared Internal Libraries

This project uses internal NuGet packages. Use mcp-digger tools to understand them:

- **`dig_status`** — run first if anything looks broken (auth errors, missing packages)
- **`dig_list`** — discover available repos and packages
- **`dig_overview`** — call for any task involving shared libraries to understand what's there
- **`dig_lookup`** — when you need to find which file contains a specific type or method
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

# In your .NET solution, create .mcp.json:
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
2. Ask Claude: *"Run dig_status and show me what's configured"* — confirms the server is wired up and repos are reachable
3. Ask a follow-up like: *"What shared internal packages are available?"* — Claude should call `dig_list` then `dig_overview`
4. Ask: *"Where is the IOrderService interface defined?"* — Claude should call `dig_lookup`

### Debug logging

Enable file-based debug logging to see what the MCP server is doing. Set `"debug": true` in `.digger/config.json`. Logs are written to `.digger/debug.log`.

## Configuration

### `.digger/config.json`

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `repos` | Yes | — | Array of repo definitions |
| `localRepos` | No | — | Object `{ repoName: path }` mapping repo names to local clones (Mode B) |
| `debug` | No | `false` | Enable debug logging to `.digger/debug.log` |

Per repo:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Repo label, used as clone dir name. Must be a plain identifier (no `*`) |
| `url` | No | — | Git clone URL (required unless the repo has a `localRepos` entry) |
| `sourceRoot` | No | `"src"` | Relative path where package dirs live |
| `packages` | No | auto-discover | Explicit list of package names. Omit or leave empty to auto-discover every non-test `.csproj` in the repo. Mutually exclusive with `packageFilter` |
| `packageFilter` | No | — | Wildcard filter (e.g. `"BSF.*"`) — narrows packages to those referenced by the workspace and matching the prefix. See [Package filtering](#package-filtering). Mutually exclusive with `packages` |
| `auth` | No | `{ strategy: "auto" }` | Git auth — see [Auth](#auth) below |

When `packages` is omitted (or set to `[]`) and no `packageFilter` is set, mcp-digger scans the repo for directories containing a matching `.csproj` file (excluding `.Tests`, `.Specs`, `.Benchmarks`, `.IntegrationTests`).

### Package filtering

Large internal mono-repos often contain dozens of packages, most of which a given consuming solution doesn't reference. Listing them explicitly is tedious; auto-discovering everything inflates context. The `packageFilter` field narrows the package list to what's actually referenced by your .NET solution.

```json
{
  "repos": [
    {
      "name": "my-shared-libs",
      "url": "https://gitlab.company.com/shared/libs.git",
      "packageFilter": "MyCompany.*",
      "auth": { "strategy": "pat", "PAT-EnvVarName": "COMPANY_GITLAB_PAT" }
    }
  ]
}
```

**How it works** — the exposed package list is the intersection of three sets:

1. **Referenced** — package names collected by recursively scanning the workspace for `*.sln`, `*.slnx`, `<PackageReference>` inside `.csproj` files, and `<PackageVersion>` / `<PackageReference>` inside `Directory.Packages.props`, `Directory.Build.props`, and `Directory.Build.targets`. Dirs `.git`, `.digger`, `node_modules`, `bin`, `obj`, `.vs`, `.idea`, and `packages` are skipped.
2. **Matching the prefix** — only names that start with the filter prefix (everything before `*`). For `"MyCompany.*"` the prefix is `MyCompany.`.
3. **Present in the repo** — only packages that actually exist as non-test `.csproj` directories in the shared-libs repo.

**Rules**:
- `packageFilter` must end with `*` and the prefix (part before `*`) must be non-empty and contain only safe characters (`A-Za-z0-9._-`).
- `packageFilter` and `packages` are mutually exclusive — you cannot specify both.
- `*` is not allowed in the repo `name` — names are plain identifiers.

**Cache file** — every scan writes its full result to `.digger/cache/solution-scan.json`. Inspect it when diagnosing matches; it lists the solution/props/targets files found, the resolved `.csproj` set, and the deduped package list.

**If nothing matches** — if the intersection is empty (e.g. the solution doesn't reference any `MyCompany.*` package, or the prefix is wrong) the tools surface an actionable error asking you to either fix the config or switch to an explicit `packages` list. Call `dig_status` to see the scan summary.

### Two Repo Modes

**Mode A — Managed download** (default): mcp-digger shallow-clones the repo into `.digger/source/<repoName>` and keeps it updated automatically.

**Mode B — Local repo**: When `localRepos` maps a repo name to a local path, mcp-digger reads from your existing clone. It never fetches or modifies your repo. If the local path is missing or invalid but `url` is configured, it falls back to Mode A with a warning.

Example:

```json
{
  "localRepos": {
    "my-shared-libs": "C:/dev/my-shared-libs"
  },
  "repos": [
    { "name": "my-shared-libs", "url": "https://gitlab.company.com/shared/libs.git" }
  ]
}
```

### Auth

Each repo has its own `auth` block. If omitted, the default is `{ "strategy": "auto" }` with no PAT.

| Strategy | Behaviour |
|----------|-----------|
| `"auto"` | Try unauthenticated clone first; fall back to PAT if set |
| `"pat"` | Always use PAT (fails at load if no PAT is configured) |
| `"none"` | Never inject credentials, even if a PAT is configured |

Two ways to supply a PAT — **mutually exclusive**:

| Field | Description |
|-------|-------------|
| `auth.PAT` | Inline token. Convenient for local testing; **never commit this** |
| `auth.PAT-EnvVarName` | Name of an env var to read the PAT from. This is what you want in the committed config |

Example with env-var indirection:

```json
{
  "repos": [
    {
      "name": "public-repo",
      "url": "https://github.com/owner/public.git",
      "auth": { "strategy": "none" }
    },
    {
      "name": "private-repo",
      "url": "https://gitlab.company.com/private.git",
      "auth": {
        "strategy": "pat",
        "PAT-EnvVarName": "COMPANY_GITLAB_PAT"
      }
    }
  ]
}
```

Put `COMPANY_GITLAB_PAT=glpat-...` in `.env` (or set it in your shell). mcp-digger loads `.env` automatically — actual environment variables always win over `.env` values.

### Environment Variables

Only three env vars are used, all optional overrides for paths:

| Variable | Description |
|----------|-------------|
| `DIGGER_CONFIG` | Override config file path (default: `.digger/config.json`) |
| `MANAGED_SOURCE_DIR` | Override managed clone dir (default: `.digger/source`) |
| `CACHE_DIR` | Override cache dir (default: `.digger/cache`) |

All per-machine secrets (PATs) go through user-chosen env vars referenced by `auth.PAT-EnvVarName`. A `.env.sample` file is included as a template:

```bash
cp .env.sample .env
```

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
