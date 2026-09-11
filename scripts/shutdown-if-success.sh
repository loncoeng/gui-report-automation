#!/usr/bin/env bash
set -euo pipefail

automation_home="${AUTOMATION_HOME:-/home/automation/gui-report-automation}"
automation_user="${AUTOMATION_USER:-automation}"
display="${DISPLAY:-:20}"
xauthority="${XAUTHORITY:-/home/automation/.Xauthority}"
state_dir="$automation_home/state"
run_lock="$automation_home/run.lock"

log() {
  printf 'POWER_CYCLE %s at=%s\n' "$*" "$(date --iso-8601=seconds)"
}

if [[ "${REPORT_AUTOMATION_ALLOW_POWEROFF:-}" != "1" ]]; then
  log "skip reason=poweroff-not-enabled"
  exit 0
fi

jst_day="$(TZ=Asia/Tokyo date +%d)"
jst_hhmm="$(TZ=Asia/Tokyo date +%H%M)"
if [[ "$jst_day" == "02" ]]; then
  log "skip reason=day-2"
  exit 0
fi
if (( 10#$jst_hhmm < 630 || 10#$jst_hhmm > 1030 )); then
  log "skip reason=outside-safety-window hhmm=$jst_hhmm"
  exit 0
fi

report_date="$(TZ=Asia/Tokyo date -d yesterday +%F)"
state_path="$state_dir/$report_date.json"
if [[ ! -f "$state_path" ]]; then
  log "keep-running reason=state-missing report_date=$report_date"
  exit 0
fi

if ! /usr/bin/node - "$state_path" "$report_date" <<'NODE'
const fs = require("node:fs");
const [statePath, reportDate] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.reportDate !== reportDate || state.status !== "completed" || state.stage !== "completed") {
  process.exit(1);
}
NODE
then
  log "keep-running reason=state-not-completed report_date=$report_date"
  exit 0
fi

# Never create the production lock as root. If it already exists, verify that
# the report service is not holding it before considering a shutdown.
if [[ -e "$run_lock" ]]; then
  if ! /usr/bin/flock --nonblock "$run_lock" /usr/bin/true; then
    log "keep-running reason=run-lock-held report_date=$report_date"
    exit 0
  fi
fi

user_id="$(id -u "$automation_user")"
chrome_running() {
  pgrep -a -u "$user_id" chrome 2>/dev/null | grep -Eq '^[0-9]+ /opt/google/chrome/chrome( |$)'
}

if chrome_running; then
  mapfile -t window_ids < <(
    runuser -u "$automation_user" -- env DISPLAY="$display" XAUTHORITY="$xauthority" \
      wmctrl -lx 2>/dev/null | awk '/google-chrome\.Google-chrome/ { print $1 }'
  )
  if (( ${#window_ids[@]} == 0 )); then
    log "keep-running reason=chrome-window-list-unavailable"
    exit 0
  fi
  for window_id in "${window_ids[@]}"; do
    runuser -u "$automation_user" -- env DISPLAY="$display" XAUTHORITY="$xauthority" \
      wmctrl -ic "$window_id" || true
  done
  for _ in $(seq 1 60); do
    chrome_running || break
    sleep 1
  done
fi

if chrome_running; then
  log "keep-running reason=chrome-did-not-exit-cleanly"
  exit 0
fi

log "poweroff report_date=$report_date state=completed chrome=clean"
sync
/usr/sbin/poweroff
