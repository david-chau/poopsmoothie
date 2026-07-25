#!/usr/bin/env bash
# Stop the local stack. Rooms in ./data survive.
#
#   ./scripts/stopLocalDocker.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose down
