#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
automation_home="${AUTOMATION_HOME:-$script_dir}"
log_dir="$automation_home/logs"
mkdir -p "$log_dir"
exec >>"$log_dir/start-chrome.log" 2>&1

echo "START_CHROME_BEGIN at=$(date --iso-8601=seconds) display=${DISPLAY:-unset}"

# Xfce can rerun autostart when a CRD session reconnects. Never add another
# window or tab when the authenticated resident Chrome is already running.
if pgrep -a -u "$(id -u)" chrome 2>/dev/null | grep -Eq '^[0-9]+ /opt/google/chrome/chrome( |$)'; then
  echo "START_CHROME_SKIPPED existing_browser=true"
  exit 0
fi

sleep 12
"$script_dir/ensure-display-size.sh"

google-chrome --profile-directory=Default --new-window \
  "https://admin.example.com/reports/daily" \
  >/dev/null 2>&1 &

# Give the project profile enough time to finish creating its own window.
# If the second launch is issued too early, Chrome may route all URLs into the
# first profile window even when --profile-directory is supplied.
sleep 12

mapfile -t chrome_windows_before < <(
  wmctrl -lx 2>/dev/null | awk 'tolower($3) == "google-chrome.google-chrome" { print $1 }'
)

# Start the workspace profile with Drive alone. On some cold starts, the first
# Google tab renders a stale signed-out page before the profile cookies are
# ready, while later tabs are already authenticated. Reload that exact new
# window once after startup settles, then add the three Sheets tabs. This keeps
# the final tab count unchanged and never uses a dummy tab.
google-chrome --profile-directory="Profile 1" --new-window \
  "https://drive.google.com/drive/folders/EXAMPLE_DRIVE_FOLDER_ID" \
  >/dev/null 2>&1 &

workspace_window_id=""
for _ in $(seq 1 30); do
  mapfile -t new_chrome_windows < <(
    wmctrl -lx 2>/dev/null | awk 'tolower($3) == "google-chrome.google-chrome" { print $1 }' |
      while IFS= read -r candidate; do
        is_existing=false
        for existing in "${chrome_windows_before[@]}"; do
          if [[ "$candidate" == "$existing" ]]; then
            is_existing=true
            break
          fi
        done
        if [[ "$is_existing" == false ]]; then
          printf '%s\n' "$candidate"
        fi
      done
  )
  if [[ "${#new_chrome_windows[@]}" -eq 1 ]]; then
    workspace_window_id="${new_chrome_windows[0]}"
    break
  fi
  sleep 1
done

sleep 25
if [[ -n "$workspace_window_id" ]] &&
   wmctrl -lx 2>/dev/null | awk -v id="$workspace_window_id" '
     tolower($1) == tolower(id) && tolower($3) == "google-chrome.google-chrome" { found=1 }
     END { exit found ? 0 : 1 }
   '; then
  xdotool windowactivate --sync "$workspace_window_id"
  active_window_id="$(xdotool getactivewindow)"
  if (( active_window_id == workspace_window_id )); then
    window_title="$(xdotool getwindowname "$workspace_window_id" 2>/dev/null || true)"
    echo "START_CHROME_DRIVE_REFRESH_BEGIN window=$workspace_window_id title=$(printf '%q' "$window_title")"
    xdotool key --clearmodifiers F5
    echo "START_CHROME_DRIVE_REFRESH_SENT window=$workspace_window_id"
  else
    echo "START_CHROME_DRIVE_REFRESH_SKIPPED reason=active-window-mismatch expected=$workspace_window_id actual=$active_window_id"
  fi
else
  echo "START_CHROME_DRIVE_REFRESH_SKIPPED reason=new-workspace-window-not-unique"
fi

sleep 12
google-chrome --profile-directory="Profile 1" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_IMPORT_SPREADSHEET_ID/edit?gid=100000001#gid=100000001" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_MAIN_SPREADSHEET_ID/edit?gid=100000002#gid=100000002" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_DEPARTMENT_SPREADSHEET_ID/edit?gid=100000003#gid=100000003" \
  >/dev/null 2>&1 &

echo "START_CHROME_LAUNCHED at=$(date --iso-8601=seconds)"
