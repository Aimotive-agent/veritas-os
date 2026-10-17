#!/usr/bin/env bash
# Turn a stock Fedora Cloud install into the Herald OS Linux development VM. Runs as root, idempotent.
# Invoked by cloud-init on first boot (see linux/vm/make-seed.sh); safe to re-run by hand:
#
#   sudo bash /usr/local/share/herald-os-linux/provision.sh
#
# The same two halves build the bootc image (linux/image/Containerfile):
#   1. image/packages.sh --dev   packages, the session and CLIs, the boot splash, services
#   2. image/firstboot.sh        the session user's home folder, Hermes Agent, the omakase apps
# and then, for development only: the helper scripts and building the shell from the repo.
set -euo pipefail

PAYLOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HERMES_USER="${HERMES_USER:-hermes}"
HERMES_UID_HOME="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
STATE_DIR=/var/lib/herald-os
LOG=/var/log/herald-os-provision.log

mkdir -p "$STATE_DIR"
exec > >(tee -a "$LOG") 2>&1
# cloud-init prints its own final message either way, so a failure has to say so here.
trap 'echo "==> Provisioning FAILED at line $LINENO. Full log: $LOG"' ERR
echo "==> Herald OS Linux provisioner $(date -Is) (payload $PAYLOAD)"

step() { echo; echo "--- $*"; }

bash "$PAYLOAD/image/packages.sh" --dev
bash "$PAYLOAD/image/firstboot.sh" system
# The development account is set up already (cloud-init made it); the shell's first-boot setup is
# for the image's owners.
sudo -u "$HERMES_USER" -H bash -c 'mkdir -p ~/.config/herald-os && date -Is > ~/.config/herald-os/setup-done'

# ---------------------------------------------------------------------------------------------
step "Developer helpers for $HERMES_USER"
# `install -d` would create ~/.local as root; keep every directory under the home owned by the
# session user or uv/npm fail later.
chown -R "$HERMES_USER:$HERMES_USER" "$HERMES_UID_HOME/.local" "$HERMES_UID_HOME/.config"
for f in build.sh sync.sh restart-shell.sh shot.sh; do
  install -m 0755 -o "$HERMES_USER" -g "$HERMES_USER" "$PAYLOAD/dev/$f" "$HERMES_UID_HOME/.local/bin/herald-os-${f%.sh}"
done

# ---------------------------------------------------------------------------------------------
step "Herald OS shell"
REPO="$HERMES_UID_HOME/Herald-OS"
if mountpoint -q /mnt/herald-os 2>/dev/null; then
  echo "shared folder mounted at /mnt/herald-os; syncing and building"
  sudo -u "$HERMES_USER" -H bash "$PAYLOAD/dev/sync.sh" || echo "WARNING: shell build failed; see above"
elif [[ -d "$REPO/apps/desktop" ]]; then
  echo "repo present at $REPO; building"
  sudo -u "$HERMES_USER" -H bash "$PAYLOAD/dev/build.sh" || echo "WARNING: shell build failed; see above"
else
  echo "repo not present yet. From the Mac run: bash linux/dev/push.sh"
fi

bash "$PAYLOAD/image/firstboot.sh" apps

date -Is >"$STATE_DIR/provisioned"
echo "==> Provisioning complete. greetd will start Herald OS on the next boot (or: systemctl start greetd)."
