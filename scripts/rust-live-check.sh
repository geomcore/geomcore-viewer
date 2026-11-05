#!/usr/bin/env bash
# Run the Rust examples against a real viewer server and check that what they send arrives.
# Usage: scripts/rust-live-check.sh [port]    (default 8797)
set -euo pipefail
cd "$(dirname "$0")/.."
port="${1:-8797}"
url="http://127.0.0.1:$port"
PYTHONPATH=python python3 -m geomcore_viewer serve --port "$port" --no-browser &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -sf "$url/api/health" >/dev/null && break; sleep 0.1; done

check() { # example, expected title, expected object count
  (cd clients/rust && GEOMCORE_VIEWER_URL="$url" cargo run -q --example "$1" --features geomcore)
  curl -sf "$url/api/scene" | python3 -c '
import json, sys
doc, title, count = json.load(sys.stdin), sys.argv[1], int(sys.argv[2])
ids = [o["id"] for o in doc["objects"]]
assert doc["title"] == title and len(ids) == count, (doc["title"], ids)
print(f"{sys.argv[3]}: {count} objects arrived")' "$2" "$3" "$1"
}

check conics "Conics and their intersections" 12
check pcurve "A circle on a cylinder" 3
check bspline "Exact B-splines" 6
