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

# the build context below is `.`, so run from the repo root no matter where
# this was invoked from (`cd scripts && ./publish.sh` used to fail on a
# missing Dockerfile)
cd "$(dirname "$0")/.."

# The account comes from GHCR_USER only. It used to also accept $1, which
# silently beat the env var — `./publish.sh latest` meant "user = latest" and
# would have pushed to ghcr.io/latest/poopsmoothie.
gh_user="${GHCR_USER:-}"
if [ -z "$gh_user" ]; then
  echo "usage: GHCR_USER=<your-gh-user> $0 [version]" >&2
  exit 1
fi
version="${1:-$(date +%Y%m%d-%H%M)}"
# GHCR requires an all-lowercase path
IMAGE="ghcr.io/$(echo "$gh_user" | tr '[:upper:]' '[:lower:]')/poopsmoothie"

# multi-arch needs the docker-container buildx driver (the default docker
# driver can't emit a multi-platform manifest)
if ! docker buildx inspect ps-builder >/dev/null 2>&1; then
  docker buildx create --name ps-builder --driver docker-container --use
fi
docker buildx use ps-builder

# `publish.sh latest` would otherwise pass the same -t twice
tags=(-t "${IMAGE}:${version}")
[ "$version" = latest ] || tags+=(-t "${IMAGE}:latest")

echo "publishing ${IMAGE}:${version} from $(pwd)"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  "${tags[@]}" \
  --push \
  .

echo
if [ "$version" = latest ]; then
  echo "pushed ${IMAGE}:latest"
else
  echo "pushed ${IMAGE}:${version}  (+ :latest)"
fi
echo "on the NAS:  PS_IMAGE=${IMAGE}:latest docker compose -f docker-compose.prod.yml up -d"
