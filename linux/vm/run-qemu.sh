#!/usr/bin/env bash
# Boot Herald OS Linux in QEMU (Apple Hypervisor) from the terminal. This is the scriptable twin of
# the UTM setup in linux/README.md: same qcow2 image, same seed, same SSH port, so everything in
# linux/dev/ works against either.
#
#   bash linux/vm/run-qemu.sh              # window on the Mac, SSH on 127.0.0.1:2222
#   HEADLESS=1 bash linux/vm/run-qemu.sh   # VNC on 127.0.0.1:5901 instead of a window
#   bash linux/vm/run-qemu.sh --image herald-os-<v>-aarch64.qcow2   # boot a built Herald OS image
#   bash linux/vm/run-qemu.sh stop|status|console|reset
#
# First boot runs cloud-init provisioning (several minutes: dnf + Hermes Agent install). Watch it
# with `bash linux/vm/run-qemu.sh console`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"
VERSION="${FEDORA_VERSION:-44}"
BASE="$BUILD/fedora-cloud-${VERSION}-aarch64.qcow2"
DISK="$BUILD/herald-os.qcow2"
SEED="$BUILD/cidata.iso"
# --image: a Herald OS disk from bootc-image-builder; it sets itself up on the first boot, no seed.
IMAGE=""
if [[ "${1:-}" == "--image" ]]; then
  IMAGE="$(cd "$(dirname "${2:?--image needs a qcow2}")" && pwd)/$(basename "$2")"
  shift 2
  BASE="$IMAGE"
  DISK="$BUILD/herald-os-image.qcow2"
fi
EFI_CODE="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/share/qemu/edk2-aarch64-code.fd"
EFI_VARS_SRC="$(dirname "$EFI_CODE")/edk2-arm-vars.fd"
EFI_VARS="$BUILD/efivars.fd"
PIDFILE="$BUILD/qemu.pid"
SERIAL="$BUILD/serial.log"
MONITOR="$BUILD/monitor.sock"
SSH_PORT="${HERALD_VM_PORT:-${HERMES_VM_PORT:-2222}}"
CPUS="${CPUS:-4}"
MEM="${MEM:-8192}"
DISK_SIZE="${DISK_SIZE:-64G}"
# Guest framebuffer. The Cocoa window shows guest pixels 1:1 with the Mac's device pixels, so the
# default fills the main display's width and leaves room for the menu bar and title bar (72 points,
# 144 pixels on Retina). Pair a Retina-sized guest with HERALD_OS_SCALE=2 in
# ~/.config/herald-os/session.env (and `scale 2` in ~/.config/niri/local.kdl) so text stays crisp.
DISPLAY_RES="$(system_profiler SPDisplaysDataType 2>/dev/null | awk '/Main Display: Yes/{main=1} /Resolution:/{res=$2" "$4} main && res{print res; exit}')"
[[ -n "$DISPLAY_RES" ]] || DISPLAY_RES="$(system_profiler SPDisplaysDataType 2>/dev/null | awk '/Resolution:/{print $2" "$4; exit}')"
read -r DISPLAY_W DISPLAY_H <<<"${DISPLAY_RES:-2048 1424}"
GUEST_W="${GUEST_W:-$DISPLAY_W}"
GUEST_H="${GUEST_H:-$((DISPLAY_H - 144))}"

# A VM that powers itself off leaves its pid file behind, and macOS may give that pid to another
# process later: only a QEMU process counts, so `stop` never kills something else.
running() {
  [[ -f "$PIDFILE" ]] && [[ "$(ps -p "$(cat "$PIDFILE")" -o comm= 2>/dev/null)" == *qemu-system* ]]
}

case "${1:-start}" in
  status)
    if running; then echo "running (pid $(cat "$PIDFILE")), ssh -p $SSH_PORT hermes@127.0.0.1"; else echo "stopped"; fi
    exit 0 ;;
  stop)
    if running; then
      echo "==> Powering down"
      printf 'system_powerdown\n' | nc -U "$MONITOR" >/dev/null 2>&1 || kill "$(cat "$PIDFILE")"
      for _ in $(seq 1 30); do running || break; sleep 1; done
      running && kill -9 "$(cat "$PIDFILE")" || true
    fi
    rm -f "$PIDFILE"
    exit 0 ;;
  console)
    exec tail -n 80 -f "$SERIAL" ;;
  reset)
    "$0" stop
    echo "==> Deleting overlay disk and EFI vars (base image kept)"
    rm -f "$DISK" "$EFI_VARS" "$SERIAL"
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status|console|reset]" >&2; exit 2 ;;
esac

command -v qemu-system-aarch64 >/dev/null || { echo "qemu missing: brew install qemu" >&2; exit 1; }
[[ -f "$EFI_CODE" ]] || { echo "EDK2 firmware not found at $EFI_CODE" >&2; exit 1; }
if [[ -z "$IMAGE" ]]; then
  [[ -s "$BASE" ]] || bash "$HERE/download-image.sh"
  [[ -s "$SEED" ]] || bash "$HERE/make-seed.sh"
fi
SEED_ARGS=()
[[ -n "$IMAGE" ]] || SEED_ARGS=(-drive if=virtio,format=raw,readonly=on,file="$SEED")

if running; then
  echo "already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

if [[ ! -f "$DISK" ]]; then
  echo "==> Creating overlay disk $DISK ($DISK_SIZE) on top of $(basename "$BASE")"
  qemu-img create -q -f qcow2 -F qcow2 -b "$BASE" "$DISK" "$DISK_SIZE"
fi
[[ -f "$EFI_VARS" ]] || cp "$EFI_VARS_SRC" "$EFI_VARS"

# No zoom-to-fit: with it on, QEMU reports the initial window size (640x400) to the guest as the
# preferred mode and xres/yres are ignored. View -> Zoom To Fit can still be toggled from the menu.
DISPLAY_ARGS=(-display cocoa,show-cursor=on)
if [[ -n "${HEADLESS:-}" ]]; then
  DISPLAY_ARGS=(-vnc 127.0.0.1:1)
fi

echo "==> Starting QEMU (ssh -p $SSH_PORT -i $BUILD/id_hermes hermes@127.0.0.1)"
: >"$SERIAL"
# Not `-daemonize`: QEMU forks after Cocoa/CoreAudio initialise, which macOS aborts. Instead start
# it in its own session (perl setsid; macOS has no setsid binary) so closing this terminal or a
# parent process group does not take the VM down.
perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' -- qemu-system-aarch64 \
  -name herald-os \
  -machine virt,highmem=on \
  -accel hvf \
  -cpu host \
  -smp "$CPUS" \
  -m "$MEM" \
  -drive if=pflash,format=raw,readonly=on,file="$EFI_CODE" \
  -drive if=pflash,format=raw,file="$EFI_VARS" \
  -drive if=virtio,format=qcow2,file="$DISK" \
  ${SEED_ARGS[@]+"${SEED_ARGS[@]}"} \
  -device virtio-gpu-pci,xres="$GUEST_W",yres="$GUEST_H" \
  "${DISPLAY_ARGS[@]}" \
  -device qemu-xhci -device usb-kbd -device usb-tablet \
  -audiodev coreaudio,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0 \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$SSH_PORT"-:22 -device virtio-net-pci,netdev=net0 \
  -device virtio-rng-pci \
  -serial file:"$SERIAL" \
  -monitor unix:"$MONITOR",server,nowait \
  >"$BUILD/qemu.log" 2>&1 &
echo $! >"$PIDFILE"
sleep 2
if ! running; then
  echo "QEMU exited immediately:" >&2
  cat "$BUILD/qemu.log" >&2
  rm -f "$PIDFILE"
  exit 1
fi

echo "==> Booted (pid $(cat "$PIDFILE")). Console: bash $0 console"
