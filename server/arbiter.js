/**
 * Cross-device dedup for open-mic capture: when several phones hear the same
 * shout, this collapses their near-simultaneous, similar-text utterances into
 * one, keeping whichever capture looks best (loudest, then most confident,
 * then longest transcript) rather than posting the same line N times. This
 * alone resolves the common case — "David on Jill's phone" — because David's
 * own phone almost always also heard him, and his copy wins the cluster.
 * Voice-embedding enrollment (a later phase) is what closes the remaining gap
 * where only Jill's phone heard him at all.
 *
 * `clusterUtterances` is pure and synchronous — no timers, no I/O — so the
 * actual decision-making is fully unit-testable without waiting on anything
 * real. `SettleBuffer` is the thin, separately-tested wrapper that adds the
 * real-time "wait briefly for stragglers" batching around it (the actual
 * window is set by its caller — see VOICE_SETTLE_MS in events.js).
 *
 * `matchEnrolledSpeaker` is the voice-embedding half: given a cluster's
 * winning capture's embedding (see server/stt.js's SpeakerEmbeddingExtractor
 * wrapper) and the room's enrolled voiceprints, it decides whether the audio
 * itself identifies someone with more confidence than "whichever socket the
 * bytes arrived on" — closing the gap device-prior attribution can't: David's
 * phone in his pocket, only Jill's phone actually heard him.
 */

const DEFAULT_TIME_GRACE_MS = 300; // different mics' VAD endpointing rarely agrees to the millisecond
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_EMBEDDING_THRESHOLD = 0.5; // per the plan's ~0.45-0.55 estimate; tune via scripts/stt-bench.mjs

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation; unicode-aware so 你好 survives, not just ASCII
    .trim();
}

/** CJK has no whitespace between words — split those to individual
 *  characters instead, so "那是鲸鱼" and "是鲸鱼" still share tokens rather
 *  than comparing as two opaque, entirely-distinct strings. */
const CJK_RE = /[\u{3400}-\u{9fff}]/u; // CJK Unified Ideographs (+ Extension A)

function tokens(text) {
  return normalize(text)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (CJK_RE.test(word) ? [...word] : [word]));
}

/** Jaccard similarity of token sets. Simpler than character-level edit
 *  distance and a better fit here: two mics hearing one short utterance
 *  produce ASR noise that substitutes/drops whole words, not characters. */
function textSimilarity(a, b) {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function timeOverlaps(a, b, graceMs) {
  return a.t0 <= b.t1 + graceMs && b.t0 <= a.t1 + graceMs;
}

/** Higher is "better": loudest capture first, then whatever confidence the
 *  ASR reported (if any), then a longer transcript (more likely the complete
 *  utterance rather than a clipped echo), then earliest arrival as a final,
 *  deterministic tiebreak so equal-everything inputs don't depend on
 *  object identity or array order. */
function isBetter(a, b) {
  if (a.energy !== b.energy) return a.energy > b.energy;
  const ac = a.confidence ?? 0;
  const bc = b.confidence ?? 0;
  if (ac !== bc) return ac > bc;
  if (a.text.length !== b.text.length) return a.text.length > b.text.length;
  return a.t0 <= b.t0;
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]]; // path halving
      i = this.parent[i];
    }
    return i;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Groups `utterances` (each `{playerId, text, energy, t0, t1, confidence?}`)
 * into clusters of "the same real event, heard by different mics", and
 * returns one winner per cluster — attributed to whichever capture was best —
 * plus which other players' devices also caught it. Distinct utterances (no
 * time overlap, or overlapping but saying different things) each come back as
 * their own untouched cluster of one.
 */
export function clusterUtterances(
  utterances,
  { timeGraceMs = DEFAULT_TIME_GRACE_MS, similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD } = {},
) {
  const n = utterances.length;
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        timeOverlaps(utterances[i], utterances[j], timeGraceMs) &&
        textSimilarity(utterances[i].text, utterances[j].text) >= similarityThreshold
      ) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map(); // root index -> member indices
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()]
    .map((indices) => {
      const members = indices.map((i) => utterances[i]);
      let winner = members[0];
      for (const m of members) if (m !== winner && isBetter(m, winner)) winner = m;
      return { ...winner, mergedFrom: members.filter((m) => m !== winner).map((m) => m.playerId) };
    })
    .sort((a, b) => a.t0 - b.t0); // chronological output, independent of clustering/iteration order
}

/**
 * Batches utterances over a short settle window so near-simultaneous captures
 * from different phones have a chance to arrive before clusterUtterances
 * decides between them — the "almost real time" buffer the feature calls for.
 * One timer per in-flight window, started at the first arrival in it (not a
 * sliding window), so a steady trickle of speech can't delay output forever.
 */
export class SettleBuffer {
  constructor(onFlush, { windowMs = 800, ...clusterOptions } = {}) {
    this.onFlush = onFlush;
    this.windowMs = windowMs;
    this.clusterOptions = clusterOptions;
    this.pending = [];
    this.timer = null;
  }

  submit(utterance) {
    this.pending.push(utterance);
    if (!this.timer) this.timer = setTimeout(() => this._flush(), this.windowMs);
  }

  _flush() {
    const batch = this.pending;
    this.pending = [];
    this.timer = null;
    for (const result of clusterUtterances(batch, this.clusterOptions)) this.onFlush(result);
  }

  /** Escape hatch for shutdown/tests: emit whatever's pending right now
   *  instead of waiting out the rest of the window. */
  flushNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length) this._flush();
  }
}

/** 1.0 = identical direction, 0 = unrelated, -1 = opposite. Pure vector math —
 *  no native call, no model — so it's trivially testable with synthetic
 *  vectors instead of needing real audio or a loaded model. */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Which enrolled player (if any) this embedding most likely belongs to.
 * `enrolled` is a Map (or any `[playerId, embedding]` iterable) of the room's
 * voiceprints. Returns null below `threshold` — an unmatched or low-confidence
 * embedding falls back to whatever device-prior attribution already decided,
 * rather than forcing a guess.
 */
export function matchEnrolledSpeaker(embedding, enrolled, threshold = DEFAULT_EMBEDDING_THRESHOLD) {
  if (!embedding || !enrolled) return null;
  let bestPlayerId = null;
  let bestScore = -Infinity;
  for (const [playerId, enrolledEmbedding] of enrolled) {
    const score = cosineSimilarity(embedding, enrolledEmbedding);
    if (score > bestScore) {
      bestScore = score;
      bestPlayerId = playerId;
    }
  }
  return bestScore >= threshold ? bestPlayerId : null;
}
