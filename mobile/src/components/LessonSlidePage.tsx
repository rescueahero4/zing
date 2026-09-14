import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import { fill, slideFallbackTints, spacing } from '../theme';
import { slideNarration, type NarrationClock } from '../lib/narration';
import { NarrationText } from './NarrationText';
import type { KenBurns, Slide } from '../types/batch';

interface Props {
  slide: Slide;
  /** Index in the flattened page list — picks the tint, and anchors the scroll parallax. */
  pageIndex: number;
  height: number;
  width: number;
  active: boolean;
  /** The child has held this slide: the Ken Burns drift stops with the voice. */
  paused: boolean;
  /** Bottom safe-area inset, so the narration clears the home indicator. */
  bottomInset: number;
  /** The screen's one accelerometer feed, normalised to −1…1 per axis. */
  tilt: Animated.ValueXY;
  /** The pager's scroll offset, driven natively by `Animated.event`. */
  scrollY: Animated.Value;
  /** The screen's narration clock — read only while this page is `active`. */
  clock: NarrationClock;
  /** False when the OS asks for reduced motion: Ken Burns only, no parallax. */
  parallax: boolean;
}

const KEN_BURNS_MS = 12_000;

/** Ken Burns keyframes, before the parallax overscan below is folded in. */
const KEN_BURNS: Record<KenBurns, { from: number; to: number; panX: number }> = {
  'zoom-in': { from: 1.02, to: 1.16, panX: 0 },
  'zoom-out': { from: 1.16, to: 1.02, panX: 0 },
  'pan-left': { from: 1.14, to: 1.14, panX: 26 },
  'pan-right': { from: 1.14, to: 1.14, panX: -26 },
};

/**
 * Every Ken Burns phase is scaled up by this on top of its own zoom, purely to
 * buy the parallax room to move inside. Without it `zoom-in` bottoms out at
 * 1.02, which hides only ~2pt of image past each side of a 390pt screen —
 * less than the pan phases already spend — and any tilt at all would drag the
 * fallback tint into frame.
 */
const OVERSCAN = 1.1;

/** Ceilings on the image layer's travel, in points; the budget below may cut them. */
const TILT_X_MAX = 10;
const TILT_Y_MAX = 8;
const SCROLL_Y_MAX = 26;

/** The foreground moves against the image, and much less — that gap is the depth. */
const FG_TILT_X_MAX = 4;
const FG_TILT_Y_MAX = 3;
const FG_SCROLL_Y_MAX = 9;

type Travel = Animated.AnimatedInterpolation<number>;

/**
 * A lesson slide (ARCH §4): the prefetched image under a slow scale/translate
 * loop (Ken Burns), given depth by a tilt- and scroll-driven parallax, with the
 * narration drawn natively on top and lit up word by word against the clip —
 * never baked into the picture.
 */
function LessonSlidePageImpl({
  slide,
  pageIndex,
  height,
  width,
  active,
  paused,
  bottomInset,
  tilt,
  scrollY,
  clock,
  parallax,
}: Props) {
  const progress = useRef(new Animated.Value(0)).current;
  /** Which end the drift is travelling towards, and how much of that leg it has
   *  already spent. Both outlive a pause, which is what lets the resume pick the
   *  leg up mid-flight instead of restarting it at its full twelve seconds. */
  const heading = useRef<0 | 1>(1);
  const spent = useRef(0);

  useEffect(() => {
    if (!active || paused) return;
    let cancelled = false;
    let legStartedAt = Date.now();

    // A hand-rolled ping-pong rather than `Animated.loop`, which has no way to
    // resume a half-finished leg. A native timing takes its *start* from the
    // node's current native value, so shortening the duration is all it takes
    // for the drift to carry on from where the pause froze it, at its own speed.
    const leg = () => {
      legStartedAt = Date.now();
      Animated.timing(progress, {
        toValue: heading.current,
        duration: Math.max(0, KEN_BURNS_MS - spent.current),
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (cancelled || !finished) return;
        heading.current = heading.current === 1 ? 0 : 1;
        spent.current = 0;
        leg();
      });
    };
    leg();

    return () => {
      cancelled = true;
      spent.current = Math.min(KEN_BURNS_MS, spent.current + (Date.now() - legStartedAt));
      progress.stopAnimation();
    };
  }, [active, paused, progress]);

  const tint = slideFallbackTints[pageIndex % slideFallbackTints.length];
  const { words, timings } = useMemo(() => slideNarration(slide), [slide]);

  const kenBurns = KEN_BURNS[slide.kenBurns];
  const budget = travelBudget(slide.kenBurns, width, height);

  const scale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [kenBurns.from * OVERSCAN, kenBurns.to * OVERSCAN],
  });
  const kenBurnsX =
    kenBurns.panX === 0
      ? null
      : progress.interpolate({ inputRange: [0, 1], outputRange: [kenBurns.panX, -kenBurns.panX] });

  // Tilting the phone pushes the image the other way, so the frame reads as a
  // window onto something behind it rather than a sticker on the glass.
  const imageTiltX = parallax ? axis(tilt.x, -budget.tiltX) : null;
  const imageTiltY = parallax ? axis(tilt.y, -budget.tiltY) : null;
  const imageScrollY = parallax ? pageScroll(scrollY, pageIndex, height, budget.scrollY) : null;

  const foregroundTiltX = parallax ? axis(tilt.x, FG_TILT_X_MAX) : null;
  const foregroundTiltY = parallax ? axis(tilt.y, FG_TILT_Y_MAX) : null;
  const foregroundScrollY = parallax
    ? pageScroll(scrollY, pageIndex, height, -FG_SCROLL_Y_MAX)
    : null;

  return (
    <View style={[styles.page, { height, backgroundColor: tint }]}>
      <Animated.View
        style={[
          styles.imageLayer,
          { transform: transforms(scale, sum(kenBurnsX, imageTiltX), sum(imageScrollY, imageTiltY)) },
        ]}
      >
        {slide.imageUrl ? (
          <Image source={{ uri: slide.imageUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          // No image: the narration still has to read, so the tint carries the page.
          <View style={[styles.image, { backgroundColor: tint }]} />
        )}
      </Animated.View>

      {/* Flat and still on purpose: a uniform fill has nothing to reveal by
          moving, so only the words below travel. */}
      <View style={styles.scrim} pointerEvents="none" />

      <Animated.View
        style={[
          styles.foreground,
          { transform: transforms(null, foregroundTiltX, sum(foregroundScrollY, foregroundTiltY)) },
        ]}
        pointerEvents="none"
      >
        <View
          style={[
            styles.narrationWrap,
            // The home indicator plus one step of breathing room, and nothing
            // else: the gradient plate that used to hang past this edge is gone,
            // so the words carry their own contrast (see `NarrationText`) and
            // the illustration is left uncovered.
            { paddingBottom: Math.max(bottomInset, spacing.md) + spacing.md },
          ]}
        >
          <NarrationText words={words} clock={active ? clock : null} timed={timings !== null} />
        </View>
      </Animated.View>
    </View>
  );
}

export const LessonSlidePage = memo(LessonSlidePageImpl);

/**
 * How far the image layer may travel, in the layer's own pre-scale units.
 *
 * `transform: [{ scale: s }, { translateX: t }]` composes as scale ∘ translate,
 * so a translate of `t` lands `s·t` points on screen — while a layer scaled to
 * `s` only hides `(s−1)·edge/2` points past each edge. Solving `s·t ≤
 * (s−1)·edge/2` gives the cap below, evaluated at the *smallest* scale the Ken
 * Burns loop reaches (its tightest moment, when the least image is hidden) and
 * with the pan phase's own 26pt already spent. Were the transform order ever
 * the other way round the on-screen travel would be `t`, not `s·t`, so this cap
 * is strictly safe either way: no phase can open a gap at the frame edge.
 */
function travelBudget(kind: KenBurns, width: number, height: number) {
  const { from, to, panX } = KEN_BURNS[kind];
  const scale = Math.min(from, to) * OVERSCAN;
  const hidden = (edge: number) => ((scale - 1) * edge) / (2 * scale);

  const spare = Math.max(0, hidden(width) - Math.abs(panX));
  const vertical = hidden(height);

  return {
    tiltX: Math.min(TILT_X_MAX, spare * 0.8),
    // Tilt and scroll share the vertical budget and still leave a tenth spare.
    tiltY: Math.min(TILT_Y_MAX, vertical * 0.28),
    scrollY: Math.min(SCROLL_Y_MAX, vertical * 0.6),
  };
}

/** −1…1 from the sensor, mapped onto a layer's travel in points. */
function axis(value: Animated.Value, amount: number): Travel {
  return value.interpolate({ inputRange: [-1, 1], outputRange: [-amount, amount] });
}

/**
 * The pager's offset turned into this page's own displacement: zero when the
 * page is at rest, growing as it scrolls away, clamped past its neighbours so a
 * page four screens up is not still being translated.
 */
function pageScroll(
  scrollY: Animated.Value,
  pageIndex: number,
  height: number,
  amount: number,
): Travel {
  return scrollY.interpolate({
    inputRange: [(pageIndex - 1) * height, pageIndex * height, (pageIndex + 1) * height],
    outputRange: [-amount, 0, amount],
    extrapolate: 'clamp',
  });
}

function sum(a: Travel | null, b: Travel | null): Travel | null {
  if (a && b) return Animated.add(a, b);
  return a ?? b;
}

function transforms(scale: Travel | null, translateX: Travel | null, translateY: Travel | null) {
  const list: ({ scale: Travel } | { translateX: Travel } | { translateY: Travel })[] = [];
  if (scale) list.push({ scale });
  if (translateX) list.push({ translateX });
  if (translateY) list.push({ translateY });
  return list;
}

const styles = StyleSheet.create({
  page: {
    width: '100%',
    justifyContent: 'flex-end',
    // The scaled image must not bleed onto the neighbouring pages of the pager.
    overflow: 'hidden',
  },
  imageLayer: { ...fill },
  image: { width: '100%', height: '100%' },
  scrim: {
    ...fill,
    backgroundColor: 'rgba(4, 7, 10, 0.26)',
  },
  foreground: {
    ...fill,
    justifyContent: 'flex-end',
  },
  narrationWrap: {
    paddingHorizontal: spacing.lg,
  },
});
