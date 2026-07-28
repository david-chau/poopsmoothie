# Deployment

Serves on `:4321` (single container — Express + socket.io serve the built
React app and the WebSocket API from the same origin, no separate frontend
container). Maps `4321:4321` and mounts `./data:/data` for room persistence.

## Option A — build on the host

For local dev/testing (checking a change actually works in the container) —
not the game-night path, which pulls the published image (see
[Quick start](../README.md#quick-start--game-night-on-your-wifi), or Option B).

```sh
./scripts/startLocalDocker.sh   # build + up + print the LAN URL to share
./scripts/stopLocalDocker.sh    # after
```

(Thin wrappers over `docker compose up -d --build` / `down`; the start one
polls until the server actually answers, since `up -d` returns before it's
listening.)

Needs the source on the box and ~1GB RAM for the client build. Fine on a dev
machine or most NAS/mini-PC hardware.

## Option B — pull a prebuilt image (recommended for an always-on host)

The host machine just pulls — no source checkout, no build RAM needed there.
`docker-compose.prod.yml` uses `image:` instead of `build:` and already points
at the published image, so it's the same command as the Quick start:

```sh
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml pull   # grab a newer :latest later
```

| | |
|---|---|
| Image | `ghcr.io/david-chau/poopsmoothie:latest` |
| Platforms | `linux/amd64`, `linux/arm64` |
| All versions | [ghcr.io package versions](https://github.com/users/david-chau/packages/container/poopsmoothie/versions) |

Every publish also pushes a `YYYYMMDD-HHMM` tag. Pin one via `PS_IMAGE` to roll
back, or to point at a different account entirely:

```sh
PS_IMAGE=ghcr.io/david-chau/poopsmoothie:20260725-1210 \
  docker compose -f docker-compose.prod.yml up -d
```

## Publishing

Every push to `master` builds both arches and pushes `:latest`
+ a timestamp tag automatically ([.github/workflows/publish.yml](../.github/workflows/publish.yml)),
using the repo's own `GITHUB_TOKEN` — no secrets to set up. To publish from a
fork or a different account, or to push a build without merging to `master`:

```sh
# once: auth (classic token with write:packages)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-gh-user> --password-stdin
# builds both arches, pushes :latest + a timestamp tag
GHCR_USER=<your-gh-user> ./scripts/publish.sh
```

`GHCR_USER` picks the account; the optional first argument is the version tag.
Runs from any directory.

To pull without `docker login`, the GHCR package must be **public** (GitHub →
your profile → Packages → poopsmoothie → Package settings → visibility).

## Voice models

The published/built image does **not** include the voice-chat models
(VAD, ASR, speaker embedding) — they'd add ~100MB–1GB+ to every pull for a
beta feature most games won't turn on. Both compose files already bind-mount
`./models:/app/models:ro`; an empty/missing `./models` just means voice chat
stays off, text chat and the rest of the game are unaffected.

To enable it, fetch the models onto the host once, next to `docker-compose.yml`:

```sh
./scripts/fetch-models.sh                          # default English model (most accurate)
EN_MODEL=fast-conformer ./scripts/fetch-models.sh   # lighter, for a weaker CPU
```

Safe to re-run — each piece is skipped if already present. Run
[`npm run stt-bench`](DEVELOPMENT.md#tests) against the host afterward to
check it can actually keep up in real time; swap to `fast-conformer` if not.
Model internals: [Architecture](ARCHITECTURE.md#voice-chat-pipeline).

## Data persistence

Room state persists to `./data/rooms/*.json` on the host — survives a
container restart mid-game; players just reload and rejoin, drawer taps
Resume. Rooms are cleaned up automatically: deleted when the last player
leaves, and any file idle >24h is purged on the next boot, so `data/` doesn't
grow without bound. Not yet load-tested beyond dev — worth a real run-through
on whatever box you pick before a real game night to catch any
environment-specific gaps (LAN discovery, port conflicts, etc).

## Troubleshooting

**If guests can't reach it:** the URL is `http`, not `https` — some phones
auto-upgrade, so paste the full `http://192.168.x.x:4321` rather than typing
the bare IP. Also check they're on the same wifi band/network (guest wifi is
usually isolated from the main one), and that macOS didn't firewall Docker
(System Settings → Network → Firewall → Options).

**For voice chat specifically:** browsers only allow microphone access on a
secure origin, so the mic toggle only shows up over `https://192.168.x.x:4322`
(port **4322**, not 4321). Self-signed certificate — the browser will warn
once per device; that's expected for a self-hosted server, not a sign
anything's wrong. Text chat, and the rest of the game, work fine on the plain
`http://` URL; only the mic needs the `https` one. The chat panel says so
itself, with a link, when it notices you're on an http origin and the server
does have voice — so "where did the mic go?" answers itself in the app rather
than here. (Browsers don't merely block `getUserMedia` on an insecure origin,
they don't define `navigator.mediaDevices` at all, which is why this is a
different URL rather than a permission prompt.)
