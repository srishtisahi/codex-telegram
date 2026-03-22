# AGENTS

This repository runs a local Telegram-to-Codex bridge for this folder.

Main behavior:
- A Telegram message is routed to the active Codex session.
- New session creation and resuming are supported with `codex exec` + `codex exec resume`.
- Session metadata is persisted in `sessionid.txt` (last 5 sessions).
- Per-session compact memory is stored in `memory/sessions/<session-id>/context.md`.
- Default Codex context comes from this file plus `CHANGELOG.md` and the active session memory file.
- No local web UI is used; Telegram is the only chat interface.

Core files:
- `src/index.js`: app entrypoint, Telegram polling loop, session command routing.
- `src/codex.js`: non-interactive Codex exec/resume wrapper with thread id capture.
- `src/session-store.js`: session persistence, compact memory summaries, prune/wipe logic.
- `src/commands.js`: Telegram natural-language control command parsing.
- `src/telegram.js`: Telegram Bot API polling and replies.
- `src/changelog.js`: keeps `CHANGELOG.md` trimmed to the last 5 entries.
- `start-bridge.sh`: starts bridge, opens per-session resume terminals, terminates tracked terminal sessions.

Session behavior:
- `/new` or “start new chat” clears active session; next prompt starts a new one.
- `/resume <id|summary>` and `/switch <id|summary>` select a past session.
- `/sessions` lists stored sessions.
- `/end` ends the active session and triggers terminal termination for that session.
- `sessionid.txt` stores `session-id | short summary` for the newest 5 sessions.

Memory behavior:
- Each user message is summarized to at most 10 words and appended to that session’s `context.md`.
- `context.md` also keeps a compact `Projects` section inferred from user prompts.
- “wipe previous memory” or `/wipe` clears all memory and session state.
- “delete irrelevant parts from your memory” prunes low-signal summary entries.
- `/wipe <text>` removes only matching summary entries (partial wipe).

Linear to-do behavior:
- Codex uses MCP server `linear` in OAuth mode (no API key required).
- Team scope is `MAX` unless user requests another team.
- Before execution, Codex adds planned tasks to Linear, then executes one-by-one with in-progress updates.
- If scope changes mid-execution, Codex adds follow-up tasks and continues progress tracking.
- Codex creates/reuses a Linear project with a title of at most 5 words.
- The Linear project short summary stores the session id for reference.
- Linear task names are written normally (no session-id prefix in each task title).
