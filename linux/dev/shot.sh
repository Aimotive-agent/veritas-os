#!/usr/bin/env bash
# Screenshot the Herald OS session.
#   Inside the VM:  herald-os-shot [out.png]         (grim via wlr-screencopy; works over SSH)
#   On the Mac:     bash linux/dev/shot.sh [out.png] (runs it in the VM and copies the file back)
set -euo pipefail

OUT="${1:-}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  KEY="$HERE/../vm/build/id_hermes"
  HOST="${HERALD_VM_HOST:-${HERMES_VM_HOST:-127.0.0.1}}"
  PORT="${HERALD_VM_PORT:-${HERMES_VM_PORT:-2222}}"
  OUT="${OUT:-$HERE/../vm/build/shots/herald-os-$(date +%Y%m%d-%H%M%S).png}"
  mkdir -p "$(dirname "$OUT")"
  ssh -q -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null hermes@"$HOST" \
    'bash -s' <"$0" -- /tmp/herald-os-shot.png >/dev/null
  scp -q -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null hermes@"$HOST":/tmp/herald-os-shot.png "$OUT"
  echo "$OUT"
  exit 0
fi

OUT="${OUT:-$HOME/shots/herald-os-$(date +%Y%m%d-%H%M%S).png}"
mkdir -p "$(dirname "$OUT")"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
  WAYLAND_DISPLAY="$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1 || true)"
  export WAYLAND_DISPLAY
fi
[[ -n "${WAYLAND_DISPLAY:-}" ]] || { echo "no Wayland display found in $XDG_RUNTIME_DIR" >&2; exit 1; }
grim "$OUT"
echo "$OUT"
