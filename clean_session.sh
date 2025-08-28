#!/usr/bin/env bash
set -euo pipefail
SID="${1:-}"; [[ -z "$SID" ]] && { echo "usage: clean_session.sh <SESSION_ID>"; exit 1; }
ROOT="${SESS_ROOT:-/tmp/realtime-sessions}"
DIR="$ROOT/$SID"

[[ -f "$DIR/pids.env" ]] && source "$DIR/pids.env" || true
[[ -n "${WATCHDOG_PID:-}" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
[[ -n "${ATTACH_PID:-}"   ]] && kill "$ATTACH_PID"   2>/dev/null || true
[[ -n "${CHROME_PID:-}"   ]] && kill "$CHROME_PID"   2>/dev/null || true
[[ -n "${XVFB_PID:-}"     ]] && kill "$XVFB_PID"     2>/dev/null || true

if [[ -f "$DIR/sink.module" ]]; then
  MID="$(cat "$DIR/sink.module" || true)"
  [[ -n "$MID" ]] && pactl unload-module "$MID" 2>/dev/null || true
fi

rm -rf "$DIR"
echo "[OK] cleaned $SID"
