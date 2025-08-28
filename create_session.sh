#!/usr/bin/env bash
set -Eeuo pipefail

# ----------------- Configuration -----------------
if ! command -v jq &> /dev/null; then
    echo "[ERR] jq is not installed. Please install it to continue (e.g., 'sudo apt-get install jq')."
    exit 1
fi

CONFIG_FILE="config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[ERR] config.json not found!"
    exit 1
fi

# Read settings from config.json
SESS_ROOT=$(jq -r '.sessionRoot' "$CONFIG_FILE")
DISPLAY_MIN=$(jq -r '.display.min' "$CONFIG_FILE")
DISPLAY_MAX=$(jq -r '.display.max' "$CONFIG_FILE")
WINDOW_SIZE=$(jq -r '.windowSize' "$CONFIG_FILE")
RES=$(jq -r '.display.resolution' "$CONFIG_FILE")
CHROME_BIN=$(jq -r '.chromeBin' "$CONFIG_FILE")
SINK_PREFIX=$(jq -r '.audio.sinkPrefix' "$CONFIG_FILE")
SINK_SCOPE=$(jq -r '.audio.sinkScope' "$CONFIG_FILE")
export RATE=$(jq -r '.audio.rate' "$CONFIG_FILE")
export CHUNK_MS=$(jq -r '.audio.chunkMs' "$CONFIG_FILE")

# Export variables for attach.js and audio pipeline
export BOT_NAME=$(jq -r '.botName' "$CONFIG_FILE")
export MEET_RELOAD_TIMEOUT_MS=$(jq -r '.timeouts.meetOverallMs' "$CONFIG_FILE")
export MEET_RELOAD_WAIT_MS=$(jq -r '.timeouts.meetReloadMs' "$CONFIG_FILE")
export API_KEY_FILE=$(jq -r '.transcription.apiKeyFile' "$CONFIG_FILE")
export TRANSCRIBE_MODEL=$(jq -r '.transcription.model' "$CONFIG_FILE")
export LANG_CODE=$(jq -r '.transcription.language' "$CONFIG_FILE")
export OPENAI_WS_URL=$(jq -r '.transcription.wsUrl' "$CONFIG_FILE")
export OUT_WS_URL=$(jq -r '.transcription.forwarderUrl' "$CONFIG_FILE")


# ---------------- inputs ----------------
URL="${1:-}"                                   
[[ -z "$URL" ]] && { echo "usage: $0 <meeting_url>"; exit 1; }
LANGUAGE_CODE="${2:-$(jq -r '.transcription.language' "$CONFIG_FILE")}"
export LANG_CODE="$LANGUAGE_CODE"

# --- session scaffolding ---
SESSION_ID="${SESSION_ID:-$(cat /proc/sys/kernel/random/uuid)}"
SESS_DIR="${SESS_ROOT}/${SESSION_ID}"
mkdir -p "$SESS_DIR"
echo "$SESSION_ID" > "${SESS_DIR}/session.id"
printf '%s\n' "URL=$URL" "STARTED_AT=$(date -Is)" > "${SESS_DIR}/meta"

# ---------------- auto pick display ----------------
find_free_display() {
  local d
  for d in $(seq "$DISPLAY_MIN" "$DISPLAY_MAX"); do
    pgrep -fa "Xvfb :${d}\b" >/dev/null 2>&1 || { echo "$d"; return 0; }
  done
  return 1
}
DISPLAY_NUM="${DISPLAY_NUM:-$(find_free_display)}"
[[ -z "$DISPLAY_NUM" ]] && { echo "[ERR] no free X display"; exit 1; }
DISPLAY=":${DISPLAY_NUM}"

# ---------------- audio sink naming ----------------
if [[ "$SINK_SCOPE" == "per_display" ]]; then
  SINK_NAME="${SINK_PREFIX}_d${DISPLAY_NUM}"
else
  SINK_NAME="${SINK_PREFIX}_${SESSION_ID}"
fi
MON_SRC="${SINK_NAME}.monitor"

# ---------------- PIDs & state ----------------
XVFB_PID=""; CHROME_PID=""; ATTACH_PID=""; SINK_MODULE_ID=""
PIDFILE="${SESS_DIR}/pids.env"

save_pids() {
  cat > "$PIDFILE" <<EOF
SESSION_ID="$SESSION_ID"
SESS_DIR="$SESS_DIR"
DISPLAY="$DISPLAY"
DISPLAY_NUM="$DISPLAY_NUM"
XVFB_PID="$XVFB_PID"
CHROME_PID="$CHROME_PID"
ATTACH_PID="$ATTACH_PID"
SINK_NAME="$SINK_NAME"
SINK_MODULE_ID="$SINK_MODULE_ID"
REMOTE_PORT="${REMOTE_PORT:-}"
SINK_SCOPE="${SINK_SCOPE}"
EOF
}

cleanup_session() {
    local dir_to_clean="$1"
    echo "[CLEANUP] Cleaning up session in $dir_to_clean"
    if [[ -f "$dir_to_clean/pids.env" ]]; then
        source "$dir_to_clean/pids.env" || true
        [[ -n "${ATTACH_PID:-}" ]] && kill -9 "$ATTACH_PID" 2>/dev/null || true
        [[ -n "${CHROME_PID:-}" ]] && kill -9 "$CHROME_PID" 2>/dev/null || true
        [[ -n "${XVFB_PID:-}" ]] && kill -9 "$XVFB_PID" 2>/dev/null || true
        if [[ -n "${SINK_MODULE_ID:-}" ]]; then
            pactl unload-module "${SINK_MODULE_ID}" 2>/dev/null || true
        fi
    fi
    rm -rf -- "$dir_to_clean"
}

trap 'cleanup_session "$SESS_DIR"' EXIT INT TERM

# ---------------- URL type detection ----------------
LOWER_URL="$(printf '%s' "$URL" | tr '[:upper:]' '[:lower:]')"
TYPE=""
case "$LOWER_URL" in
  zoommtg://*|*zoom.us*|*zoom.com*) TYPE="zoom" ;;
  *meet.google.com*|*g.co/meet*)    TYPE="google" ;;
  *teams.microsoft.com*|*teams.live.com*|*office.com*) TYPE="teams" ;;
  *) echo "[ERR] Unrecognized meeting URL: $URL"; exit 1 ;;
esac
export TYPE

# ---------------- env for X / audio ----------------
export DISPLAY
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
export PULSE_SERVER="unix:${XDG_RUNTIME_DIR}/pulse/native"

# ---------------- Find and clean conflicting sessions ----------------
echo "[INFO] Checking for conflicting sessions using DISPLAY=$DISPLAY..."
for d in "$SESS_ROOT"/*/; do
    if [[ ! -d "$d" || "$d" == "$SESS_DIR/" ]]; then continue; fi
    if [[ -f "$d/pids.env" ]]; then
        if grep -q "DISPLAY_NUM=\"$DISPLAY_NUM\"" "$d/pids.env"; then
            cleanup_session "$d"
        fi
    fi
done

# ---------------- ensure sink ----------------
if pactl list short sinks | awk '{print $2}' | grep -qx "$SINK_NAME"; then
  echo "[INFO] Sink '$SINK_NAME' still exists. Unloading it."
  SINK_MODULE_ID_TO_UNLOAD=$(pactl list short modules | grep "sink_name=$SINK_NAME" | awk '{print $1}' || true)
  if [[ -n "$SINK_MODULE_ID_TO_UNLOAD" ]]; then
    pactl unload-module "$SINK_MODULE_ID_TO_UNLOAD"
  fi
fi

echo "[INFO] Creating null sink: $SINK_NAME"
SINK_MODULE_ID="$(pactl load-module module-null-sink "sink_name=$SINK_NAME" "sink_properties=device.description=${SINK_NAME}")"

# ---------------- Xvfb ----------------
echo "[INFO] Starting new Xvfb on $DISPLAY"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 "$RES" -nolisten tcp -ac >"/tmp/xvfb-${SESSION_ID}.log" 2>&1 &
XVFB_PID=$!; sleep 0.6
save_pids

# ---- pick a free remote-debugging port per session ----
find_free_port() {
  local start=9222 end=9722 p
  for ((p=start; p<=end; p++)); do
    if ss -Htanl 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p$"; then
        continue
    fi
    echo "$p"; return 0
  done
  return 1
}
: "${REMOTE_PORT:=$(find_free_port)}" || { echo "[ERR] no free remote-debugging port"; exit 1; }

# ---------------- Chromium ----------------
PROFILE_DIR="${SESS_DIR}/chrome-profile"
mkdir -p "$PROFILE_DIR/Default"

echo "[INFO] launching $CHROME_BIN (port $REMOTE_PORT) -> $URL"
"$CHROME_BIN" \
  --no-sandbox \
  --disable-gpu \
  --window-size="$WINDOW_SIZE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$REMOTE_PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --lang=en-US \
  --disable-popup-blocking \
  --allow-popups-during-page-unload \
  --disable-session-crashed-bubble \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36" \
  --use-fake-ui-for-media-stream \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-extensions \
  --media-cache-size=0 \
  --disk-cache-size=0 \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies,AudioServiceSandbox,AudioServiceOutOfProcess \
  "$URL" >"/tmp/chrome-${SESSION_ID}.log" 2>&1 &
CHROME_PID=$!
save_pids

# ---------------- wait for DevTools WS ----------------
echo "[INFO] waiting for DevTools endpoint on :$REMOTE_PORT ..."
WS_URL=""
for _ in $(seq 1 120); do
  WS_URL="$(curl -sS "http://127.0.0.1:${REMOTE_PORT}/json/version" \
    | grep -oE '"webSocketDebuggerUrl":\s*"[^"]+"' | cut -d\" -f4 || true)"
  [[ -n "$WS_URL" ]] && break
  sleep 0.25
done
[[ -z "$WS_URL" ]] && { echo "[ERR] DevTools endpoint not available"; exit 3; }
echo "[INFO] DevTools: $WS_URL"

# ---------------- run attach.js ----------------
echo "[INFO] starting attach.js"
TYPE="$TYPE" WS_URL="$WS_URL" REMOTE_PORT="$REMOTE_PORT" node attach.js "$WS_URL" >"/tmp/attach-${SESSION_ID}.log" 2>&1 &
ATTACH_PID=$!
save_pids

# ---------------- audio pipeline ----------------
echo "[INFO] capturing $MON_SRC @ ${RATE} Hz mono"
parec -d "$MON_SRC" --format=s16le --rate="$RATE" --channels=1 --raw \
  | stdbuf -oL -eL env SR="$RATE" CHUNK_MS="$CHUNK_MS" node pcm16_to_ndjson.js \
  | stdbuf -oL -eL node ndjson_to_openai_ws.js \
  | stdbuf -oL -eL node openai_to_ws.js
  rc=$?
  echo "[WARN] audio pipeline exited with $rc; restarting in 3s..."
  sleep 3
done

# pipeline finished:
cleanup_success
