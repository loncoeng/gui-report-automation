#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "dry-run" && "$mode" != "live" ]]; then
  echo "Usage: $0 dry-run|live" >&2
  exit 2
fi

automation_home="${AUTOMATION_HOME:-$HOME/gui-report-automation}"
app_root="$automation_home/app"
start_chrome_script="${START_CHROME_SCRIPT:-$automation_home/start-chrome.sh}"
display="${DISPLAY:-:20}"
xauthority="${XAUTHORITY:-$HOME/.Xauthority}"
user_id="$(id -u)"
chrome_list_pattern='^[0-9]+ /opt/google/chrome/chrome( |$)'
chrome_process_pattern='^/opt/google/chrome/chrome( |$)'
restore_needed=false

export AUTOMATION_HOME="$automation_home"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$automation_home/chrome-data}"
export START_CHROME_SCRIPT="$start_chrome_script"
export DISPLAY="$display"
export XAUTHORITY="$xauthority"
mkdir -p "$automation_home/logs"

default_chrome_dir="$HOME/.config/google-chrome"
if [[ "$CHROME_USER_DATA_DIR" == "$default_chrome_dir" ]]; then
  echo "Refusing controlled execution against Chrome's default user-data path" >&2
  exit 1
fi
if [[ ! -d "$CHROME_USER_DATA_DIR/Default" || ! -d "$CHROME_USER_DATA_DIR/Profile 1" ]]; then
  echo "Prepared Chrome user-data view is missing Default or Profile 1: $CHROME_USER_DATA_DIR" >&2
  exit 1
fi

restore_chrome() {
  if [[ "$restore_needed" == true && -x "$start_chrome_script" ]]; then
    nohup env DISPLAY="$display" XAUTHORITY="$xauthority" "$start_chrome_script" \
      >"$automation_home/logs/start-chrome-after-run.log" 2>&1 &
  fi
}
trap restore_chrome EXIT

main_chrome_running() {
  pgrep -a -u "$user_id" chrome 2>/dev/null | grep -Eq "$chrome_list_pattern"
}

echo "CONTROLLED_RUN_PREFLIGHT mode=$mode"
npm --prefix "$app_root" run preflight
restore_needed=true

mapfile -t window_ids < <(wmctrl -lx | awk '/google-chrome\.Google-chrome/ { print $1 }')
for window_id in "${window_ids[@]}"; do
  wmctrl -ic "$window_id" || true
done

for _ in $(seq 1 15); do
  main_chrome_running || break
  sleep 1
done

if main_chrome_running; then
  pkill -TERM -u "$user_id" -f "$chrome_process_pattern" || true
fi

for _ in $(seq 1 15); do
  main_chrome_running || break
  sleep 1
done

if main_chrome_running; then
  echo "Chrome did not exit cleanly; refusing to open the profile twice" >&2
  exit 1
fi

echo "CONTROLLED_RUN_BROWSER_RELEASED mode=$mode"
if [[ "$mode" == "dry-run" ]]; then
  npm --prefix "$app_root" run dry-run
else
  npm --prefix "$app_root" run live
fi

echo "CONTROLLED_RUN_OK mode=$mode"
