#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERMINAL_DIR="$ROOT_DIR/.bridge-terminals"
mkdir -p "$TERMINAL_DIR"

open_session_terminal() {
  local session_id="$1"
  local escaped_root
  escaped_root=$(printf '%q' "$ROOT_DIR")

  # macOS Terminal.app
  if command -v osascript >/dev/null 2>&1; then
    local cmd
    cmd="cd $escaped_root; mkdir -p .bridge-terminals; echo \$\$ > .bridge-terminals/${session_id}.pid; codex resume ${session_id}; rm -f .bridge-terminals/${session_id}.pid"
    osascript -e "tell application \"Terminal\" to do script \"$cmd\"" >/dev/null
    echo "Opened Terminal session for $session_id"
    return 0
  fi

  # Linux fallback: new gnome-terminal if available
  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash -lc "cd '$ROOT_DIR'; mkdir -p .bridge-terminals; echo \$\$ > .bridge-terminals/${session_id}.pid; codex resume ${session_id}; rm -f .bridge-terminals/${session_id}.pid"
    echo "Opened gnome-terminal session for $session_id"
    return 0
  fi

  echo "No supported terminal launcher found (osascript/gnome-terminal)." >&2
  return 1
}

end_session_terminal() {
  local session_id="$1"
  local pid_file="$TERMINAL_DIR/${session_id}.pid"

  if [[ ! -f "$pid_file" ]]; then
    echo "No tracked terminal PID for session $session_id"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    sleep 0.2
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" || true
    fi
  fi
  rm -f "$pid_file"
  echo "Terminated terminal session for $session_id"
}

case "${1:-run}" in
  run)
    cd "$ROOT_DIR"
    npm start
    ;;
  open-session)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 open-session <session-id>" >&2
      exit 1
    fi
    open_session_terminal "$2"
    ;;
  end-session)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 end-session <session-id>" >&2
      exit 1
    fi
    end_session_terminal "$2"
    ;;
  *)
    echo "Usage: $0 [run|open-session <id>|end-session <id>]" >&2
    exit 1
    ;;
esac
