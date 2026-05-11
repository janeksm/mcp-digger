---
name: load
description: Load project context (DESIGN.md, TODO.md, knowledge system files), show progress summary, and wait for user direction
disable-model-invocation: true
allowed-tools: Read
---

# Load Project Context

Bootstrap a working session by loading project docs and [CMCM](../../CAVEMAN_CM.md) knowledge files (decisions, patterns, handoff), then showing progress. Do NOT start planning automatically — wait for the user to choose what to work on.

## Instructions

1. **Read project docs.** Read all files in parallel (missing files are fine — skip silently):
   - `DESIGN.md` — current MCP server design
   - `TODO.md` — implementation progress
   - `DECISIONS.md` — CMCM: technical decision log (load into context, don't display)
   - `PATTERNS.md` — CMCM: reusable code patterns (load into context, don't display)
   - `HANDOFF.md` — CMCM: session continuity state (display if present)

2. **Session continuity.** If `HANDOFF.md` exists and has content beyond the header, display it before the progress summary:

   ```
   --- Session Continuity ---
   Working on: <task from HANDOFF.md>
   State: <state>
   Next: <next step>
   ---
   ```

   If HANDOFF.md is missing or empty, skip this step silently.

3. **Show progress summary.** From the TODO table, display:
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

4. **Prompt for next action.** After the progress summary, print exactly:

   ```
   Pick one:
     1. next — start the next unfinished step
     2. new  — describe a new task manually
   ```

   Stop and wait for the user's reply. On the next turn:
   - If the user picks **next**: invoke `/dev <step-number>` for the first remaining step from the TODO table.
   - If the user picks **new**: ask for the task description, then invoke `/dev <description>`.

## Task Workflow

Each TODO task follows this status lifecycle:

1. **Start work** — set status to `in-progress` in TODO.md.
2. **Implement & verify** — make changes, run `npm run typecheck && npm run lint && npm test`.
3. **Ready for accept** — leave status as `in-progress`. Do not set `done` manually.
4. **`/accept <step>`** — only the user running `/accept` commits and marks the step `done`.

Never skip steps or set status to `done` directly.
