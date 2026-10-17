#!/usr/bin/env bash
# Try Herald OS on an Apple Silicon Mac in one command: fetch the ready-made VM disk from the latest
# release (or use one you have), and boot it with Apple's Virtualization framework (run-vf.sh). The
# first boot sets itself up (a few minutes, Hermes Agent included), then logs straight in.
#
#   bash linux/vm/try.sh                        # the latest release's disk
#   bash linux/vm/try.sh herald-os-<v>-aarch64.qcow2[.zst]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"
mkdir -p "$BUILD"

disk="${1:-}"
if [[ -z "$disk" ]]; then
  echo "==> Finding the latest Herald OS VM disk"
  # The disk is over GitHub's 2 GiB limit for one file, so it may come in parts (.part0, .part1, …).
  urls="$(curl -fsSL https://api.github.com/repos/iamlukethedev/Herald-OS/releases/latest |
    grep -E -o '"browser_download_url": *"[^"]*-aarch64\.qcow2\.zst(\.part[0-9]+)?"' | sed 's/.*"\(https[^"]*\)"/\1/' | sort)"
  [[ -n "$urls" ]] || { echo "try.sh: the latest release has no VM disk; pass one you have" >&2; exit 1; }
  name="$(basename "$(head -n 1 <<<"$urls")")"
  disk="$BUILD/${name%.part*}"
  if [[ ! -f "$disk" ]]; then
    pieces=()
    for url in $urls; do
      echo "==> Downloading $(basename "$url")"
      curl -fL --progress-bar -C - "$url" -o "$BUILD/$(basename "$url").download"
      pieces+=("$BUILD/$(basename "$url").download")
    done
    cat "${pieces[@]}" >"$disk.joining"
    rm -f "${pieces[@]}"
    mv "$disk.joining" "$disk"
  fi
fi
if [[ "$disk" == *.zst ]]; then
  command -v zstd >/dev/null || { echo "try.sh: needs zstd to unpack the disk (brew install zstd)" >&2; exit 1; }
  out="$BUILD/$(basename "${disk%.zst}")"
  if [[ ! -f "$out" ]]; then
    echo "==> Unpacking $(basename "$disk")"
    zstd -d -q "$disk" -o "$out"
  fi
  disk="$out"
fi

exec bash "$HERE/run-vf.sh" --image "$disk"
