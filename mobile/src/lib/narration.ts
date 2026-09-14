import type { NarrationWord, Slide } from '../types/batch';

/**
 * The narration a lesson slide should show, split into the tokens the karaoke
 * highlight moves across.
 */
export interface SlideNarration {
  /** Display tokens, in order. Rendered with single spaces between them. */
  words: string[];
  /**
   * Per-word timings aligned to `words` by index, or `null` when the batch has
   * none — an older bundled batch, or a run where TTS timestamps failed.
   */
  timings: NarrationWord[] | null;
}

/**
 * ARCH §3 keeps `narration` in the spec after S4 has consumed it, so the player
 * can show the words the teacher voice is actually saying rather than the
 * one-line `caption` summary. `caption` stays as the last resort for the case
 * where a writer returned an empty narration.
 */
export function slideNarration(slide: Slide): SlideNarration {
  const narration = slide.narration?.trim() ?? '';
  if (!narration) return { words: tokenize(slide.caption), timings: null };

  const timings = slide.narrationWords;
  if (!timings || timings.length === 0) return { words: tokenize(narration), timings: null };

  // `NarrationWord.word` is the display token including trailing punctuation
  // (see `types/batch.ts`), so the timed tokens *are* the narration. Taking
  // them rather than re-splitting the string is what guarantees the highlight
  // index and the rendered word can never drift apart.
  return { words: timings.map((timed) => timed.word), timings };
}

function tokenize(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** A half-open range over `words`: the tokens one chunk shows. */
export interface NarrationChunk {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The most words a single chunk may hold. A narration runs 34–51 words, so this
 * cuts the typical slide cleanly in half and only reaches for a third leg when
 * the writer ran long — which is the point: the block on screen has to leave the
 * illustration visible, not cover it.
 */
const MAX_CHUNK_WORDS = 18;

/** How far a cut may be dragged off the even split to land on a full stop. */
const SNAP_WINDOW = 3;

/**
 * The narration split into the pieces the slide shows one after another.
 *
 * Cuts are placed on an even division and then pulled onto the nearest sentence
 * end within `SNAP_WINDOW`, preferring the earlier one — a chunk that ends on a
 * full stop reads as a complete thought, where one that ends mid-clause reads as
 * a bug. A narration short enough to fit already comes back as a single chunk.
 */
export function narrationChunks(words: string[]): NarrationChunk[] {
  const total = words.length;
  const count = Math.ceil(total / MAX_CHUNK_WORDS);
  if (count <= 1) return [{ start: 0, end: total }];

  const chunks: NarrationChunk[] = [];
  let start = 0;

  for (let i = 1; i < count; i++) {
    // Leave at least one word for every chunk still to come, and at least one
    // for this one, so no snap can produce an empty range.
    const cut = snapToSentence(words, Math.round((total * i) / count), start + 1, total - (count - i));
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: total });

  return chunks;
}

/** Which chunk holds `wordIndex`; the first one before the narration starts. */
export function chunkIndexAt(chunks: NarrationChunk[], wordIndex: number): number {
  if (wordIndex < 0) return 0;
  for (let i = chunks.length - 1; i > 0; i--) {
    if (wordIndex >= chunks[i].start) return i;
  }
  return 0;
}

function snapToSentence(words: string[], ideal: number, min: number, max: number): number {
  const clamp = (value: number) => Math.min(max, Math.max(min, value));

  for (let offset = 0; offset <= SNAP_WINDOW; offset++) {
    const candidates = offset === 0 ? [ideal] : [ideal - offset, ideal + offset];
    for (const candidate of candidates) {
      if (candidate < min || candidate > max) continue;
      if (endsSentence(words[candidate - 1])) return candidate;
    }
  }

  return clamp(ideal);
}

/** Terminator, optionally behind a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function endsSentence(word: string | undefined): boolean {
  return word !== undefined && SENTENCE_END.test(word);
}

/**
 * Index of the last word whose start has passed, or `-1` before the first one.
 *
 * A word stays current until the *next* one starts rather than dropping out at
 * its own `endMs`, so the highlight rides through the pauses between sentences
 * instead of blinking off at every full stop.
 *
 * Binary search, not a walk from the last index: it costs ~6 comparisons on a
 * 50-word narration and it is still correct if the clip is ever seeked or
 * replaced under us.
 */
export function wordIndexAt(words: NarrationWord[], positionMs: number): number {
  let low = 0;
  let high = words.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].startMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/**
 * The bridge between the audio player (which reports a position several times a
 * second) and the narration (which changes word a few dozen times a clip).
 *
 * `BatchPlayerScreen` owns one of these and pushes an index at it on every
 * status tick; `setIndex` drops the ticks that land on the same word, so the
 * subscribed `<Text>` nodes re-render only when the highlight actually moves.
 */
export interface NarrationClock {
  getIndex(): number;
  setIndex(next: number): void;
  subscribe(onChange: () => void): () => void;
}

export function createNarrationClock(): NarrationClock {
  let index = -1;
  const listeners = new Set<() => void>();

  return {
    getIndex: () => index,

    setIndex(next: number) {
      if (next === index) return;
      index = next;
      for (const listener of listeners) listener();
    },

    subscribe(onChange: () => void) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
