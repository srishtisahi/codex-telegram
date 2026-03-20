# CHANGELOG

Keep only the last 5 project changes. Each entry must stay very brief: 1-2 lines.

## 2026-03-19
Added "end other sessions" command handling and phrase matching (including punctuation).
Now keeps active session while ending all others.


## 2026-03-19
Expanded heartbeat NLP parsing so phrases like “start for 15m” trigger start confirmation.


## 2026-03-19
Added model switching (`/models`), heartbeat controls (`/heartbeat`, `/health`), and queue/interrupt/parallel handling.
Codex prompts now load `SAFETY_GUIDE.md`, include subagent/limit signals, send working/thinking acks, and can bypass sandbox on resume.
Heartbeat now runs project work chunks; hard-stop (`stop/pause/revert`) and `/end all` were added.
Interrupt routing is now queue-first and only forks a new parallel session for unrelated questions.


## 2026-03-18
Added `trench/` fuzzy stock dashboard (RSI/volatility/volume) with Buy/Hold/Sell inference rules.
Interactive sliders now compute rule strengths and final signal scores.


## 2026-03-17
Improved resume controls: “resume the previous/last session” and bare `/resume` now select the latest usable session.
