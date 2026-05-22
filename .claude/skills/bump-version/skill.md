---
name: bump-version
description: Bump version, tag, and push for a Node/npm repo. Analyzes commits since the last tag, proposes a semver bump (patch/minor/major) per Conventional Commits, asks the user to confirm or override, then runs `npm version` and `git push --follow-tags`. Use when the user says "release", "publish", "bump version", "ship", "cut release", "tag new version".
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# bump-version

Propose semver bump from commit history → user confirms → `npm version` + `git push --follow-tags`. Does NOT publish to npm; publish driven by CI on tag push.

## 0. Permissions (first run only)

If `~/.claude/settings.json` `permissions.allow` missing any, Edit in:
- `Skill(bump-version)`
- `Bash(npm version *)`
- `Bash(git push --follow-tags *)`
- `Bash(git describe *)`
- `Bash(git log *)`
- `Bash(git fetch *)`

## 1. Pre-flight

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git fetch --tags origin
git describe --tags --abbrev=0 2>/dev/null || echo "(no tags)"
node -p "require('./package.json').version"
```

Refuse if: dirty tree, not on main/master, local behind origin, detached HEAD. Tell user what to fix.

## 2. Classify commits

```bash
git log <last-tag>..HEAD --pretty=format:'%h %s' --no-merges
```

- `BREAKING CHANGE` in body OR `!` after type (`feat!:`) → **major**
- `feat:` → **minor**
- `fix:` / `perf:` / `refactor:` → **patch**
- `chore:` / `docs:` / `test:` / `ci:` / `style:` / `build:` alone → no bump

Highest wins. No commits → "nothing to release"; stop.

## 3. Propose + confirm

Compute proposed version from current + classifier. AskUserQuestion:
- `<proposed>` (Recommended) — show classifier reason
- one step up + one step down
- "Custom" (free input via Other)

Question body: current version, reason, top 5 commit subjects.

## 4. Bump + push

After confirm `<v>`, validate semver `^\d+\.\d+\.\d+(-[\w.]+)?$` and strictly greater than current:

```bash
npm version <v>
git push --follow-tags origin <branch>
```

`--follow-tags` pushes branch + annotated tags reachable. `npm version` creates annotated tags → correct combo.

## 5. Report

`<old> -> <new>` · tag · branch pushed · "tag push triggers CI release workflow — check Actions tab".

## Notes

- Pre-release tags (`1.2.0-rc.1`) accepted — warn if CI workflow doesn't handle dist-tags.
- Re-tagging refused (surface git error verbatim).
- Single-package repos only — workspaces use `changesets`/`release-please`.
