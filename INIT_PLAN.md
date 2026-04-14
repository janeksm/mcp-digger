# mcp-digger

## Project Goal

Build a Node.js/TypeScript MCP server named **mcp-digger** that gives Claude Code progressive,
on-demand access to internal .NET NuGet shared library source code. Claude Code starts with a
lightweight markdown overview and digs deeper only when needed — minimising token usage while
preserving full fidelity when required.

**npm package:** `mcp-digger`
**repo:** `mcp-digger`
**npx usage:** `npx mcp-digger`

---

## Problem Statement

- A .NET solution depends heavily on internal NuGet packages hosted on a private GitLab
- Shared library source lives in separate repos, in different local folders per developer
- Some team members will not have the shared lib source cloned at all
- Claude Code needs to understand shared lib APIs and conventions effectively
- Context must stay fresh as shared libs evolve
- Token cost should be proportional to actual need — not always maximum detail

---

## Core Design: Progressive Dig Tools

Claude Code decides how deep to dig. The MCP never speculatively sends full source.

```
Level 1 — always available, low token cost
  dig_overview()
  -> markdown summary of all packages: purpose, key types, conventions
  -> Claude Code uses this as default starting context — the surface dig

Level 2 — on demand, medium token cost
  dig_signatures(packageName)
  -> stripped .cs files: public signatures + XML doc comments, bodies removed
  -> Claude Code digs here when markdown is insufficient to understand a type or interface

Level 3 — on demand, high token cost
  dig_file(packageName, filePath)
  -> full source of a single file
  -> Claude Code digs here only when it needs implementation detail not clear from signatures
```

Claude Code's own reasoning drives how deep to dig, based on tool descriptions. No protocol-level
confidence signal exists in MCP — the tool descriptions instruct Claude Code when to call each.

---

## Repository Structure

```
mcp-digger/                             <- this repo
├── CLAUDE.md                           <- claude rules file
├── INIT_PLAN.md                             <- initial MCP design file
├── package.json                        <- name: "mcp-digger"
├── tsconfig.json
└── src/
    ├── index.ts                        <- MCP server entry point, registers all tools
    ├── config.ts                       <- JSON config file + env var parsing, repo/package config
    ├── csprojParser.ts                 <- finds .csproj files, extracts PackageReference versions
    ├── gitClient.ts                    <- all git CLI operations via child_process
    ├── repoManager.ts                  <- manages Mode A (clone/fetch) and Mode B (local) repos
    ├── sourceExtractor.ts              <- extracts overview MD and stripped .cs from source
    ├── cacheManager.ts                 <- reads/writes .digger/ cache, commit hash invalidation
    └── tools/
        ├── digOverview.ts              <- Level 1 tool: dig_overview
        ├── digSignatures.ts            <- Level 2 tool: dig_signatures
        └── digFile.ts                  <- Level 3 tool: dig_file
```

### Consumer .NET Solution Structure

```
your-dotnet-solution/
├── CLAUDE.md                           <- hand-written, references the MCP tools
├── .mcp/
│   └── mcp-config.json                 <- committed, no secrets
├── .digger/
│   ├── config.json                     <- repo/package definitions (committed)
│   ├── cache/                          <- MCP-managed: generated MD + stripped .cs, gitignored
│   │   ├── MyCompany.Core/
│   │   │   ├── overview.md             <- Level 1 output
│   │   │   └── signatures/             <- Level 2 output: stripped .cs files
│   │   │       ├── Domain/
│   │   │       └── Interfaces/
│   │   ├── MyCompany.Auth/
│   │   └── meta/                       <- per-repo: stored commit hash, generation timestamp
│   │       ├── bsf.json
│   │       └── standalone-auth.json
│   └── source/                         <- MCP-managed: shallow git clones, gitignored
│       ├── bsf/                        <- one clone per REPO (not per package)
│       └── standalone-auth/
└── src/
    └── YourProject/
        └── YourProject.csproj
```

---

## Configuration

Configuration is split across three layers:

1. **`.digger/config.json`** — repo/package definitions (committed, no secrets)
2. **`.mcp/mcp-config.json`** — MCP server launch config with optional env overrides (committed)
3. **Per-machine env vars** — local repo paths and git credentials (never committed)

### `.digger/config.json` — Repo & Package Definitions

Defines which source repositories to track and (optionally) which packages they contain.
One repo may contain multiple packages (monorepo pattern).

```json
{
  "authStrategy": "auto",
  "repos": [
    {
      "name": "bsf",
      "url": "https://gitlab.company.com/shared/bsf.git",
      "sourceRoot": "src",
      "packages": ["MyCompany.Core", "MyCompany.Auth", "MyCompany.Messaging"]
    },
    {
      "name": "standalone-auth",
      "url": "https://gitlab.company.com/shared/auth.git",
      "packages": ["Company.Auth"]
    },
    {
      "name": "utils",
      "url": "https://gitlab.company.com/shared/utils.git",
      "sourceRoot": "src"
    }
  ]
}
```

Top-level fields:
- `authStrategy` (optional, default `"auto"`) — git clone/fetch authentication strategy:
  - `"auto"` — try unauthenticated first; fall back to PAT if set and clone fails
  - `"pat"` — always inject PAT into HTTPS URLs (fatal error if `MCP_DIGGER_PAT` not set)
  - `"none"` — never use credentials, even if PAT is set

Per repo:
- `name` (required) — label used in `MCP_DIGGER_LOCAL_REPOS` and as managed clone dir name
- `url` (optional) — Git clone URL for Mode A. Optional if every dev uses local repos.
- `sourceRoot` (optional, default `"src"`) — relative path inside the repo where package dirs
  live. Set to `"."` for a single-package repo where the .csproj is at root level.
- `packages` (optional) — explicit list of package names. Each is expected at
  `{sourceRoot}/{packageName}/`. **If omitted → auto-discover**: mcp-digger scans the cloned
  repo for directories under `{sourceRoot}/` containing a matching `.csproj` file.
  Test projects (`.Tests`, `.Specs`, `.Benchmarks`, `.IntegrationTests`) are excluded.

### `.mcp/mcp-config.json` — Committed to Repo, No Secrets

```json
{
  "mcpServers": {
    "mcp-digger": {
      "command": "npx",
      "args": ["mcp-digger"],
      "env": {
        "DIGGER_CONFIG": ".digger/config.json",
        "MANAGED_SOURCE_DIR": ".digger/source",
        "CACHE_DIR": ".digger/cache"
      }
    }
  }
}
```

All three env vars are optional and have the defaults shown above.

### Per-Machine Env Vars — Never Committed

Per-machine env vars are prefixed with `MCP_DIGGER_` to avoid collisions with
other tools in the developer's global user environment.

```powershell
# Optional: use developer's own local clone instead of MCP-managed download
# Maps REPO NAMES (not package names) to local paths
[Environment]::SetEnvironmentVariable(
  "MCP_DIGGER_LOCAL_REPOS",
  "bsf:C:/dev/bsf-monorepo,standalone-auth:C:/dev/shared-libs/auth",
  "User"
)

# Optional: Personal Access Token for git clone auth (used per authStrategy)
[Environment]::SetEnvironmentVariable("MCP_DIGGER_PAT", "glpat-xxxx", "User")
```

---

## MCP Tools

### Tool 1: `dig_overview`

**Description for Claude Code:**
```
Digs the surface of all configured internal NuGet shared libraries.
Returns a markdown overview including: purpose of each package, key public types
and interfaces (summarised), architectural conventions, and usage patterns.
Call this first before working on any code that uses internal packages.
If you need to dig deeper — precise method signatures, generics, or parameter
types — call dig_signatures instead.
```

**Behaviour:**
- Checks cache freshness via commit hash (see Cache Invalidation below)
- If cache is fresh: reads and returns overview.md from cache — no git operations
- If stale or missing: triggers source fetch, regenerates overview, updates cache
- Returns markdown string

**Overview content extracted from source:**
- Package README.md and docs/ folder contents
- One-paragraph summary per major namespace
- Key interfaces and abstract classes: name + XML doc summary only (no signatures yet)
- Architectural conventions and patterns found in comments or docs
- Known gotchas and non-obvious behaviours from XML doc remarks

---

### Tool 2: `dig_signatures`

**Description for Claude Code:**
```
Digs one level deeper into a specific internal package.
Returns stripped C# source files containing only public type declarations,
method signatures, property definitions, and XML doc comments.
Method bodies are replaced with { /* ... */ }.
Call this when the overview is not enough to confidently use a type — for example
when you need exact method overloads, generic constraints, interface members,
or return types. Specify the package name.
To dig even deeper into a specific file's implementation, call dig_file.
```

**Input:** `packageName: string`

**Behaviour:**
- Checks cache freshness (same mechanism as Tool 1)
- If signatures cache exists and is fresh: returns file listing + content from
  .digger/cache/<PackageName>/signatures/
- If stale or missing: runs sourceExtractor to produce stripped .cs files, caches them
- Returns array of { filePath: string, content: string } — Claude Code receives
  them as readable code files

**Stripped .cs format:**
```csharp
// GENERATED — read only — MyCompany.Core @ commit a3f9c12e
// Do not edit. Re-generated automatically when source changes.

namespace MyCompany.Core.Domain
{
    /// <summary>Base class for all domain entities.</summary>
    /// <remarks>Never throw — use Result&lt;T&gt; for business rule failures.</remarks>
    public abstract class Entity<TId>
    {
        public TId Id { get; protected set; }
        public DateTime CreatedAt { get; protected set; }

        /// <summary>Queues a domain event to dispatch after SaveChangesAsync.</summary>
        public void AddDomainEvent(IDomainEvent evt) { /* ... */ }
    }

    /// <summary>Represents success or failure of an operation.</summary>
    public class Result<T>
    {
        public bool IsSuccess { get; }
        public T Value { get; }            // Only valid when IsSuccess is true
        public string Error { get; }       // Only valid when IsSuccess is false
        public static Result<T> Ok(T value) { /* ... */ }
        public static Result<T> Fail(string error) { /* ... */ }
    }
}
```

---

### Tool 3: `dig_file`

**Description for Claude Code:**
```
Digs to the deepest level — full source of a single file from an internal package.
Call this only when you need to understand the actual implementation — for example
to trace specific behaviour, understand a complex algorithm, or debug an unexpected
result. Provide both package name and file path (relative path as listed by
dig_signatures). Avoid calling this speculatively — prefer dig_signatures
unless implementation detail of a specific file is needed.
```

**Input:** `packageName: string`, `filePath: string`

**Behaviour:**
- Reads directly from the source repo (managed clone or local repo)
- No caching needed — source files are already on disk in .digger/source/
- Returns full file content as a string

---

## Two Repo Modes

### Mode A — MCP-Managed Download (default)

Used when `MCP_DIGGER_LOCAL_REPOS` env var is not set for a repo.
Clones are per-repo (not per-package).

```
Initial:
  git clone --depth 1 <repoUrl> .digger/source/<repoName>

Freshness check:
  git -C <path> fetch --depth 1 origin HEAD
  git -C <path> rev-parse FETCH_HEAD   ->  compare to hash in meta.json
```

### Mode B — Developer's Local Repo

Used when `MCP_DIGGER_LOCAL_REPOS` env var includes a path for the repo.

```
Freshness check:
  git -C <localPath> rev-parse HEAD   ->  compare to hash in meta.json

No fetch. No pull. mcp-digger only reads — developer manages their own repo.
```

---

## Cache Invalidation

Single mechanism used by all three tools.

### `meta.json` per Repo

Stored at `.digger/cache/meta/<repoName>.json`. One hash per repo — all packages
in that repo share the same freshness state.

```json
{
  "repo": "bsf",
  "mode": "managed-download",
  "sourcePath": ".digger/source/bsf",
  "lastCommitHash": "a3f9c12e8b4f1d2e34a9c...",
  "generatedAt": "2026-04-11T09:15:00Z",
  "branch": "main"
}
```

### Check Flow

```
is_cache_fresh(repoName):
  1. meta/<repoName>.json exists?     NO  -> stale
  2. get current commit hash from repo (Mode A: FETCH_HEAD, Mode B: HEAD)
  3. hash == meta.lastCommitHash?     YES -> fresh,  NO -> stale
```

When stale: regenerate overview.md + all stripped .cs files for ALL packages in
that repo, update meta.json. Full source files (Level 3) are never cached —
always read live from .digger/source/.

---

## Module Responsibilities

### `config.ts`
Two-phase configuration:

**Phase 1 — `loadConfig()` (synchronous, at startup):**
- Read and validate `.digger/config.json` (path overridable via `DIGGER_CONFIG` env var)
- Merge per-machine env vars: `MCP_DIGGER_LOCAL_REPOS` (by repo name), git creds, dirs
- Build `RepoConfig[]` with resolved absolute paths
- For repos with explicit `packages`: build `PackageConfig[]` immediately
- For repos without: mark `discoveryMode: "auto"`, packages start empty
- Throw `ConfigError` aggregating all validation problems

**Phase 2 — `discoverPackages()` (async, after repo is on disk):**
- Scan `{repoPath}/{sourceRoot}/*/` for dirs containing `{dirName}.csproj`
- Exclude test projects (`.Tests`, `.Specs`, `.Benchmarks`, `.IntegrationTests`)
- Return `PackageConfig[]` to populate `RepoConfig.packages`

**Helpers:**
- `findPackage(config, packageName)` — lookup a package by name across all repos
- `findRepo(config, packageName)` — find the repo that owns a package

### `csprojParser.ts`
- Recursively find all .csproj files in workspace
- Parse XML, extract PackageReference elements
- Filter to packages known in config (from `DiggerConfig.repos[].packages`)
- Handle both SDK-style and legacy .csproj formats
- Return: Map<packageName, version>

### `gitClient.ts`
All git via child_process.exec. No git libraries.

```typescript
interface GitClient {
  clone(repoUrl: string, targetDir: string, depth?: number): Promise<void>
  fetch(repoDir: string): Promise<void>
  revParse(repoDir: string, ref: string): Promise<string>
  isValidRepo(dirPath: string): Promise<boolean>
  readFile(repoDir: string, filePath: string): Promise<string>
  listFiles(repoDir: string, pattern?: string): Promise<string[]>
}
```

Auth behaviour depends on `authStrategy` from `.digger/config.json`:

- `"auto"` (default): try clone/fetch unauthenticated first. If that fails
  AND `MCP_DIGGER_PAT` is set AND URL is HTTPS, inject as
  `https://oauth2:<pat>@hostname/path.git` and retry.
- `"pat"`: always inject PAT into HTTPS URLs. Skip the unauthenticated attempt.
- `"none"`: never inject credentials. Use git's own credential helpers only.

Never persist the auth URL to git remote config — use explicit URL in the
fetch command so the PAT stays in memory only.

### `repoManager.ts`
Operates per-repo (not per-package). One clone per repo.
- Determines mode per repo (Mode A or B) from `RepoConfig`
- Mode A: ensures clone exists at `managedSourcePath`, runs fetch, returns FETCH_HEAD hash
- Mode B: validates `localPath` is a git repo, returns HEAD hash
- Fallback: if Mode B path missing and `url` configured, falls back to Mode A with warning
- For auto-discover repos: calls `discoverPackages()` after repo is on disk
- Exposes: `ensureReady(repoConfig): Promise<{ sourcePath, currentHash, mode, warning? }>`

### `sourceExtractor.ts`
Reads from a source directory on disk, produces two outputs:

**Overview markdown:**
- Read README.md, docs/*.md, CONVENTIONS.md, ARCHITECTURE.md if present
- Scan all .cs files for public interfaces and abstract classes
- Extract: type name + XML summary + remarks only (no signatures)
- Exclude: test projects (*.Tests, *.Specs), generated files (*.g.cs, *.generated.cs)

**Stripped .cs files:**
- Copy namespace and type declarations verbatim
- Keep: all public/protected member signatures, XML doc comments, field/property
  declarations, enum values, constants, attribute decorations
- Replace: all method and property getter/setter bodies with { /* ... */ }
- Add file header comment with package name and commit hash
- Preserve original file and folder structure under signatures/

### `cacheManager.ts`
- Read/write meta.json per-repo (at `cache/meta/<repoName>.json`)
- Read/write overview.md per-package (at `cache/<packageName>/overview.md`)
- Read/write files under signatures/ per-package
- `isFresh(repoName, currentHash): boolean`
- `invalidate(repoName): void` — deletes meta + all package caches for that repo

### `tools/digOverview.ts`
- For each configured repo: call `repoManager.ensureReady`
- Check freshness via cacheManager (per-repo)
- If stale: call sourceExtractor for overview of each package in that repo, write to cache
- Concatenate all package overviews into single markdown response
- Include availability warnings if any package source was unreachable

### `tools/digSignatures.ts`
- repoManager.ensureReady for the requested package
- Check freshness
- If stale: call sourceExtractor for stripped .cs, write to cache
- Return array of { filePath, content } for all files under signatures/

### `tools/digFile.ts`
- repoManager.ensureReady for the requested package
- Read file directly from source via gitClient.readFile
- Return raw file content string

---

## Error and Availability Handling

| Situation                                   | Behaviour                                              |
|---------------------------------------------|--------------------------------------------------------|
| Mode B path missing, repoUrl available      | Warn in response, fall back to Mode A                  |
| Mode B path missing, no repoUrl             | Return availability warning in overview section        |
| Clone fails (network or auth)               | Return package section with clear unavailable message  |
| Package has no repoUrl and no local path    | Mark unavailable in all tool responses                 |
| `dig_file` called with invalid path         | Return error listing valid paths from signatures/      |

Tools never throw unhandled errors — always return a usable response, even if partial.

---

## Consumer `CLAUDE.md` Reference

The .NET solution repo should contain this in its CLAUDE.md:

```markdown
## Shared Internal Libraries

This project uses internal NuGet packages. Use mcp-digger tools to understand them:

- **`dig_overview`** — dig here first for any task involving shared libraries
- **`dig_signatures`** — dig here when you need exact type or method signatures
- **`dig_file`** — dig here only when you need implementation detail of a specific file

Do not modify anything under `.digger/source/` or `.digger/cache/`.
```

---

## `.gitignore` Entries (for the .NET solution repo)

```
.digger/source/
.digger/cache/
```

---

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk` (official Anthropic SDK)
- **XML parsing**: `fast-xml-parser` (for .csproj)
- **Git**: child_process.exec calling git CLI — no git libraries
- **Distribution**: npx-compatible npm package — `npx mcp-digger`

---

## Implementation Order

Build and test in this sequence:

1. `config.ts` — env var parsing, validation, per-package config objects
2. `csprojParser.ts` — workspace scan, PackageReference extraction
3. `gitClient.ts` — all git CLI wrappers
4. `repoManager.ts` — Mode A/B logic, ensureReady, fallback handling
5. `cacheManager.ts` — meta.json, freshness check, cache read/write
6. `sourceExtractor.ts` — overview MD extraction, stripped .cs generation
7. `tools/digOverview.ts` — Level 1 tool: dig_overview
8. `tools/digSignatures.ts` — Level 2 tool: dig_signatures
9. `tools/digFile.ts` — Level 3 tool: dig_file
10. `index.ts` — MCP server entry point, register all tools

---

## Key Design Decisions

| Decision                                          | Reason                                                        |
|---------------------------------------------------|---------------------------------------------------------------|
| Claude Code drives escalation via tool descriptions | No MCP protocol support for confidence signals              |
| Markdown for overview, stripped .cs for signatures | MD for narrative/conventions, native code for type system   |
| Full source only on explicit file request         | Token cost proportional to actual need                        |
| Git CLI only, no git libraries                    | Always available, cross-platform, no extra dependencies       |
| No GitLab API                                     | Works offline, no auth needed once cloned                     |
| Commit hash as sole invalidation key              | Simpler and more precise than version string matching         |
| Shallow clone for managed mode                    | Fast, only latest source needed                               |
| meta.json per package                             | Simple, inspectable, no database                              |
| Mode B never fetches                              | Developer owns their repo — MCP is read-only guest            |
| Separate cache dir from source dir                | Source stays pristine; cache can be deleted and rebuilt       |
| Tools never throw                                 | Claude Code always gets a usable response, even if partial    |
