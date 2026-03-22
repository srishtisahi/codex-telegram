# CHANGELOG

Keep only the last 5 project changes. Each entry must stay very brief: 1-2 lines.

## 2026-03-22
Added heartbeat log cleanup controls: `/heartbeat wipe` for full reset and `/heartbeat wipe <text>` for targeted event pruning.
Heartbeat wipe commands are handled as immediate control actions in Telegram flow.


## 2026-03-22
Updated SAFETY_GUIDE Linear policy to project-based tracking with session id in project summary.
Removed outdated instruction to prefix every Linear task title with session id.


## 2026-03-21
Heartbeat commands are now handled immediately and no longer stop on every new Telegram message.
Heartbeat can be armed to auto-start with the next real project task; mixed task+heartbeat prompts now queue task context correctly.


## 2026-03-21
Linear workflow now creates/reuses a <=5-word project title and stores session id in project summary.
Tasks are added before execution and updated during execution, without session-id task title prefixes.


## 2026-03-19
Added "end other sessions" command handling and phrase matching (including punctuation).
Now keeps active session while ending all others.
