# poopsmoothie

Digital version of Poopsmoothie, a homemade Celebrity variant: everyone writes
words/phrases on slips, splits into two teams, and plays three rounds against
the clock using the *same* slips each round — Taboo, Charades, Password.
Real-time multiplayer over LAN, single Docker container, room-code lobbies,
built for game night on a home NAS.

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

### Hosting a game night

1. Bring the container up (see Deploy below) and open it on your own
   phone/laptop first — you become the room's **host**.
2. Create a room, share the 4-letter code with your guests, they join from
   their own phones on the same wifi.
3. In the lobby: auto-balanced teams (host can move anyone, everyone can move
   themself), and host-only settings for **words per player** and **turn
   seconds**. Room code has a 📋 copy button.
4. Host starts the game once at least 4 players are in. Everyone writes their
   words; the game auto-advances to Round 1 once everyone's submitted (host
   can force-start with whoever's ready if someone's stalling).
5. If a drawer goes AFK or drops connection mid-turn, the host has two escape
   hatches on the turn screen: **Skip stuck drawer** (same team, next player)
   and **Force pass to other team** (ends the turn outright, hands it over).
6. **Reconnect is automatic.** If someone's phone drops signal or the tab
   reloads, rejoining the same room code with the same name/session picks
   back up where they left off — including mid-turn, with their current word.
7. **Crash recovery.** If the container itself restarts mid-game (power
   blip, redeploy), the game reloads from disk on boot in a paused state;
   the active drawer just taps **Resume**.

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

Run `npm test` for the round-engine unit tests (`server/game.test.js`) —
pool building, scoring, stale-action rejection, timeout/pass mechanics, and
the per-round slip-reuse/team-alternation rules.

### Testing with fewer devices than players

`npm run bots -- <ROOMCODE> [count]` adds fake players to a room — they
auto-submit words and auto-play their turn (random correct/pass with a short
delay), so you can hit the 4-player minimum and exercise the full game with
1-2 real devices.

```sh
npm run bots -- ABCD 2   # add 2 bots to room ABCD
```

## Deploy (NAS / Docker)

```sh
docker compose up -d --build   # game night
docker compose down            # after
```

Serves on `:4321` (single container — Express + socket.io serve the built
React app and the WebSocket API from the same origin, no separate frontend
container). `docker-compose.yml` maps `4321:4321` and mounts `./data:/data`
for room persistence.

Room state persists to `./data/rooms/*.json` on the host — survives a
container restart mid-game; players just reload and rejoin, drawer taps
Resume. Not yet load-tested beyond dev — worth a real run-through on the NAS
before a real game night to catch any environment-specific gaps (LAN
discovery, port conflicts, etc).

## Architecture

```
server/
  index.js     express + socket.io bootstrap, serves client/dist, boot recovery
  rooms.js     room/player CRUD, 4-char codes, team balance, host transfer
  game.js      round/turn state machine — pool, scoring, timers, pass/skip
  persist.js   atomic (tmp+rename) JSON writes, load-all-on-boot
  events.js    socket event wiring, auth, sanitized public state broadcast
  game.test.js unit tests for game.js

client/src/
  GameContext.tsx   socket connection, rejoin, clock-skew offset, game state
  socket.ts         socket.io client singleton + identity persistence
  types.ts          shared types, team/round label+color/icon maps
  screens/          Landing, Lobby, Writing, Turn, Scores
  components/       PaperSlip (fold animation), Confetti, RulesDialog, PlayerName
```

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
