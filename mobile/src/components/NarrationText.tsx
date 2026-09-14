import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { colors, type } from '../theme';
import { chunkIndexAt, narrationChunks, type NarrationClock } from '../lib/narration';

interface Props {
  /** Display tokens from `slideNarration`. */
  words: string[];
  /**
   * The screen's clock while this page is the one playing, `null` on every
   * other page — which is what stops the mounted-but-offscreen slides from
   * subscribing to a highlight that isn't theirs.
   */
  clock: NarrationClock | null;
  /** False when this slide has no per-word timings. */
  timed: boolean;
}

/** Past this many characters the block needs the tighter type step to stay clear
 *  of the HUD on a small phone — measured on the slide's longest chunk. */
const LONG_NARRATION_CHARS = 210;

/** How long a new chunk takes to arrive. Long enough to read as a hand-off. */
const CHUNK_FADE_MS = 220;

/**
 * The narration, lit up word by word against the clip (PRD §3 "the teacher
 * voice"). Every word is the same family, size, weight and letter-spacing and
 * differs only in colour, so the highlight moving through the block cannot
 * change any word's measured width — the text never reflows or jitters.
 *
 * A slide shows its narration a chunk at a time rather than all at once: the
 * voice reaches the end of one half and the next fades in over the same
 * illustration. Two short blocks in sequence cover far less of the art than one
 * long one, which is the whole reason the split exists.
 */
function NarrationTextImpl({ words, clock, timed }: Props) {
  // Subscribing through the clock rather than taking the index as a prop keeps
  // the position updates out of the parent's render path: only this component
  // re-renders, and only when the word actually changes.
  const subscribe = useCallback(
    (onChange: () => void) => (clock ? clock.subscribe(onChange) : NO_SUBSCRIPTION),
    [clock],
  );
  const getIndex = useCallback(() => (clock ? clock.getIndex() : -1), [clock]);
  const live = useSyncExternalStore(subscribe, getIndex);

  // No timings — an older bundled batch, or a run where the timestamps failed.
  // Every word reads as spoken and nothing moves. Estimating the timings would
  // drift against the clip within a sentence, and a highlight that drifts reads
  // as broken where a still block reads as a deliberate choice. Chunking needs
  // that same clock to hand over, so an untimed narration stays whole.
  const speaking = timed ? live : -1;
  const spokenThrough = timed ? live : words.length;

  const chunks = useMemo(
    () => (timed ? narrationChunks(words) : [{ start: 0, end: words.length }]),
    [words, timed],
  );
  const chunkIndex = chunkIndexAt(chunks, live);
  const chunk = chunks[chunkIndex];
  const visible = useMemo(() => words.slice(chunk.start, chunk.end), [words, chunk]);

  // Sized off the *longest* chunk, not the one on screen, so the type step is a
  // property of the slide: the hand-off changes the words, never their size.
  const long = useMemo(
    () => chunks.some((range) => characters(words, range) > LONG_NARRATION_CHARS),
    [words, chunks],
  );

  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    fade.setValue(0);
    const animation = Animated.timing(fade, {
      toValue: 1,
      duration: CHUNK_FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [chunkIndex, fade]);

  const step = long ? styles.long : styles.regular;

  return (
    <Animated.View style={{ opacity: fade }}>
      {/* Behind the words and in the same metrics: the ink that makes them read
          on any frame, now that no gradient is dimming the art for them. */}
      <NarrationOutline text={visible.join(' ')} long={long} />

      <Text style={step}>
        {visible.map((word, i) => {
          const index = chunk.start + i;
          return (
            <Text
              key={index}
              style={
                index === speaking
                  ? styles.speaking
                  : index < spokenThrough
                    ? styles.spoken
                    : styles.unspoken
              }
            >
              {i === 0 ? word : ` ${word}`}
            </Text>
          );
        })}
      </Text>
    </Animated.View>
  );
}

const NO_SUBSCRIPTION = () => {};

function characters(words: string[], range: { start: number; end: number }): number {
  let total = 0;
  for (let i = range.start; i < range.end; i++) total += words[i].length + 1;
  return total;
}

export const NarrationText = memo(NarrationTextImpl);

/** Near-solid ink: the outline has to hold against a white sky as well as a dark one. */
const OUTLINE_INK = 'rgba(3, 8, 12, 0.94)';
/** The cast shadow — semi-transparent, and hard-edged because it is a copy, not a blur. */
const DROP_INK = 'rgba(3, 8, 12, 0.5)';

const STROKE = 1.7;
/** Diagonals sit at `STROKE/√2` per axis so the outline is a circle, not a square. */
const DIAGONAL = STROKE * 0.71;

const OUTLINE_OFFSETS: readonly (readonly [number, number])[] = [
  [STROKE, 0],
  [-STROKE, 0],
  [0, STROKE],
  [0, -STROKE],
  [DIAGONAL, DIAGONAL],
  [DIAGONAL, -DIAGONAL],
  [-DIAGONAL, DIAGONAL],
  [-DIAGONAL, -DIAGONAL],
];

const DROP_OFFSET: readonly [number, number] = [0, 3];

/**
 * The readability layer, in place of a scrim.
 *
 * React Native has no text stroke, so the outline is the same string drawn once
 * per direction in ink and offset by a point and a half — eight copies plus a
 * dropped one, all absolutely positioned at the same width and in the same type
 * step as the words above them, so they wrap identically and register exactly.
 *
 * It is its own memoised component because the karaoke re-renders the block
 * every time the highlight moves, and none of this changes with it: the layer
 * is redrawn only when the chunk hands over.
 */
const NarrationOutline = memo(function NarrationOutline({
  text,
  long,
}: {
  text: string;
  long: boolean;
}) {
  const step = long ? styles.long : styles.regular;

  return (
    <>
      <Text
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={[
          step,
          styles.ghost,
          styles.drop,
          { transform: [{ translateX: DROP_OFFSET[0] }, { translateY: DROP_OFFSET[1] }] },
        ]}
      >
        {text}
      </Text>

      {OUTLINE_OFFSETS.map(([x, y], i) => (
        <Text
          key={i}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={[
            step,
            styles.ghost,
            styles.edge,
            { transform: [{ translateX: x }, { translateY: y }] },
          ]}
        >
          {text}
        </Text>
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  regular: { ...type.narration },
  long: { ...type.narrationLong },
  spoken: { color: colors.spoken },
  speaking: { color: colors.speaking },
  unspoken: { color: colors.unspoken },
  ghost: {
    position: 'absolute',
    // Left and right both pinned: the copy takes the same width as the block in
    // flow above it, which is what guarantees the same line breaks.
    left: 0,
    right: 0,
    top: 0,
  },
  edge: {
    color: OUTLINE_INK,
    // A hair of blur on each copy closes the gaps between the eight samples,
    // so the outline reads as one continuous edge rather than eight ghosts.
    textShadowColor: OUTLINE_INK,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 1.2,
  },
  drop: { color: DROP_INK },
});
