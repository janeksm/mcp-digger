---
name: accept
description: Accept and finalize — simplify then codex review, dedup, fix all issues, commit, mark done
allowed-tools: Bash PowerShell Read Write Edit Glob Grep AskUserQuestion
argument-hint: [step-number]
---

# Accept Step

Finalize the current implementation step with quality gates before committing. Updates [CMCM](../../CAVEMAN_CM.md) knowledge files (patterns, handoff).

**Step to accept:** $ARGUMENTS (if empty, infer from TODO.md — the first step with status `in-progress`)

## Instructions

### 1. Identify the step

Read `TODO.md` to find the step:
- If `$ARGUMENTS` is a number, use that step.
- Otherwise find the first `in-progress` step.
- If no `in-progress` step exists, inspect `git diff HEAD` and `git status` to summarize changes, pick the next step number, and add a new row with status `in-progress`.

### 2. Simplify (analyze + fix)

Review changed files and apply simplification fixes:
- **Read `CC.md` first** — Node.js / TypeScript clean code rules apply here as the simplify checklist.
- Run `git diff HEAD` to identify changed files and hunks.
- For each changed area, check for: deep nesting (use guard clauses), long functions (split), generic names (make descriptive), dead code (remove), redundant abstractions (inline), unnecessary comments (delete), plus the rules in `CC.md` (non-null assertions, floating promises, `any` types, missing return types on exports, etc.).
- Apply fixes incrementally — one at a time.
- After all simplify fixes, verify: run `npm run typecheck`, `npm run lint`, `npm test` (as separate commands).
- If verification fails, fix the failure before continuing.
- Record what was fixed for the summary in step 5.

### 3. Codex review (on post-simplify code)

Remove any previous `CODEX_REVIEW.md`. Then launch Codex CLI in background (Bash with `run_in_background: true`):

```
codex exec -s read-only -o CODEX_REVIEW.md "You are a senior code reviewer. Review the recent changes (unstaged and staged diffs) in this codebase.

For each finding report:
- Severity: CRITICAL, HIGH, MEDIUM, or LOW
- File path and line number
- What the issue is
- Suggested fix (code snippet if applicable)

Group by severity (CRITICAL first). Format as markdown checklist with - [ ] items." < /dev/null
```

Wait for the background task notification. Read `CODEX_REVIEW.md`. Delete `CODEX_REVIEW.md`.

### 4. Fix Codex findings

Apply every Codex fix, CRITICAL to LOW:
- Skip any finding that duplicates a simplify fix already applied (same file + within 5 lines).
- Work incrementally — one fix at a time.
- After all fixes, verify: run `npm run typecheck`, `npm run lint`, `npm test` (as separate commands).
- If verification fails, fix the failure before continuing.

### 5. Pause for user review

Show summary:
- Findings fixed: count by source (`[codex]`, `[simplify]`, `[codex+simplify]`)
- Files changed
- Verification result (pass/fail for each check)

Ask the user to confirm before committing. Do NOT commit automatically.

### 6. Update docs before commit

**Mark step complete in TODO.md:**
- Change status from `in-progress` to `done`
- Add short commit hash (use placeholder, will update after commit)
- Reorder: `done` steps first (by step number), then unfinished

**Update DESIGN.md** if changes affect MCP server design (tools, transport, annotations, schemas, descriptions, patterns, conventions). Skip for internal changes (bug fixes, refactors, tests).

**Update PATTERNS.md — MANDATORY CHECK.** Review the diff and ask: *"Did this implementation introduce a reusable pattern not yet in PATTERNS.md?"* A pattern qualifies if: (a) used in 2+ places or will clearly be reused, (b) non-obvious shape, (c) codebase-specific.

- If YES → append to `PATTERNS.md`:
  ```
  ## pattern-name
  When: trigger condition
  Shape: how it works
  Examples: file list
  ```
- If NO → skip, but confirm in output: `PATTERNS.md: no new entries (no new reusable patterns)`

### 7. Commit

After user confirms:
- `git add .` to stage the step changes (TODO.md with `PENDING` placeholder in commit-hash column).
- Run `git commit -m "<type>: <message>"` separately. Conventional type + step — e.g. `feat: dig_status MCP tool, lsRemote() connectivity check (step 15)`. One line, no body. No Co-Authored-By or AI attribution (per project rules).
- Capture the new hash: `git rev-parse --short HEAD`.
- Replace `PENDING` in TODO.md with the captured short hash.
- `git add TODO.md` then `git commit --amend --no-edit` (separate commands). Amend is used here only to fold the hash backfill into the same step commit — never create a separate `chore: update TODO hash` commit, never amend pushed commits.

### 8. Write handoff and report (CMCM)

Write `HANDOFF.md` with completed state:

```
## Session YYYY-MM-DD
**Working on:** <completed task description>
**State:** completed
**Uncommitted:** None
**Next:** <next unfinished step from TODO.md, or "No remaining steps">
```

Show final commit hash and updated TODO.md status. Then tell the user to run `/clear` to start a fresh session.
