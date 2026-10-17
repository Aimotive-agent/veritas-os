#!/usr/bin/env bash
# Download the Fedora Cloud Base (Generic) aarch64 qcow2 that Herald OS Linux boots from.
# Idempotent: skips when the image is already present. Resumes partial downloads.
#
#   FEDORA_VERSION=44 bash linux/vm/download-image.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"
VERSION="${FEDORA_VERSION:-44}"
IMAGE="$BUILD/fedora-cloud-${VERSION}-aarch64.qcow2"

mkdir -p "$BUILD"

if [[ -s "$IMAGE" && -z "${FORCE:-}" ]]; then
  echo "==> Image present: $IMAGE"
  exit 0
fi

echo "==> Resolving Fedora $VERSION Cloud Base Generic aarch64 image URL"
URL="$(curl -fsSL --max-time 30 https://fedoraproject.org/releases.json | python3 -c '
import json, sys
version, = sys.argv[1:]
rows = json.load(sys.stdin)
for r in rows:
    if r.get("variant") == "Cloud" and r.get("arch") == "aarch64" and r.get("version") == version \
       and "Cloud-Base-Generic" in r.get("link", "") and r["link"].endswith(".qcow2"):
        print(r["link"]); break
' "$VERSION")"

if [[ -z "$URL" ]]; then
  echo "No Fedora $VERSION Cloud Base Generic aarch64 qcow2 found in releases.json." >&2
  exit 1
fi

echo "==> Downloading $URL"
curl -fL --retry 3 -C - -o "$IMAGE.part" "$URL"
mv "$IMAGE.part" "$IMAGE"
echo "==> Saved $IMAGE ($(du -h "$IMAGE" | cut -f1))"
