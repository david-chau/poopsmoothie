# Architecture

One container, one port, one origin — the same express server hands out the
built React app *and* speaks socket.io, which is why phones need no CORS setup
and no second URL.

```
              phones / laptops on the same wifi
                            │
                            │  http://<host-ip>:4321
                            ▼
┌──────────────────── container :4321 ────────────────────┐
│                                                         │
│  index.js  ─┬─ GET /*      ──▶  client/dist  (SPA)      │
│             └─ /socket.io  ──▶  socket.io               │
│                                    │                    │
│                                    ▼                    │
│                               events.js                 │
│              identity read from socket.data,            │
│              never trusted from the payload             │
│                    │                                    │
│         ┌──────────┼───────────────┬─────────────┐      │
│         ▼          ▼               ▼             ▼      │
│     rooms.js    game.js     suggestions.js    bots.js   │
│     roster,     phases,     🎲 word pool         │      │
│     codes,      turns,                           │      │
│     teams,      scoring,                    spawns      │
│     host        timers                           │      │
│                                                  ▼      │
│                                              bot.js     │
│                                        (socket.io       │
│                                         client that     │
│                                         loops back in   │
│                                         as an ordinary  │
│                                         player) ──┐     │
│                    ┌──────────────────────────────┘     │
│                    ▼                                    │
│           persistAndBroadcast()                         │
│             ├─ io.to(code)  'state'    counts, no text  │
│             ├─ io.emit      'lobbies'  open rooms, all  │
│             └─ persist.js  ──▶  /data/rooms/<CODE>.json │
│                                          │              │
│           sendSlipToDrawer()             │              │
│             └─ io.to(drawerSocket)       │              │
│                'slip-revealed' — the     │              │
│                only place slip text      │              │
│                leaves the box            │              │
│                                          │              │
└──────────────────────────────────────────┼──────────────┘
                                           │
          bind mount, from compose:        │
                 ./data:/data              │
                                           ▼
              ┌──────────────────────────────────────────┐
              │  host disk   ./data/rooms/<CODE>.json    │
              │  survives container restart, redeploy    │
              │  and image update — this is why a crash  │
              │  mid-game resumes instead of vanishing   │
              └──────────────────────────────────────────┘
```

Every state-changing handler ends the same way: mutate in memory → save to disk
→ broadcast. Nothing is written straight to a socket without going through the
sanitizing `publicState()` first.

## File map

```
server/
  index.js       express + socket.io bootstrap, serves SPA, boot recovery,
                 https listener (mic prerequisite), voice model loading
  rooms.js       room/player CRUD, 4-char codes, team balance, host transfer
  game.js        round/turn state machine — pool, timers, pass/skip, host
                 patch controls (revert, set-drawer, set-slip-scorer); scores
                 are derived from pool[].scoredBy, never accumulated
  persist.js     atomic (tmp+rename) JSON writes, load-all-on-boot
  events.js      socket event wiring, auth, sanitized public state broadcast
  suggestions.js word/phrase pool for the 🎲 buttons, deduped against the room
  bot.js         bot factory — a socket.io client that plays itself
  bots.js        host-spawned bot lifecycle, one-time join tokens, teardown
  tls.js         self-signed cert, generated once and persisted to DATA_DIR
  stt.js         sherpa-onnx wrapper: VAD -> streaming ASR -> speaker embedding
  arbiter.js     cross-device dedup (same shout, several phones) + voice match

client/src/
  GameContext.tsx   socket connection, rejoin, clock-skew offset, game state
  socket.ts         socket.io client singleton + identity persistence
  useOpenMic.ts     getUserMedia -> AudioWorklet -> 16kHz frames over the socket
  types.ts          shared types, team/round label+color/icon maps
  screens/          Landing, Lobby, Writing, Turn, RoundIntermission, Scores
  alert.ts          all game sounds + vibration (Web Audio, no asset shipped)
  components/       PaperCutIntro (sheet -> slips), PaperSlip (3D hinge
                    reveal), FoldingSlip (fold into the box), Confetti,
                    RulesDialog,
                    PlayerName, MyNameBadge, AdminDrawer, Toast,
                    SoundToggle, GameSounds, TurnChat (text + voice audit
                    trail), VoiceEnroll (one-shot voiceprint recording)

public/
  audio-worklet.js  mic downsampling — plain script, deliberately unbundled
```

## Security

**No room passwords, deliberately.** Rooms are listed openly on the landing
screen and anyone who can reach the server can join one. That's the right trade
for the target: a LAN game where everyone is in the same living room, and the
alternative is reading a code out loud to people sitting next to you. Reclaiming
a slot by name follows the same logic — it's weak proof of identity, but no
weaker than the rest of the model. **The security boundary is the network, not
the app** — don't expose this to the public internet as-is. If you ever host it
publicly, room passwords are the first thing to add.

**Not built, because the LAN assumption removes the need.** Worth revisiting
only if this is ever hosted publicly:
- **Spectator mode** — everyone is in the same living room watching the same
  drawer, so a watch-only seat adds nothing. Over the internet it would be the
  natural way to let extra people follow along without joining a team.
- **Room passwords / invite-only rooms** — see above.
- **Per-room word packs** — a shared theme ("films only", "inside jokes") is
  fun but the 🎲 suggestions plus everyone writing their own already covers it.

What *is* hardened, because these bite even on a friendly LAN:
- Every socket handler is wrapped so a malformed payload can't throw out of the
  handler. Without it, one bad message (`join-room` with a non-string code, or
  a literal `null` payload) became an uncaughtException and killed the server
  for every room on the box.
- Rejoin secrets are stored **hashed** (sha256, constant-time compare), so a
  room file on the NAS can't be read to impersonate a player. Old files with
  plaintext secrets migrate themselves on first load.
- Room creation is rate-limited per socket and capped globally, so a loop can't
  fill the disk with room files.
- Config values are clamped with a NaN guard — `wordsPerPlayer: NaN` used to
  make a room permanently unable to start, with no UI to recover.

## Design notes

Worth knowing before touching this again:
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
- The paper is the whole metaphor, so the slips behave like paper. You *write*
  on a slip (painted paper behind a transparent input), fold it down the centre
  and drop it in the box on submit, and a drawn slip is *unfolded*: one half
  hinges around the crease from rotateY(-180°) to 0°, showing its blank back
  until it opens. It is deliberately not a scaleX stretch — that grows the
  writing along with the paper, which real paper doesn't do. Both halves render
  the same full-width face and clip to their own side, so the phrase reads
  across the crease. You hold the left half and the *right* one is the flap —
  hinge the other and the slip sits on the right and opens leftward, which reads
  as running backwards. The flap's back is a shade darker than its front, or a
  fold onto identical paper just merges into the half beneath it; and the held
  writing screen opens by cutting a sheet into slips, built as the finished
  slips already stacked edge to edge so the "cut" is the gaps opening between
  them — which is also what lands the strips exactly where the rows appear,
  instead of needing two layouts to agree pixel for pixel. The
  ink is plain, with no fade — opening the paper *is* the reveal, and you read
  more of the phrase the further the flap swings. Slips are then *handled* the
  way the real ones are: drawn up out of the box below, and leaving by whichever
  route matches what happened to them — a guessed one is lifted away still open
  (nobody refolds one they just won), a passed one folds shut and drops back in,
  because it will come round again. A turn that simply runs out is treated as a
  pass, since that slip does go back in the bag. Each phase waits for the last,
  or it reads as one slip morphing rather than paper being handled. The whole
  chain is ~1s and plays after every guess, so the constants at the top of
  PaperSlip.tsx are the knob if it ever feels long mid-turn. Submitting runs the same
  hinge in reverse, in place on the writing screen, and the slips fold and drop
  into a box **before** anything is sent — you fold your paper and put it in the
  box, and only then are you ready. Two things here are
  easy to get subtly wrong and are pinned by tests: `.paper-surface` paints and
  never positions (its `inset: 0` once over-constrained the halves so both showed
  the same side of the phrase), and both faces pin to the same edge with the
  right one shifted, never one-left-one-right. The slip is also a deliberately
  *flat* stacking context with the perspective on it — `preserve-3d` there
  depth-sorts the halves, making `z-index` inert and leaving the flap to flicker
  and settle *under* the half it folds onto. All of it is skipped under
  `prefers-reduced-motion`.

## Voice chat pipeline

In order:

1. **Capture** (client): `getUserMedia` (open mic, no push-to-talk) feeds an
   `AudioWorklet` (`public/audio-worklet.js`) that downsamples whatever rate
   the device gives to 16kHz mono Int16 and streams ~250ms frames over the
   existing socket as `audio-frame` — `.volatile.emit`, so a frame queued
   behind a dropped connection is discarded rather than delivered stale.
   Kept short deliberately: whatever's left in the buffer when someone stops
   talking waits for the next full frame before the server's VAD even sees
   the silence that ends the segment — that tail wait was the visible
   majority of the delay before a line showed up.
2. **VAD** (server, per socket): silero-vad gates everything downstream —
   ASR only runs on segments it flags as actual speech, which is most of the
   CPU story on a NAS of uncertain power. Each segment is widened with ~300ms
   of **pre-roll** audio the segmenter keeps in its own rolling buffer: the
   VAD marks speech from where it is *confident*, which reliably clips a
   quiet leading word ("The Tooth Fairy" came back as "Tooth fairy" until
   this was added). Tuning the VAD's thresholds instead was tried and
   rejected — the only value that recovered the word was also the most eager
   to call a cough speech.
3. **ASR** (server, shared across the room): transcribes each segment in
   whichever single language the room picked (**Voice language** in lobby
   settings — English or 中文, never both). A combined bilingual model was
   tried first and dropped: trained on Mandarin/English code-switching
   speech, it was biased toward hearing Chinese even from a pure-English
   speaker — no config fixed it, only one single-language model per option
   did. Because the VAD segments *first*, only ever handing over a complete
   utterance, these are **offline** models rather than streaming ones: they
   are markedly better on the short phrases people actually say across a
   table, which is where a streaming zipformer turned "The Tooth Fairy" into
   "THE TWO FA". Runs behind `TranscriptionQueue`, a server-wide concurrency
   cap (`PS_STT_MAX_CONCURRENT`) — excess load sheds the oldest queued
   segment rather than letting transcription lag pile up.

   Which model each language uses is a Dockerfile concern, not a code one:
   every language directory carries a `model.json` naming its `kind`
   (`offline`/`online`), so swapping in a lighter model is a URL change. The
   English default (NeMo parakeet-tdt-0.6b) is the most accurate option
   tested and also the heaviest — **`npm run stt-bench` on the actual host is
   the deciding vote**, and the Dockerfile names the lighter fallback inline.
4. **Cross-device dedup** (`server/arbiter.js`): the same shout often lands on
   several phones. Utterances are held ~0.4s (`PS_VOICE_SETTLE_MS`), clustered
   by time overlap + text similarity, and only the best capture (loudest, then
   longest) becomes one chat line — this alone fixes the common case, since
   the true speaker's own phone usually also heard them. This is pure added
   latency for the (common) single-speaker case, so it's kept short — long
   enough to absorb two phones' VAD/network jitter, not much more.
5. **Voice match** (optional, per player): a speaker-embedding model fingerprints
   each utterance and compares it against anyone who recorded a sample via the
   **Voice ID** button. A confident match (`PS_VOICE_EMBEDDING_THRESHOLD`)
   overrides step 4's guess — this is what's actually needed when the true
   speaker's *own* phone never captured them at all (pocket, far corner of the
   room), not just when several phones did.

Only the transcribed **text** and (transiently, in memory, for the ~0.4s
settle window) a numeric voice fingerprint ever exist — raw audio is never
written to disk and is discarded the instant each step above is done with it.
Everything server-side is optional and fails soft: no model files, no HTTPS
cert, or a threshold nobody clears just means that layer sits out — text chat
never breaks because of it (`server/index.js` logs which pieces loaded at
boot). `npm run stt-bench -- /path/to/models` measures real decode speed on
whatever box will actually host it, before it needs to work at a party.
