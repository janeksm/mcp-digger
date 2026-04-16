---
name: accept
description: Accept and finalize the current implementation step — commits changes locally and marks the step done in TODO.md
disable-model-invocation: true
allowed-tools: Bash(git *) Read Edit
argument-hint: [step-number]
---

# Accept Step

Finalize the current implementation step by committing and updating TODO.md.

**Step to accept:** $ARGUMENTS (if empty, infer from TODO.md — the first step with status `in-progress`)

## Instructions

1. **Identify the step.** Read `TODO.md` to find the step:
   - If `$ARGUMENTS` is a number, use that step.
   - Otherwise find the first `in-progress` step.
   - If no `in-progress` step exists, **create a new step**: inspect `git diff HEAD` and `git status` to summarize the changes, pick the next step number, and add a new row to the TODO table with status `in-progress`. Use the primary module or feature name as the Module column.

2. **Run /simplify.** Invoke the `/simplify` skill to review and clean up the code before committing.

3. **Pause for user review.** After /simplify completes, show a summary of what will be committed and ask the user to confirm before proceeding. Do NOT commit automatically.

4. **After user confirms — commit.** Follow the standard git commit flow:
   - `git status` and `git diff` to review changes
   - `git add` the relevant source and test files (not TODO.md yet)
   - Commit with a message like: `feat: implement <module> (step N)`
   - Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

5. **Mark step complete in TODO.md.**
   - Change the step's status from `in-progress` to `done`
   - Add the commit hash (short) to the step's entry
   - **Reorder rows** so all `done` steps appear first (sorted by step number), followed by any not-finished steps (`—`, `in-progress`, `blocked`) at the bottom

6. **Update DESIGN.md.** If the committed changes affect the MCP server design (new/changed/removed tools, transport, annotations, input schemas, tool descriptions, interaction patterns, or shared conventions), update `DESIGN.md` to reflect the current state. Keep the existing structure and only change what's relevant. Skip this step if the changes are purely internal (bug fixes, refactors, tests) with no impact on the MCP tool surface.

7. **Amend commit with doc updates.** Stage the doc files and amend: `git add TODO.md DESIGN.md && git commit --amend --no-edit`

8. **Report.** Show the final commit hash and the updated TODO.md status.
