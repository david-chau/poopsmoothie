#!/usr/bin/env bash
# Build the image for both amd64 + arm64 and push it to GitHub Container
# Registry, so any NAS (Intel or ARM) can just `docker pull` it.
#
#   1. Auth once (classic token with write:packages scope):
#        echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-gh-user> --password-stdin
#   2. Publish:
#        GHCR_USER=<your-gh-user> ./scripts/publish.sh [version]
#
# `version` defaults to a timestamp; :latest is always updated too.
set -euo pipefail

USER="${1:-${GHCR_USER:-}}"
if [ -z "$USER" ]; then
  echo "usage: GHCR_USER=<your-gh-user> $0 [version]" >&2
  exit 1
fi
VERSION="${2:-$(date +%Y%m%d-%H%M)}"
# GHCR requires an all-lowercase path
IMAGE="ghcr.io/$(echo "$USER" | tr '[:upper:]' '[:lower:]')/poopsmoothie"

# multi-arch needs the docker-container buildx driver (the default docker
# driver can't emit a multi-platform manifest)
if ! docker buildx inspect ps-builder >/dev/null 2>&1; then
  docker buildx create --name ps-builder --driver docker-container --use
fi
docker buildx use ps-builder

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  --push \
  .

echo
echo "pushed ${IMAGE}:${VERSION}  (+ :latest)"
echo "on the NAS:  PS_IMAGE=${IMAGE}:latest docker compose -f docker-compose.prod.yml up -d"
