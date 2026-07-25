# poopsmoothie

Digital version of Poopsmoothie, a homemade Celebrity variant: everyone writes
words/phrases on slips, splits into two teams, and plays three rounds against
the clock using the *same* slips each round — Taboo, Charades, Password.
Real-time multiplayer over LAN, single Docker container, room-code lobbies.
No cloud, no accounts — everyone just opens a link on the same wifi.

## Quick start — game night on your wifi

**Pick one machine to be the host** — anything that can run Docker and stays
on for the night: a NAS, a spare mini-PC, or your own laptop.

- **macOS/Windows:** install [Docker Desktop](https://docs.docker.com/get-started/get-docker/)
  and **launch it** — the daemon has to actually be running, not just installed.
- **Linux / NAS:** Docker Engine + the Compose plugin (Synology/QNAP ship this
  as the Container Manager / Container Station package).

Check it's ready — this must print a version, not `Cannot connect to the Docker
daemon`:

```sh
docker compose version
```

Then pull and run the published image (no source checkout, no build step):

```sh
docker compose -f docker-compose.prod.yml up -d
```

Find the host's LAN IP to share — macOS: `ipconfig getifaddr en0`; Linux:
`hostname -I`; or check your router's device list. Everyone browses to
`http://<that-ip>:4321`.

> **IP changes every night?** Give the host a name instead:
> - **No setup:** most devices already resolve `<hostname>.local` (Bonjour on
>   macOS, avahi on Linux) — `http://<hostname>.local:4321`. A few older
>   Android phones can't resolve `.local`.
> - **A real name (`ps.game`):** needs a DNS override every guest device will
>   use — a static DHCP reservation + your router's local DNS (Pi-hole,
>   dnsmasq, or a consumer router's "Local DNS" setting). Worth it for a
>   recurring game night; skip it for a one-off.

1. **Open that URL yourself first.** Whoever creates the room is the
   **host**, and only the host gets settings and the admin controls.
2. Enter your name, tap **Start a new game** → you get a 4-letter code. Hit 📋
   to copy an invite link for your group chat — it opens straight to the join
   screen.
3. Everyone else opens the same URL and taps your room in the **Open rooms**
   list — no code to read out. They land on whichever team is short (Blue on a
   tie). Typing a code still works, tucked under *Join with a room code*.
4. Need bodies? Host-only in the lobby: **🤖 Fill to 4** adds bots that write
   their own words and play their own turns. Good for a demo or for testing
   with two real people.
5. Host taps **Start game** at 4+ players. Everyone writes their words — the
   🎲 buttons fill boxes for anyone who's stuck.
6. Game auto-advances to Round 1 once everyone's submitted.

When you're done:

```sh
docker compose -f docker-compose.prod.yml down    # rooms in ./data survive
```

**If guests can't reach it:** the URL is `http`, not `https` — some phones
auto-upgrade, so paste the full `http://192.168.x.x:4321` rather than typing
the bare IP. Also check they're on the same wifi band/network (guest wifi is
usually isolated from the main one), and that macOS didn't firewall Docker
(System Settings → Network → Firewall → Options).

(Building from source instead of pulling the image? See
[Option A](#option-a--build-on-the-host) below.)

## How to play

Full rules are also in-app: tap **📜 How to play** on the home screen, lobby,
or writing screen (native modal, works anywhere before a round starts).

1. Everyone writes a few words or phrases — one per slip, anything guessable.
2. Split into **Team Blue** and **Team Red**.
3. Play 3 rounds with the *same* slips every time:
   - **🗣️ Round 1 — Taboo**: describe it any way you like — just don't say the
     word, spell it, or say what it rhymes with.
   - **🎭 Round 2 — Charades**: act it out. No talking, no sounds.
   - **🔑 Round 3 — Password**: one single word as a clue. That's it.
4. On your turn you've got a timer to get your team guessing as many slips as
   you can. Correct? Straight to the next one — same drawer keeps going until
   time's up. Stuck? Pass it and come back around.
5. When time runs out, whatever's still in your hand goes back in the pile for
   next time.
6. Most correct guesses across all 3 rounds wins. MVP (top scorer) is called
   out per team on the final scores screen.

### Host reference

Beyond the Quick start walkthrough above, good to know while hosting:

- **Lobby settings** (host-only): teams auto-balance, and anyone can move
  themself between them (host can move anyone). **Words per player** and
  **turn seconds** are also host-only. Room code has a 📋 copy button.
- **Hot join** (on by default): latecomers can drop into a game already in
  progress — they slot into the turn rotation and start playing from the next
  round's slips. They don't contribute words, since the pool is already built.
  Turn it off and the doors shut when the game starts. This is the one setting
  the host can still change mid-game.
- **⚙️ Admin controls** on the turn screen — for when something goes sideways
  mid-game:
  - **Skip stuck drawer** (AFK/dropped — same team, next player) / **Force
    pass to other team** (ends the turn outright, hands it over)
  - **Pause game** for a real-world interruption; host or drawer resumes
  - **Revert last correct word** if something got scored by mistake, plus
    manual ±1 per team for anything revert can't reach
  - **Hand this turn to someone else** when the wrong person went
- **Reconnect is automatic.** Dropped signal or a reloaded tab picks back up
  in the same room — same team, same turn, current word in hand.
- **Crash recovery.** If the container restarts mid-game (power blip,
  redeploy), it reloads paused; the active drawer just taps **Resume**.

## Dev

```sh
npm install
npm --prefix client install
npm run dev           # client (:5173) + server (:4321) together
```

Or run them separately: `npm run dev:client` / `npm run dev:server`
(server auto-restarts on change via nodemon, scoped to `server/` only — it
does *not* watch `data/`, so gameplay writing room state to disk won't
trigger a restart loop).

To test from a phone on the same wifi, use your machine's LAN IP instead of
localhost, e.g. `http://192.168.x.x:5173`. Vite's dev server proxies
`/socket.io` through to the backend on `:4321` automatically, and binds
`0.0.0.0` so phones can reach it.

### Tests

```sh
npm test          # server + bots: node:test (server/*.test.js, scripts/*.test.mjs)
npm run test:client  # client: vitest + jsdom (src/**/*.test.tsx)
npm run test:all     # both of the above (fast, no Docker)
npm run test:e2e     # full Docker e2e (slow; builds + runs the image)
```

- **`server/game.test.js`** — round engine: pool, scoring, stale-action
  rejection, timeout/pass/skip/force-pass, resume time-banking, per-round
  skip, team alternation, stranded-turn recovery.
- **`server/rooms.test.js`** — team balance, secret auth, `setTeam`
  authorization, host transfer, room lifecycle.
- **`server/persist.test.js`** — atomic save/load round-trip, 24h idle purge,
  corrupt-file skip.
- **`server/events.test.js`** — socket integration over a real wire: auth
  gating, config clamp/merge, join gating, slip secrecy, rejoin.
- **`scripts/bot.test.mjs`** — bots join, auto-submit, and auto-play a turn
  end to end against a live server.
- **`client/src/**/*.test.tsx`** — screen logic: join-link prefill, pass
  gating, winner/MVP, waiting ratio, start gating, plus `lib` helpers.
- **`scripts/e2e.mjs`** (`npm run test:e2e`) — against the **real Docker
  image**: builds it, runs a full game through bots, then does an actual
  `docker restart` mid-turn and verifies crash recovery (reloads paused,
  drawer rejoins + resumes). Isolated image/container/port + a temp data dir,
  so it never touches a running stack or your real `./data`. Skips cleanly if
  Docker isn't installed.

### Testing with fewer devices than players

Bots write their own words and play their own turns (random correct/pass with a
short delay), so you can hit the 4-player minimum with 1-2 real devices.

**From the UI** (host-only, lobby): **🤖 +1** / **🤖 Fill to 4** / **Remove
bots**. Best for a demo — no terminal needed.

**From the CLI**, against any running server:

```sh
npm run bots -- ABCD 2   # add 2 bots to room ABCD
```

Both use the same factory (`server/bot.js`) — real socket.io clients that join
through the normal `join-room` door, so turn rotation, pause-on-disconnect and
host transfer all treat them as ordinary players with no special-casing.

## Deploy (any Docker host on your LAN)

Serves on `:4321` (single container — Express + socket.io serve the built
React app and the WebSocket API from the same origin, no separate frontend
container). Maps `4321:4321` and mounts `./data:/data` for room persistence.

### Option A — build on the host

For local dev/testing (checking a change actually works in the container) —
not the game-night path, which pulls the published image (see Quick start
above, or Option B).

```sh
./scripts/startLocalDocker.sh   # build + up + print the LAN URL to share
./scripts/stopLocalDocker.sh    # after
```

(Thin wrappers over `docker compose up -d --build` / `down`; the start one
polls until the server actually answers, since `up -d` returns before it's
listening.)

Needs the source on the box and ~1GB RAM for the client build. Fine on a dev
machine or most NAS/mini-PC hardware.

### Option B — pull a prebuilt image (recommended for an always-on host)

Build multi-arch (amd64 + arm64) on your dev machine and push to GHCR, so the
host machine just pulls — no source, no build RAM needed there:

```sh
# once: auth (classic token with write:packages)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-gh-user> --password-stdin
# publish (builds both arches, pushes :latest + a timestamp tag)
GHCR_USER=<your-gh-user> ./scripts/publish.sh
```

Then on that host: same `docker compose -f docker-compose.prod.yml up -d` as
the Quick start above (`pull` instead of `up -d` grabs a newer `:latest`).
Only set `PS_IMAGE` for a different account or a pinned tag:

```sh
PS_IMAGE=ghcr.io/<your-gh-user>/poopsmoothie:20260725-1030 \
  docker compose -f docker-compose.prod.yml up -d
```

To pull without `docker login`, make the GHCR package **public** (GitHub →
your profile → Packages → poopsmoothie → Package settings → visibility).

Room state persists to `./data/rooms/*.json` on the host — survives a
container restart mid-game; players just reload and rejoin, drawer taps
Resume. Rooms are cleaned up automatically: deleted when the last player
leaves, and any file idle >24h is purged on the next boot, so `data/` doesn't
grow without bound. Not yet load-tested beyond dev — worth a real run-through
on whatever box you pick before a real game night to catch any
environment-specific gaps (LAN discovery, port conflicts, etc).

## Architecture

```
server/
  index.js       express + socket.io bootstrap, serves client/dist, boot recovery
  rooms.js       room/player CRUD, 4-char codes, team balance, host transfer
  game.js        round/turn state machine — pool, scoring, timers, pass/skip,
                 host patch controls (revert, set-drawer, adjust-score)
  persist.js     atomic (tmp+rename) JSON writes, load-all-on-boot
  events.js      socket event wiring, auth, sanitized public state broadcast
  suggestions.js word/phrase pool for the 🎲 buttons, deduped against the room
  bot.js         bot factory — a socket.io client that plays itself
  bots.js        host-spawned bot lifecycle, one-time join tokens, teardown

client/src/
  GameContext.tsx   socket connection, rejoin, clock-skew offset, game state
  socket.ts         socket.io client singleton + identity persistence
  types.ts          shared types, team/round label+color/icon maps
  screens/          Landing, Lobby, Writing, Turn, Scores
  components/       PaperSlip (fold animation), Confetti, RulesDialog,
                    PlayerName, MyNameBadge, AdminDrawer
```

**No room passwords, deliberately.** Rooms are listed openly on the landing
screen and anyone who can reach the server can join one. That's the right trade
for the target: a LAN game where everyone is in the same living room, and the
alternative is reading a code out loud to people sitting next to you. The
security boundary is the network, not the app — don't expose this to the public
internet as-is. If you ever host it publicly, room passwords (and rate limiting
on room creation and bot spawning) become the first thing to add.

**Design notes worth knowing before touching this again:**
- Server is fully authoritative; client never computes game logic, only
  renders state and captures input.
- Slip *text* is never broadcast to the room — only sent to the current
  drawer's socket, and only revealed to everyone in the final pool at
  end-of-game. The public `state` payload carries counts, not text.
- Timers use an absolute `turnEndsAt` + `serverNow` pair so clients can
  correct for their own clock being wrong, not a ticking countdown from the
  server.
- Voluntary "Leave room" fully removes the player slot; an involuntary
  disconnect just marks them offline and keeps the slot for reconnect —
  these are deliberately different code paths.
