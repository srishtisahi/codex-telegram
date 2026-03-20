# Heartbeat

Tracks heartbeat lifecycle for long-running Telegram-driven tasks.

- This file is append-only during runtime.
- Entries use ISO timestamp format.
- Pings are logged every 5 minutes while heartbeat is active.
- 2026-03-19T11:33:52.721Z | START | duration=15m | ping=5m | status=10m
- 2026-03-19T11:38:52.733Z | PING | Continue active task and keep context warm.
- 2026-03-19T11:43:52.743Z | PING | Continue active task and keep context warm.
- 2026-03-19T11:44:26.802Z | STOP | new Telegram message received
- 2026-03-19T11:45:33.847Z | START | duration=10m | ping=5m | status=10m
- 2026-03-19T11:45:49.210Z | STOP | new Telegram message received
