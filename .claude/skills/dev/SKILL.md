---
name: dev
description: Full TDD development cycle — plan, skeptic review, implement, verify, auto-accept
argument-hint: <step-number or task-description>
---

# Dev Cycle

Full TDD development cycle from planning through verified implementation. Reads/writes [CMCM](../../CAVEMAN_CM.md) knowledge files (decisions, patterns, handoff).

**Task:** $ARGUMENTS

## Instructions

### Phase 1 — Dual-Source Plan + Skeptic Review

1. **Resolve task context.**
   - If `$ARGUMENTS` is a step number: read `TODO.md` for task details (description, rationale, files).
   - If `$ARGUMENTS` is a description: use it directly.
   - Read CMCM files (if they exist, skip silently if missing):
     - `HANDOFF.md` — if present, display session continuity before proceeding (covers the case where `/load` was skipped)
     - `DECISIONS.md` — prior technical decisions (stays in context for planning)
     - `PATTERNS.md` — established code patterns (stays in context for planning)

2. **Run /plan-x.** Invoke the plan-x skill with the task description. This handles:
   - Launching Codex planning in background
   - Interactive plan mode with the user
   - Merging Codex additions into the approved plan
   - Skeptic review via /plan-review

   DECISIONS.md and PATTERNS.md are already in context from step 1. When formulating the plan:
   - Reference relevant decisions — the plan must not contradict prior decisions without explicitly revisiting them.
   - Reference applicable patterns — the plan should reuse established patterns rather than inventing new approaches.

3. Wait for /plan-x to complete (plan approved, reviewed, and finalized) before continuing.

### Phase 2 — Record Decisions & Session State

4. **Log rejected alternatives — MANDATORY CHECK.** After the plan is approved, explicitly review the planning discussion and ask: *"Were any alternative approaches considered and rejected?"*

   - If YES → append to `DECISIONS.md`:
     ```
     ## YYYY-MM-DD — short title
     Chose X over Y.
     Why: reasoning from the plan discussion
     ```
   - If NO (straightforward, no real alternatives) → skip, but confirm in output: `DECISIONS.md: no new entries (no alternatives considered)`

5. **Write HANDOFF.md.** Overwrite `HANDOFF.md` with current session state:

   ```
   ## Session YYYY-MM-DD
   **Working on:** <task description>
   **State:** implementing
   **Uncommitted:** None (implementation starting)
   **Next:** <first implementation step from the plan>
   ```

### Phase 3 — TDD Implementation

6. **Mark in-progress.** If this is a TODO step, set its status to `in-progress` in `TODO.md`. Also update `HANDOFF.md` state to `implementing` with the current uncommitted file list.

7. **Red — write failing tests.** For each planned change:
   - Write or update test cases that describe the expected behavior.
   - Run `npm test` to confirm the new/changed tests **fail**.
   - If they pass without code changes, the test isn't covering new behavior — fix it.

8. **Green — write implementation.** Make the minimal code changes to pass the failing tests.

9. **Verify.** Run all three checks (as separate commands, not chained):
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`

   All three must pass. Fix any failures before proceeding.

### Phase 4 — Finalize

10. **Auto-accept.** If all three checks pass, invoke `/accept` automatically (pass the step number if this is a TODO step). Do NOT prompt the user — go straight to accept.
