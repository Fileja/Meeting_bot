#!/usr/bin/env bash
set -euo pipefail

ROOT="${SESS_ROOT:-/tmp/realtime-sessions}"
MODE="${1:-running}"      # running | --all | --stale

shopt -s nullglob

header() {
  printf "%-7s  %-12s  %-6s  %-30s  %s\n" \
    "STATE" "SESSION" "DSP" "SINK" "PIDS(alive)"
}

is_alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

row() {
  local state="$1" sid="$2" dsp="$3" sink="$4" pids="$5"
  printf "%-7s  %-12s  %-6s  %-30s  %s\n" \
    "$state" "${sid:0:12}" "$dsp" "$sink" "$pids"
}

header
for dir in "$ROOT"/*; do
  [[ -d "$dir" ]] || continue
  sid="$(basename "$dir")"
  pfile="$dir/pids.env"

  if [[ ! -f "$pfile" ]]; then
    [[ "$MODE" = "--all" ]] && row "ORPHAN" "$sid" "-" "-" "-"
    continue
  fi

  # shellcheck disable=SC1090
  source "$pfile"

  # any key pid alive?
  alive_pids=()
  for pid in "${ATTACH_PID:-}" "${CHROME_PID:-}" "${XVFB_PID:-}"; do
    if is_alive "$pid"; then alive_pids+=("$pid"); fi
  done
  is_running=0; (( ${#alive_pids[@]} > 0 )) && is_running=1

  # filter by mode
  [[ "$MODE" = "running" && $is_running -eq 0 ]] && continue
  [[ "$MODE" = "--stale"   && $is_running -eq 1 ]] && continue

  state="ACTIVE"
  if (( is_running == 0 )); then
    state="STALE"
  fi

  # does the sink still exist?
  sink_present="-"
  if [[ -n "${SINK_NAME:-}" ]]; then
    if pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx "$SINK_NAME"; then
      sink_present="$SINK_NAME"
    else
      sink_present="${SINK_NAME}*gone"
    fi
  fi

  row "$state" "$sid" "${DISPLAY:-"-"}" "$sink_present" "${alive_pids[*]:-none}"
done
