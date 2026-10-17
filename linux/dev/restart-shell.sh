#!/usr/bin/env bash
# Restart the running Herald OS shell. herald-os-session treats a non-zero exit as a crash and
# relaunches Electron with the freshly built code; if no session is running, start greetd.
set -u

if pgrep -x electron >/dev/null 2>&1 || pgrep -f 'electron .*apps/desktop' >/dev/null 2>&1; then
  echo "==> restarting shell"
  pkill -TERM -f 'electron .*apps/desktop' || pkill -TERM -x electron || true
  exit 0
fi

if ! systemctl is-active --quiet greetd; then
  echo "==> starting greetd"
  sudo systemctl start greetd
else
  echo "==> no shell process found; session should be starting"
fi
