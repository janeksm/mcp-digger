# mcp-digger — Security TODO

> Remaining findings from the security review on 2026-04-15.
> Critical findings #1 (path traversal in `dig_file`) and #2 (PAT leak in `gitClient` errors) are fixed — see git history.

| # | Sev | File | Title | Status |
|---|-----|------|-------|--------|
| 3 | High | `src/tools/digFile.ts` | Cap file size returned by `dig_file` | — |
| 4 | High | `src/config.ts` | Validate package names against a safe charset | — |
| 5 | High | `src/config.ts` | Restrict repo URL schemes to `https:` / `ssh:` | — |
| 6 | High | `src/cacheManager.ts`, `src/tools/digSignatures.ts` | Atomic `meta.json` writes + per-repo serialization to fix cache TOCTOU | done |
| 7 | Medium | `src/config.ts`, `src/cacheManager.ts` | Extract only known fields from `JSON.parse` output (prototype-pollution hardening) | — |
| 8 | Medium | `src/config.ts` | Cap fan-out in `discoverPackages` (unbounded `Promise.all`) | — |
| 9 | Medium | `src/logger.ts` | Verify 5 MB log-file size cap from the plan actually exists | — |
| 10 | Low | `src/repoManager.ts` | Per-repo mutex to serialize concurrent `ensureReady` calls | done |
| 11 | Low | `src/gitClient.ts` | Defensive `filePath` validation in `readFile` (belt-and-braces) | — |
| 12 | Low | `src/config.ts` | Review symlink-following in `discoverPackages` | — |
| 13 | Info | `@modelcontextprotocol/sdk` usage | Confirm Zod `inputSchema` is enforced by the MCP SDK (possible false positive) | — |

**Statuses:** `—` not started, `in-progress` active, `done` fixed, `wontfix` intentionally skipped

---

## Details

### #3 — Cap file size returned by `dig_file` (High)

**File:** `src/tools/digFile.ts:72`

`readFile` uses `git show HEAD:<path>`, which returns the whole blob into memory. `git()` caps child-process output at 10 MB (`MAX_BUFFER`), so anything above that throws — fine. But a 9 MB binary returned to Claude still inflates context and can effectively DoS a session.

**Fix:** After `readFile` returns, check `content.length` against a reasonable limit (e.g. 1 MB). On overflow, return a readable message pointing the caller at `dig_signatures`.

---

### #4 — Validate package names against a safe charset (High)

**File:** `src/config.ts:342-352`, `buildPackageConfig` at `src/config.ts:105-117`

Package names from `config.json` become path components (`cachePath = path.join(cacheDir, name)` and `pathInRepo = \`${sourceRoot}/${name}\``). A name like `"../evil"` escapes on POSIX (`path.join` normalizes but `..` above the base slips through depending on OS).

**Fix:** Reject names not matching `/^[A-Za-z0-9._-]+$/` or containing `..`. Apply in both the explicit-packages branch and `discoverPackages`.

---

### #5 — Restrict repo URL schemes (High)

**File:** `src/config.ts:324`

`repoDef.url` is trusted as-is. A hostile or mistaken `file:///` URL would make git clone from the local filesystem; `ssh://` is fine but other schemes (`http://`, `git://`) are weakly authenticated.

**Fix:** In `loadConfig`, parse `url` with `new URL()` and reject unless `protocol` is `https:` or `ssh:` (and allow `git@host:…` SSH shorthand — detect by a leading `user@host:` pattern since that's not a valid URL).

---

### #6 — Cache TOCTOU + non-atomic `meta.json` writes (High)

**Files:** `src/tools/digSignatures.ts:75-99`, `src/cacheManager.ts` (`markFresh`, `writeSignature`, `writeOverview`)

Two concurrent tool invocations against the same repo can both see `isFresh=false`, both call `invalidate`, and interleave their regeneration writes. `markFresh` also writes `meta.json` non-atomically — a crash mid-write leaves a half-written JSON file that subsequent runs can't parse.

**Fix:**
1. Atomic `meta.json` writes: write to `meta.json.tmp`, then `fs.rename`.
2. Per-repo in-process mutex (promise map keyed by `repo.name`) that `digOverview` / `digSignatures` acquire around the invalidate→regenerate→markFresh sequence.

---

### #7 — Prototype-pollution hardening on `JSON.parse` (Medium)

**Files:** `src/config.ts:234`, `src/cacheManager.ts:150`

Both sites do `JSON.parse(raw) as T` and trust the shape. Node ≥20 mitigates most real-world exploitation, and the threat model already gives the attacker write access to `config.json` or the cache dir (so the game's largely over). Still: pluck out only the fields we expect rather than letting the parsed object flow downstream.

**Fix:** After `JSON.parse`, explicitly validate type and shape, then construct a fresh object with only known fields.

---

### #8 — Cap fan-out in `discoverPackages` (Medium)

**File:** `src/config.ts:414-456`

`Promise.all` spawns one `fs.access` per candidate directory with no limit. A repo with thousands of dirs under `sourceRoot` stalls the event loop.

**Fix:** `.slice(0, MAX_AUTO_DISCOVERED_PACKAGES)` after filtering, or use a small concurrency limiter. Log a warning if the cap is hit.

---

### #9 — Verify log-file size cap (Medium)

**File:** `src/logger.ts`

The logger plan called for a 5 MB truncation check at `initLogger()`. Verify this actually exists; if not, add it. Without a cap, a long-running server accumulates debug output indefinitely.

---

### #10 — Per-repo mutex for `ensureReady` (Low)

**File:** `src/repoManager.ts:32-82`

Same underlying problem as #6: two concurrent first-run calls both see `isValidRepo=false`, both `rm -rf`, both try to clone into the same dir. One wins, one throws.

**Fix:** Promise cache keyed by `repoConfig.name` — second caller awaits the first. Same mutex as #6 can cover both cases.

---

### #11 — Defensive `filePath` validation in `readFile` (Low)

**File:** `src/gitClient.ts:172-178`

Fix #1 validated `filePath` at the `dig_file` boundary, which is the only current caller. `readFile` is an exported module function — future callers could misuse it. Hardening: validate inside `readFile` too, or at minimum add a JSDoc warning.

---

### #12 — Review symlink-following in `discoverPackages` (Low)

**File:** `src/config.ts:414-456`

`fs.promises.readdir(..., { withFileTypes: true })` returns `Dirent`s whose `isDirectory()` follows symlinks for the stat. A hostile repo could place a symlink under `sourceRoot` pointing outside the repo; `fs.promises.access(csprojPath)` would then probe arbitrary paths. Low impact (only side effect is probing existence), but worth tightening.

**Fix:** Use `fs.promises.lstat` to detect symlinks and skip them, or switch to `readdir` then `stat` with explicit symlink handling.

---

### #13 — Confirm MCP SDK Zod enforcement (Info)

**Files:** `src/tools/digSignatures.ts:41-48`, `src/tools/digFile.ts:27-42`

Reviewer flagged that the Zod `inputSchema` might be declarative-only. Believed to be a false positive — `McpServer.registerTool` in the official SDK does validate inputs through the shape. **Action:** send a malformed call (e.g. `packageName` missing or numeric) and confirm the SDK rejects it before the handler runs. If it doesn't, add explicit validation. If it does, close this item.
