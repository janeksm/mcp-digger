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

1. **Identify the step.** Read `TODO.md` to find the step. If `$ARGUMENTS` is a number, use that step. Otherwise find the first `in-progress` step.

2. **Pause for user review.** After /simplify completes, show a summary of what will be committed and ask the user to confirm before proceeding. Do NOT commit automatically.

3. **After user confirms — commit.** Follow the standard git commit flow:
   - `git status` and `git diff` to review changes
   - `git add` the relevant source and test files (not TODO.md yet)
   - Commit with a message like: `feat: implement <module> (step N)`
   - Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

4. **Mark step complete in TODO.md.**
   - Change the step's status from `in-progress` to `done`
   - Add the commit hash (short) to the step's entry
   - Stage and amend the commit to include the TODO.md update: `git add TODO.md && git commit --amend --no-edit`

5. **Report.** Show the final commit hash and the updated TODO.md status.
