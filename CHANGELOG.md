# CHANGELOG

Keep only the last 5 project changes. Each entry must stay very brief: 1-2 lines.

## 2026-03-17
Standardized user naming to `Srishti` in prompts, greeting, and memory headers.


## 2026-03-17
Added wipe-undo support: `/undo` or “undo memory wipe” restores the most recent memory snapshot.


## 2026-03-17
Added resumable Telegram chat sessions via `codex exec resume`, with `/new`, `/resume`, `/switch`, `/sessions`, `/end`, and session-id reply tagging.


## 2026-03-17
Implemented persistent session memory: `sessionid.txt` (last 5 sessions) and per-session `memory/sessions/<id>/context.md` with 10-word user summaries and project hints.


## 2026-03-17
Added memory controls for full wipe and partial prune (`/wipe`, query-based wipe, irrelevant-memory cleanup), plus terminal spawn/termination helpers in `start-bridge.sh`.
