# AGENTS

This repository runs a local Telegram-to-Codex bridge for this folder.

Main behavior:
- A Telegram message launches a fresh `codex exec` run in this project root.
- The bridge never stores or resumes Codex session ids.
- Default Codex context comes from this file plus `CHANGELOG.md`.
- No local web UI is used; Telegram is the only chat interface.

Core files:
- `src/index.js`: app entrypoint and Telegram polling loop.
- `src/codex.js`: fresh non-interactive Codex exec wrapper.
- `src/telegram.js`: Telegram Bot API polling and replies.
- `src/changelog.js`: keeps `CHANGELOG.md` trimmed to the last 5 entries.

Linear to-do behavior:
- Codex uses MCP server `linear` in OAuth mode (no API key required).
- Team scope is `MAX` unless user requests another team.
- MCP writes depend on Codex client support for MCP elicitation in the current runtime.
