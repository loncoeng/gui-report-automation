#!/usr/bin/env bash
set -euo pipefail

automation_home="${AUTOMATION_HOME:-$HOME/gui-report-automation}"
display="${DISPLAY:-:20}"
xauthority="${XAUTHORITY:-$HOME/.Xauthority}"
user_id="$(id -u)"

export DISPLAY="$display"
export XAUTHORITY="$xauthority"

main_chrome_running() {
  pgrep -a -u "$user_id" chrome 2>/dev/null | grep -Eq '^[0-9]+ /opt/google/chrome/chrome( |$)'
}

mapfile -t window_ids < <(wmctrl -lx | awk '/google-chrome\.Google-chrome/ { print $1 }')
for window_id in "${window_ids[@]}"; do
  wmctrl -ic "$window_id" || true
done

for _ in $(seq 1 15); do
  main_chrome_running || break
  sleep 1
done

if main_chrome_running; then
  pkill -TERM -u "$user_id" -f '^/opt/google/chrome/chrome( |$)' || true
fi

for _ in $(seq 1 15); do
  main_chrome_running || break
  sleep 1
done

if main_chrome_running; then
  echo "Chrome did not exit cleanly" >&2
  exit 1
fi

nohup env DISPLAY="$display" XAUTHORITY="$xauthority" "$automation_home/start-chrome.sh" \
  >"$automation_home/logs/start-chrome-manual-check.log" 2>&1 &
sleep 32

env \
  DISPLAY="$display" \
  XAUTHORITY="$xauthority" \
  AUTOMATION_HOME="$automation_home" \
  AUTOMATION_CONFIG="$automation_home/app/config/automation.json" \
  CHROME_USER_DATA_DIR="$HOME/.config/google-chrome" \
  START_CHROME_SCRIPT="$automation_home/start-chrome.sh" \
  npm --prefix "$automation_home/app" run preflight

printf 'ONCE_ACTIVE='
systemctl is-active gui-report-automation-once.timer
printf 'NEXT='
systemctl show gui-report-automation-once.timer -p NextElapseUSecRealtime --value
