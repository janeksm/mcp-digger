---
name: load
description: Load project context (DESIGN.md + TODO.md), show progress summary, and wait for user direction
disable-model-invocation: true
allowed-tools: Read
---

# Load Project Context

Bootstrap a working session by loading key project docs and showing progress. Do NOT start planning automatically — wait for the user to choose what to work on.

## Instructions

1. **Read project docs.** Read both files in parallel:
   - `DESIGN.md` — current MCP server design
   - `TODO.md` — implementation progress

2. **Show progress summary.** From the TODO table, display:
   - The **last completed step** (highest step number with status `done`)
   - **All remaining steps** (any status other than `done`: `—`, `in-progress`, `blocked`)

   Format as a concise summary, e.g.:

   ```
   Last completed: Step 15 — dig_status MCP tool, lsRemote() connectivity check (a2ceae8)

   Remaining:
   | Step | Module | Status | Notes |
   |------|--------|--------|-------|
   | 10   | index.ts | —   | DRY version: read from package.json ... |
   ```

3. **Prompt for next action.** After the progress summary, print exactly:

   ```
   Pick one:
     1. next — plan the next unfinished step from TODO.md
     2. new  — describe a new task manually
   ```

   Do **not** call `EnterPlanMode`. Stop and wait for the user's reply. On the next turn:
   - If the user picks **A**: begin planning the first remaining step from the TODO table (enter plan mode then).
   - If the user picks **B**: ask them for the task description, then plan that task.

## Task Workflow

Each TODO task follows this status lifecycle:

1. **Start work** — set status to `in-progress` in TODO.md.
2. **Implement & verify** — make changes, run `npm run typecheck && npm run lint && npm test`.
3. **Ready for accept** — leave status as `in-progress`. Do not set `done` manually.
4. **`/accept <step>`** — only the user running `/accept` commits and marks the step `done`.

Never skip steps or set status to `done` directly.
