#!/usr/bin/env bash
# Boot Herald OS Linux with Apple's Virtualization framework via vfkit: GPU-accelerated virtio-gpu
# (what niri needs), virtio-fs share, NAT networking, EFI. Same disk lineage as run-qemu.sh (the
# qcow2 is converted to a raw image on first use; both runners must not use the disk at once).
#
#   bash linux/vm/run-vf.sh                 # window on the Mac, SSH via the VM's NAT address
#   bash linux/vm/run-vf.sh --image herald-os-<v>-aarch64.qcow2   # a built Herald OS image instead
#   bash linux/vm/run-vf.sh stop|status|console|ip|ssh
#
# Guest resolution: GUEST_W x GUEST_H (default 2048x1280). vfkit is downloaded to
# linux/vm/build/bin on first use (brew needs the Xcode licence; the release binary does not).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$HERE/build"
VFKIT="$BUILD/bin/vfkit"
VFKIT_VERSION="${VFKIT_VERSION:-v0.6.4}"
QCOW="$BUILD/herald-os.qcow2"
RAW="$BUILD/herald-os.raw"
SEED_DIR="$BUILD/seed"
EFI_STORE="$BUILD/efistore.nvram"
PIDFILE="$BUILD/vfkit.pid"
SERIAL="$BUILD/vf-serial.log"
REST="tcp://127.0.0.1:8971"
CPUS="${CPUS:-4}"
MEM="${MEM:-8192}"
GUEST_W="${GUEST_W:-2048}"
GUEST_H="${GUEST_H:-1280}"
KEY="$BUILD/id_hermes"
# --image: a Herald OS disk from bootc-image-builder; it sets itself up on the first boot (no cloud-init).
IMAGE=""
if [[ "${1:-}" == "--image" ]]; then
  IMAGE="$(cd "$(dirname "${2:?--image needs a qcow2}")" && pwd)/$(basename "$2")"
  shift 2
  QCOW="$IMAGE"
  RAW="$BUILD/herald-os-image.raw"
  EFI_STORE="$BUILD/efistore-image.nvram"
fi

running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

# The VM's NAT lease: vmnet hands out 192.168.64.x and records it in the system DHCP leases file.
vm_ip() {
  local mac
  mac="$(cat "$BUILD/vf-mac" 2>/dev/null || true)"
  [[ -n "$mac" ]] || return 1
  # Leases store the MAC without leading zeros per octet.
  local short
  short="$(echo "$mac" | awk -F: '{for(i=1;i<=NF;i++){printf "%s%x", (i>1?":":""), strtonum("0x"$i)}}' 2>/dev/null || echo "$mac")"
  local ip
  ip="$(awk -v mac="$mac" -v short="$short" '
    /^\{/ { ip=""; hw="" }
    /ip_address=/ { split($0, a, "="); ip=a[2] }
    /hw_address=/ { split($0, a, "="); hw=a[2]; sub(/^1,/, "", hw) }
    /^\}/ { if (hw == mac || hw == short) { print ip; exit } }
  ' /var/db/dhcpd_leases 2>/dev/null)"
  # The guest prints its address on the serial console at login; use it when the lease is not visible.
  if [[ -z "$ip" && -f "$SERIAL" ]]; then
    ip="$(tr -d '\r' <"$SERIAL" | grep -oE 'enp[0-9a-z]+: ([0-9]+\.){3}[0-9]+' | tail -1 | awk '{print $2}')"
  fi
  [[ -n "$ip" ]] && echo "$ip"
}

case "${1:-start}" in
  status)
    if running; then echo "running (pid $(cat "$PIDFILE")), ip $(vm_ip || echo unknown)"; else echo "stopped"; fi
    exit 0 ;;
  ip)
    vm_ip
    exit 0 ;;
  stop)
    if running; then
      echo "==> Powering down"
      curl -fsS -X POST "${REST/tcp:\/\//http://}/vm/state" -d '{"state":"Stop"}' >/dev/null 2>&1 || kill "$(cat "$PIDFILE")"
      for _ in $(seq 1 30); do running || break; sleep 1; done
      running && kill -9 "$(cat "$PIDFILE")" || true
    fi
    rm -f "$PIDFILE"
    exit 0 ;;
  console)
    exec tail -n 80 -f "$SERIAL" ;;
  ssh)
    exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR hermes@"$(vm_ip)" ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status|console|ip|ssh]" >&2; exit 2 ;;
esac

if [[ ! -x "$VFKIT" ]]; then
  echo "==> Downloading vfkit $VFKIT_VERSION"
  mkdir -p "$BUILD/bin"
  curl -fL --retry 3 -o "$VFKIT" "https://github.com/crc-org/vfkit/releases/download/$VFKIT_VERSION/vfkit"
  chmod +x "$VFKIT"
  xattr -d com.apple.quarantine "$VFKIT" 2>/dev/null || true
fi

if running; then
  echo "already running (pid $(cat "$PIDFILE")), ip $(vm_ip || echo unknown)"
  exit 0
fi

if [[ -f "$BUILD/qemu.pid" ]] && kill -0 "$(cat "$BUILD/qemu.pid")" 2>/dev/null; then
  echo "QEMU is using the disk; stop it first: bash linux/vm/run-qemu.sh stop" >&2
  exit 1
fi

if [[ ! -f "$RAW" ]]; then
  [[ -f "$QCOW" ]] || { echo "no disk yet: run linux/vm/run-qemu.sh once (provisioning), or make-seed.sh + download-image.sh" >&2; exit 1; }
  echo "==> Converting $(basename "$QCOW") to raw (sparse) for the Virtualization framework"
  qemu-img convert -p -O raw "$QCOW" "$RAW"
fi
CLOUD_INIT=()
if [[ -z "$IMAGE" ]]; then
  [[ -d "$SEED_DIR" ]] || bash "$HERE/make-seed.sh"
  CLOUD_INIT=(--cloud-init "$SEED_DIR/user-data,$SEED_DIR/meta-data")
fi

# A stable MAC so the NAT lease (and therefore the IP) survives restarts.
if [[ ! -f "$BUILD/vf-mac" ]]; then
  printf '52:54:00:%02x:%02x:%02x\n' $((RANDOM % 256)) $((RANDOM % 256)) $((RANDOM % 256)) >"$BUILD/vf-mac"
fi
MAC="$(cat "$BUILD/vf-mac")"

echo "==> Starting vfkit (${GUEST_W}x${GUEST_H}, $CPUS cpus, ${MEM} MiB)"
: >"$SERIAL"
perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' -- "$VFKIT" \
  --cpus "$CPUS" --memory "$MEM" \
  --bootloader "efi,variable-store=$EFI_STORE,create" \
  --device "virtio-blk,path=$RAW" \
  ${CLOUD_INIT[@]+"${CLOUD_INIT[@]}"} \
  --device "virtio-net,nat,mac=$MAC" \
  --device "virtio-gpu,width=$GUEST_W,height=$GUEST_H" \
  --device virtio-input,keyboard \
  --device virtio-input,pointing \
  --device virtio-rng \
  --device "virtio-serial,logFilePath=$SERIAL" \
  --device "virtio-fs,sharedDir=$ROOT,mountTag=herald-os" \
  --restful-uri "$REST" \
  --gui \
  >"$BUILD/vfkit.log" 2>&1 &
echo $! >"$PIDFILE"
sleep 3
if ! running; then
  echo "vfkit exited immediately:" >&2
  cat "$BUILD/vfkit.log" >&2
  rm -f "$PIDFILE"
  exit 1
fi

echo "==> Booted (pid $(cat "$PIDFILE")). Console: bash $0 console; ip: bash $0 ip"
