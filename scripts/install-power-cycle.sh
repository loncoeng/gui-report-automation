#!/usr/bin/env bash
set -euo pipefail

app_root="${APP_ROOT:-/home/automation/gui-report-automation/app}"
systemd_root="/etc/systemd/system"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this installer as root" >&2
  exit 1
fi

chmod 0755 "$app_root/scripts/shutdown-if-success.sh"
install -m 0644 "$app_root/systemd/chrome-remote-desktop-session" \
  /etc/chrome-remote-desktop-session
install -m 0644 "$app_root/systemd/gui-report-automation-shutdown-watch.service" \
  "$systemd_root/gui-report-automation-shutdown-watch.service"
install -m 0644 "$app_root/systemd/gui-report-automation-shutdown-watch.timer" \
  "$systemd_root/gui-report-automation-shutdown-watch.timer"

systemctl daemon-reload
systemctl enable gui-report-automation-shutdown-watch.timer

echo "POWER_CYCLE_INSTALL_OK"
