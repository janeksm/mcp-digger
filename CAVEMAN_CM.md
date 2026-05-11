# Cave Man Claude Memory (CMCM)

Zero-infrastructure cross-session memory for Claude Code projects.
Markdown files + git. No Redis, no embeddings, no Python server.

## Problem

Claude forgets everything between sessions. You re-explain patterns, decisions, and context every time.
For a single-developer project, the knowledge corpus is small enough that "read a few files" is the retrieval algorithm.

## Files

| File | Purpose | Format | Git | Written by |
|------|---------|--------|-----|------------|
| `DECISIONS.md` | Why X not Y — decision log | `## date — title` + `Chose/Why` | tracked | `/dev` after planning |
| `PATTERNS.md` | Named reusable code shapes (not duplicating CLAUDE.md) | `## name` + `When/Shape/Examples` | tracked | `/accept` when new pattern found |
| `HANDOFF.md` | Session continuity state | `## Session date` + key-value fields | .gitignored | `/dev` start + `/accept` end |

## Boundary with Other Systems

- **CLAUDE.md** — project rules, build commands, architecture overview, key patterns. Auto-loaded every session. Don't duplicate its content in PATTERNS.md.
- **Auto-memory** (`~/.claude/projects/.../memory/`) — Claude's behavioral preferences (commit style, tool usage, verification habits). Auto-loaded. CMCM does not replace it.
- **CMCM** — code-level architectural knowledge: why this design choice was made, what non-obvious shapes appear in the code, where the last session left off.

## Data Flow

```
/load (session start)
  reads: HANDOFF.md → displays session continuity
         DECISIONS.md, PATTERNS.md → loads into context silently
         project docs (DESIGN.md, TODO.md, etc.) → shows progress

/dev (implementation)
  reads: HANDOFF.md → session continuity (if /load was skipped)
         DECISIONS.md → plan must not contradict prior decisions
         PATTERNS.md → plan should reuse established patterns
  writes: DECISIONS.md → append rejected alternatives (after planning)
          HANDOFF.md → "implementing <task>" (periodic auto-save)

/accept (finalization)
  reads: PATTERNS.md → check for new patterns in diff
  writes: PATTERNS.md → append new pattern if found
          HANDOFF.md → "completed <task>, next: <step>"
```

## File Formats

### DECISIONS.md

```markdown
## YYYY-MM-DD — short title
Chose X over Y.
Why: reasoning that a future session needs to know
```

Rules:
- Append-only — never remove past entries
- When a decision is superseded, annotate the old entry: `> Superseded by: YYYY-MM-DD — new title`
- Only log non-obvious choices where alternatives were seriously considered
- Include enough "why" that a future session can judge if the decision still applies

### PATTERNS.md

```markdown
## pattern-name
When: trigger condition (when should this pattern be applied?)
Shape: how it works (the actual code/architecture shape)
Examples: file1.ts, file2.ts (approximate — use grep to find current usages)
```

Rules:
- PATTERNS.md is the single source of truth for all codebase patterns (CLAUDE.md points here)
- A pattern qualifies if: used in 2+ places, has a non-obvious shape, is codebase-specific
- "Examples" is approximate — files may be renamed. Use grep to verify current usages.

### HANDOFF.md

```markdown
## Session YYYY-MM-DD
**Working on:** task description
**State:** planning | implementing | verifying | completed
**Uncommitted:** file list or "None"
**Next:** next step or task description
```

Rules:
- Ephemeral — overwritten by skills, never manually edited
- .gitignored — never committed
- May be stale if previous session ended abruptly — cross-check against `git status` and `git log`
- If missing, session starts clean (no continuity, which is fine)

## Porting to a New Project

1. Copy `CAVEMAN_CM.md` to the new project root
2. Create empty `DECISIONS.md` with header: `# Technical Decisions`
3. Create `PATTERNS.md` with header + seed patterns from the project's existing conventions (only those NOT in CLAUDE.md)
4. Add `HANDOFF.md` to `.gitignore`
5. Wire into your session skills:
   - Session start skill: read HANDOFF.md, DECISIONS.md, PATTERNS.md (not CAVEMAN_CM.md — it's docs, not runtime context)
   - Planning/dev skill: read DECISIONS + PATTERNS before planning, read HANDOFF for continuity, write HANDOFF after
   - Finalization skill: detect new patterns, write HANDOFF with next step
6. Add a brief reference in CLAUDE.md: `See [CAVEMAN_CM.md](CAVEMAN_CM.md) for the knowledge system.`

## Inspired By

Lightweight alternative to [claude-os](https://github.com/brobertsaz/claude-os) knowledge management.
Core ideas adopted: confidence in decisions, named patterns for reuse, session continuity.
Infrastructure skipped: embeddings, vector DB, Redis, Python server, background workers.

---
*CMCM — Cave Man Claude Memory*
