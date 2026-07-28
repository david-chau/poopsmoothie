# Development

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

## Tests

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

## Recording the GIFs

See [Recording](RECORDING.md).

## Testing with fewer devices than players

Bots write their own words and play their own turns (random correct/pass with a
short delay), so you can hit the 4-player minimum with 1-2 real devices.

**From the UI** (host-only, lobby): **🤖 +1** / **🤖 Fill to 4** / **Remove
bots**. Best for a demo — no terminal needed. Bots get real names behind a
reserved `[🤖] ` prefix (`[🤖] Jill`) that people are refused if they try to
type it: names are the identity here, so a human "Jill" and a bot "Jill" would
be indistinguishable on the one field that decides who you are. Bots write real phrases by asking
for suggestions through the same `suggest-words` event the 🎲 buttons use, so
their words are playable and de-duplicated against everyone else's.

**From the CLI**, against any running server:

```sh
npm run bots -- ABCD 2   # add 2 bots to room ABCD
```

Both use the same factory (`server/bot.js`) — real socket.io clients that join
through the normal `join-room` door, so turn rotation, pause-on-disconnect and
host transfer all treat them as ordinary players with no special-casing.
