# Settings — detailed

Full behavior and edge cases behind the [high-level settings](../README.md#settings)
in the README.

## Lobby settings

- Teams auto-balance, and anyone can move themself between them (host can move
  anyone). Room code has a 📋 copy button.
- **Hot join** (on by default): latecomers can drop into a game already in
  progress — they slot into the turn rotation and start playing from the next
  round's slips. They don't contribute words, since the pool is already built.
  Turn it off and the doors shut when the game starts. This is the one setting
  the host can still change mid-game.

## Admin controls

**⚙️ Admin controls** on the turn screen — for when something goes sideways
mid-game:

- **Skip stuck drawer** (AFK/dropped — same team, next player) / **Force
  pass to other team** (ends the turn outright, hands it over)
- **Pause game** for a real-world interruption; host or drawer resumes
- **Revert last correct word** if something got scored by mistake
- **Who guessed what** — a word × round table for re-attributing any
  already-guessed slip. Team scores are derived from it, so there's no way
  to nudge a score away from what actually happened
- **Hand this turn to someone else** when the wrong person went

**The host seat never goes to a bot.** Bots have no UI, so handing one the
room leaves the admin controls with nobody — which used to happen on every
refresh in a solo-plus-bots game. If no human is connected the seat simply
waits for the absent host rather than moving.

**End room for everyone** (host-only): in the lobby settings, and under
**⚙️ Admin controls → Danger zone** once the game is running. *Leave room*
only removes you and leaves everyone else in a lobby you've abandoned.

**Kick a player** (host-only): from the lobby roster, or **⚙️ Admin controls
→ Remove a player** once the game is running. They're sent back to the home
screen with a reason; if it was their turn, it passes on rather than
stranding the round.

## Identity and reconnecting

**Your name is your identity**, and names are unique within a room.
Reconnecting is automatic — a dropped signal or reloaded tab picks back up in
the same room, same team, same turn, current word in hand. If the device lost
its saved session entirely (cleared storage, flat battery, borrowed phone, or
the server restarted under you), just rejoin with **the same name**:

- if that name is **still connected**, you get an error — a seat is never
  taken from someone actively playing. That check probes the socket rather
  than trusting the last-known flag, so a device you just put down doesn't
  lock you out of your own name;
- if it's **offline**, you're asked to confirm ("already in this room but
  offline — join back as them?") and then get the slot back with its team and
  score attribution, even if hot join is off. If you were host and the seat
  was only handed on *because* you dropped, it comes back with you; a
  connected host who took over keeps it, so a flaky phone can't yank control
  mid-game.

**Idle phones stay in the game.** Only the drawer is looking at their screen;
everyone else puts theirs down, and a suspended mobile tab stops answering
socket pings. So the disconnect timeout is deliberately *generous* (~85s of
silence) rather than eager — "connected" drives the turn rotation, the ready
gate and the writing auto-advance, so dropping idle players skips their turns
and can stall a round. The one case where waiting hurts — picking up a second
device and finding your own name in use — is handled precisely instead, by
probing that one socket at that moment. A genuinely stuck drawer has the
host's **Skip stuck drawer**.

**Crash recovery.** If the container restarts mid-game (power blip,
redeploy), it reloads paused; the active drawer just taps **Resume**.

## Round flow

**Between rounds** the next round is held shut until everyone taps **I'm
ready**, on a screen showing the round that just finished and the running
total. The host can **Start the round now** to skip the wait, and the gate
re-opens by itself if someone drops out mid-recap. There's no gate into the
final scores — that screen is the recap. (This used to be a modal over a live
round, which meant the next drawer could start their turn while everyone else
was still reading.)

**Guessed this round** is listed for everyone during play, with who got each
one. Scoped to the current round on purpose: the pile resets each round and
remembering the earlier rounds' words is the game.

**Play again** (host-only, on the final scores): reopens the lobby around the
same people with the same settings — same room code, nobody rejoins, scores
reset. Leave/Play again stay pinned to the bottom of that screen rather than
below a long scroll.

## Chat & voice (beta)

Off by default, a lobby setting the host turns on per room (**Chat & voice
(beta)** checkbox, alongside Hot join). Everything below only exists once
it's on.

**Chat** on the turn screen is a live audit trail for the current round only
("I said Titanic before the buzzer") — cleared when the next round starts.
Names are team-colored, the drawer gets a badge, and you can filter to
**All**, **My team**, or **Drawer** so the other team's chatter doesn't
flood the log.

**Voice chat** (open mic — no push-to-talk): tap 🎤 to let the table hear
you, transcribed automatically into the same chat log (🎤 marks a voice
line). It needs `https` — see [Deployment](DEPLOYMENT.md#troubleshooting) —
and only appears once the server actually has the speech models loaded.
**Voice language** (English or 中文, in lobby settings, only once Chat &
voice is on) picks which one — one at a time, never both, since mixing them
made transcription noticeably worse. If several phones catch the same thing
said out loud, only one line shows up, attributed to whoever said it — not
whichever phone happened to catch it loudest. **Voice ID** (next to the mic
toggle) lets you record a short sample once so you're still credited
correctly even on someone else's phone; skipping it is fine, chat still
works, it's just occasionally attributed to whoever's phone caught it. Only
text is ever stored — raw audio is discarded the instant it's
transcribed/matched. Pipeline internals (VAD, ASR, dedup, speaker
embeddings): [Architecture](ARCHITECTURE.md#voice-chat-pipeline).

## Sound

Correct guesses, passes, submitting your words, someone joining, the last
10 seconds of a turn (soft, firming up for the last 3), time-up, each round
closing, and a fanfare on the final scores. Room-wide moments play off the
broadcast state, so *everyone* hears a correct guess, not just the drawer who
tapped it. The 🔊/🔇 toggle in the top-right silences sound **and**
vibration, per device, and is remembered.
