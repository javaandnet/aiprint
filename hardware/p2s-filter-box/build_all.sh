#!/usr/bin/env bash
# Regenerate every variant of the P2S filter box (STL + drawing + params).
# Usage: ./build_all.sh [extra flags passed to every variant]
set -euo pipefail
cd "$(dirname "$0")"

python3 filter_box.py --out out "$@"
python3 filter_box.py --mount ears --out out/ears "$@"
python3 filter_box.py --clips --out out/clips "$@"
python3 filter_box.py --mount ears --clips --out out/ears-clips "$@"

echo "[done] variants: out (rear), out/ears, out/clips, out/ears-clips"