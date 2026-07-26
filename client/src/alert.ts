/** Phones live in pockets and on tables face-down during a turn, so the end of
 *  the timer needs to be audible, not just visible.
 *
 *  Web Audio rather than an audio file: no asset to ship into the container, no
 *  decode latency, and the container is served over plain http on a LAN where
 *  we'd rather not add bytes. Every call is best-effort — browsers block audio
 *  until the user has interacted with the page, and vibration is Android-only
 *  — so nothing here ever throws into the caller. */

let ctx: AudioContext | null = null;

const MUTE_KEY = 'poopsmoothie-muted';

/** Read at call time rather than cached, so a toggle anywhere in the app takes
 *  effect on the very next beep without any wiring between the two. */
export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false; // private mode / storage disabled — just make noise
  }
}

export function setMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // preference simply won't persist; the in-memory toggle still works
  }
}

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  // a context created before the first tap starts suspended; resuming is a
  // no-op once it's already running
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function beep(startAt: number, freq: number, seconds: number, gain: number) {
  const audio = audioContext();
  if (!audio) return;
  const osc = audio.createOscillator();
  const vol = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // ramp instead of a hard stop, or it clicks
  vol.gain.setValueAtTime(0, startAt);
  vol.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  vol.gain.exponentialRampToValueAtTime(0.0001, startAt + seconds);
  osc.connect(vol).connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + seconds);
}

/** Mute covers vibration too — someone silencing the app in a quiet room means
 *  "stop drawing attention", not "buzz instead". */
function safely(fn: () => void) {
  if (isMuted()) return;
  try {
    fn();
  } catch {
    // autoplay policy, no audio hardware, unsupported browser — never fatal
  }
}

/** Play a sequence of [frequency, duration, gain] notes back to back. */
function melody(notes: [number, number, number][]) {
  const audio = audioContext();
  if (!audio) return;
  let at = audio.currentTime;
  for (const [freq, seconds, gain] of notes) {
    beep(at, freq, seconds, gain);
    at += seconds;
  }
}

/** Countdown tick. Quiet for the 10-second warning, firmer for the last 3, so
 *  the pace is audible without watching the screen. */
export function tick(urgent = false) {
  safely(() => {
    const audio = audioContext();
    if (audio) beep(audio.currentTime, urgent ? 760 : 600, 0.07, urgent ? 0.13 : 0.06);
    if (urgent) navigator.vibrate?.(30);
  });
}

/** Two descending tones — clearly "that's time", not another tick. */
export function timeUp() {
  safely(() => {
    melody([
      [520, 0.22, 0.2],
      [390, 0.35, 0.2],
    ]);
    navigator.vibrate?.([120, 60, 200]);
  });
}

/** Rising pair on a correct guess — the sound everyone is playing for. */
export function correct() {
  safely(() =>
    melody([
      [660, 0.09, 0.16],
      [880, 0.13, 0.16],
    ]),
  );
}

/** Dull thunk when a slip is passed. Deliberately unrewarding, but not a
 *  buzzer — passing is a legitimate move, not a mistake. */
export function passed() {
  safely(() => melody([[300, 0.16, 0.12]]));
}

/** Soft blip when someone new joins the room. */
export function playerJoined() {
  safely(() =>
    melody([
      [520, 0.07, 0.07],
      [700, 0.09, 0.07],
    ]),
  );
}

/** Confirmation that your words went in — the screen changes too, but a
 *  sound makes it unambiguous on a phone you're barely looking at. */
export function submitted() {
  safely(() =>
    melody([
      [600, 0.08, 0.12],
      [800, 0.14, 0.12],
    ]),
  );
}

/** Three-note rise as a round closes. */
export function roundEnd() {
  safely(() =>
    melody([
      [523, 0.12, 0.15],
      [659, 0.12, 0.15],
      [784, 0.26, 0.17],
    ]),
  );
}

/** Final-scores flourish. */
export function fanfare() {
  safely(() => {
    melody([
      [523, 0.14, 0.18],
      [659, 0.14, 0.18],
      [784, 0.14, 0.18],
      [1047, 0.4, 0.2],
    ]);
    navigator.vibrate?.([80, 50, 80, 50, 200]);
  });
}

/** Called from a click handler so the AudioContext is unlocked by a real user
 *  gesture — otherwise the first beep of the game is silently swallowed. */
export function primeAudio() {
  safely(() => void audioContext());
}
