#!/usr/bin/env bash
set -eu

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

sleep 12
"$script_dir/ensure-display-size.sh"

google-chrome --profile-directory=Default --new-window \
  "https://admin.example.com/reports/daily" \
  >/dev/null 2>&1 &

# Give the project profile enough time to finish creating its own window.
# If the second launch is issued too early, Chrome may route all URLs into the
# first profile window even when --profile-directory is supplied.
sleep 12
google-chrome --profile-directory="Profile 1" --new-window \
  "https://drive.google.com/drive/folders/EXAMPLE_DRIVE_FOLDER_ID" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_IMPORT_SPREADSHEET_ID/edit?gid=100000001#gid=100000001" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_MAIN_SPREADSHEET_ID/edit?gid=100000002#gid=100000002" \
  "https://docs.google.com/spreadsheets/d/EXAMPLE_DEPARTMENT_SPREADSHEET_ID/edit?gid=100000003#gid=100000003" \
  >/dev/null 2>&1 &
