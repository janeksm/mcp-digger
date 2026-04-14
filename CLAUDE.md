# mcp-digger

## Claude Rules

- Always use context7 when I need code generation, setup or configuration steps, or library/API documentation.
- Don't combine `cd` with other commands (e.g. `cd /path && git status`). Run commands directly using absolute paths instead (e.g. `git -C /path status`). Compound commands can't be matched against the allowed permissions list, causing unnecessary confirmation prompts.
