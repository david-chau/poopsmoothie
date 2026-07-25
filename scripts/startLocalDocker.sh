#!/usr/bin/env bash
# Build (if needed) and start the local stack, then wait until it answers.
#
#   ./scripts/startLocalDocker.sh
#
# Rooms persist to ./data. Stop with ./scripts/stopLocalDocker.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --build

# en0/en1 covers wifi-vs-ethernet on a Mac; `|| true` so a machine with neither
# still starts the stack instead of tripping `set -e` on the lookup.
lan_ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)

# `up -d` returns as soon as the container starts, not when the server is
# listening — poll so the script only exits once the app actually answers.
for _ in $(seq 30); do
  if curl -fsS -o /dev/null http://localhost:4321/ 2>/dev/null; then
    echo
    echo "poopsmoothie up"
    echo "  you:     http://localhost:4321"
    if [ -n "$lan_ip" ]; then
      echo "  guests:  http://${lan_ip}:4321   <- share this on the same wifi"
    else
      echo "  guests:  (no LAN IP found — check System Settings > Network)"
    fi
    echo
    exit 0
  fi
  sleep 1
done

echo "poopsmoothie did not answer on :4321 after 30s" >&2
docker compose logs --tail 20
exit 1
