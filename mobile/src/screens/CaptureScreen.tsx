import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fill, radius, spacing, type } from '../theme';
import {
  MAX_UPLOAD_CHARS,
  MAX_UPLOAD_ITEMS,
  describeSize,
  useMediaTray,
  type MediaTray,
  type TrayItem,
} from '../lib/mediaTray';
import { WorksheetError, type PickOrigin } from '../lib/worksheet';
import type { WorksheetSource } from '../lib/api';
import type { Difficulty } from '../types/batch';

interface Props {
  onWorksheet: (sources: WorksheetSource[], difficulty: Difficulty) => void;
  onOpenHistory: () => void;
}

const DIFFICULTIES: { value: Difficulty; label: string; blurb: string }[] = [
  { value: 'easy', label: 'Easy', blurb: 'One step at a time' },
  { value: 'on-level', label: 'On level', blurb: 'Just right for the grade' },
  { value: 'challenge', label: 'Challenge', blurb: 'Multi-step, tricky options' },
];

const SOURCES: { origin: PickOrigin; glyph: string; label: string }[] = [
  { origin: 'camera', glyph: '📸', label: 'Camera' },
  { origin: 'library', glyph: '🖼️', label: 'Photos' },
  { origin: 'files', glyph: '📄', label: 'PDF' },
];

/**
 * Capture (ARCH §1): difficulty, then gather the worksheet from any mix of
 * camera, camera roll and PDF, then send it once.
 *
 * The three pickers add to a tray instead of firing the pipeline, so the parent
 * can photograph the front, pull the back out of their camera roll, drop in the
 * teacher's PDF, drop the blurry one, and only then commit. Each added item is
 * already being resized and encoded in the background (`useMediaTray`), which is
 * what lets the send button be a confirmation rather than the start of a wait.
 */
export function CaptureScreen({ onWorksheet, onOpenHistory }: Props) {
  const insets = useSafeAreaInsets();
  const [difficulty, setDifficulty] = useState<Difficulty>('on-level');
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const tray = useMediaTray();

  const add = async (origin: PickOrigin) => {
    if (picking || sending) return;
    setPicking(true);
    try {
      const { dropped } = await tray.add(origin);
      if (dropped > 0) {
        Alert.alert(
          'Some pages were left out',
          `Zing takes ${MAX_UPLOAD_ITEMS} pages at a time, and skips anything already in the tray. ${dropped} of those did not make it in.`,
        );
      }
    } catch (error) {
      Alert.alert(
        'Could not add that',
        error instanceof WorksheetError ? error.message : 'Something went wrong. Try again.',
      );
    } finally {
      setPicking(false);
    }
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      // Anything still encoding finishes here. Usually there is nothing left.
      const settled = await tray.settle();
      const ready = settled.filter((item) => item.status === 'ready' && item.source);
      const failed = settled.filter((item) => item.status === 'failed');

      if (ready.length === 0) {
        Alert.alert(
          'Nothing to send yet',
          failed.length > 0
            ? 'Zing could not read any of these. Try photographing the page again.'
            : 'Add a photo or a PDF of the worksheet first.',
        );
        return;
      }

      // The tray has already resampled everything it can by this point, so this
      // is the genuinely-too-big case: PDFs, or photos already at the floor.
      const chars = ready.reduce((total, item) => total + (item.chars ?? 0), 0);
      if (chars > MAX_UPLOAD_CHARS) {
        Alert.alert(
          'That is more than Zing can send at once',
          `Even shrunk, this batch is ${describeSize(chars)} of ${describeSize(MAX_UPLOAD_CHARS)}. Remove a page and try again.`,
        );
        return;
      }

      // Never silently drop a page the parent chose to add: the ones that failed
      // are on screen in coral, and sending without them is their call.
      if (failed.length > 0 && !(await confirmSkippingFailed(failed.length, ready.length))) {
        return;
      }

      onWorksheet(
        ready.map((item) => item.source as WorksheetSource),
        difficulty,
      );
    } finally {
      setSending(false);
    }
  };

  const staged = tray.items.length;
  const canSend = staged > 0 && !tray.overBudget && (tray.ready > 0 || tray.pending > 0);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
      ]}
    >
      <Text style={styles.wordmark}>zing</Text>
      <Text style={styles.tagline}>
        Point at today’s worksheet. Get it back as a feed you can actually scroll.
      </Text>

      <Text style={styles.sectionLabel}>HOW HARD?</Text>
      <View style={styles.difficultyRow}>
        {DIFFICULTIES.map((option) => {
          const selected = option.value === difficulty;
          return (
            <Pressable
              key={option.value}
              onPress={() => setDifficulty(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.difficulty,
                selected && styles.difficultySelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.difficultyLabel, selected && styles.difficultyLabelSelected]}>
                {option.label}
              </Text>
              <Text style={styles.difficultyBlurb}>{option.blurb}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>WHAT ARE WE LEARNING?</Text>
      <View style={styles.sourceRow}>
        {SOURCES.map((source) => (
          <Pressable
            key={source.origin}
            onPress={() => add(source.origin)}
            disabled={picking || sending || tray.freeSlots <= 0}
            accessibilityRole="button"
            accessibilityLabel={`Add from ${source.label}`}
            style={({ pressed }) => [
              styles.source,
              pressed && styles.pressed,
              (picking || sending || tray.freeSlots <= 0) && styles.disabled,
            ]}
          >
            <Text style={styles.sourceGlyph}>{source.glyph}</Text>
            <Text style={styles.sourceLabel}>{source.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.trayHeader}>
        <Text style={styles.sectionLabel}>
          {staged > 0 ? `IN THE TRAY · ${staged}/${MAX_UPLOAD_ITEMS}` : 'IN THE TRAY'}
        </Text>
        {tray.ready > 0 ? (
          <Text style={[styles.traySize, tray.overBudget && styles.traySizeOver]}>
            {describeSize(tray.chars)} / {describeSize(MAX_UPLOAD_CHARS)}
          </Text>
        ) : null}
      </View>

      {staged === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Mix as many as you like — a photo of the front, the back out of your camera roll, the
            teacher’s PDF. Nothing is sent until you tap below.
          </Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {tray.items.map((item, index) => (
            <TrayTile
              key={item.id}
              item={item}
              index={index}
              onRemove={() => tray.remove(item.id)}
              disabled={sending}
            />
          ))}
        </View>
      )}

      <Pressable
        onPress={send}
        disabled={!canSend || sending}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.primary,
          pressed && styles.pressed,
          (!canSend || sending) && styles.disabled,
        ]}
      >
        {sending ? <ActivityIndicator color={colors.onAccent} style={styles.spinner} /> : null}
        <Text style={styles.primaryText}>
          {staged === 0 ? 'Zing it' : `Zing it  ·  ${staged} ${staged === 1 ? 'page' : 'pages'}`}
        </Text>
      </Pressable>

      <Text style={styles.hint}>{hintFor(tray, sending)}</Text>

      <Pressable onPress={onOpenHistory} accessibilityRole="button" style={styles.historyLink}>
        <Text style={styles.historyText}>Past batches</Text>
      </Pressable>
    </ScrollView>
  );
}

interface TileProps {
  item: TrayItem;
  index: number;
  onRemove: () => void;
  disabled: boolean;
}

function TrayTile({ item, index, onRemove, disabled }: TileProps) {
  const failed = item.status === 'failed';
  return (
    <View style={[styles.tile, failed && styles.tileFailed]}>
      {item.kind === 'image' ? (
        <Image source={{ uri: item.previewUri ?? item.uri }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={styles.pdf}>
          <Text style={styles.pdfGlyph}>📄</Text>
          <Text style={styles.pdfName} numberOfLines={2}>
            {item.name ?? 'PDF'}
          </Text>
        </View>
      )}

      {item.status === 'pending' ? (
        <View style={styles.tileVeil}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}

      {failed ? (
        <Pressable
          onPress={() => Alert.alert('Could not read that', item.error ?? 'Try adding it again.')}
          accessibilityRole="button"
          style={styles.tileVeil}
        >
          <Text style={styles.tileFailedGlyph}>!</Text>
          <Text style={styles.tileFailedText}>Tap for why</Text>
        </Pressable>
      ) : null}

      <View style={styles.tileIndex}>
        <Text style={styles.tileIndexText}>
          {/* "2 ↓" — this page is in, and it was resampled to make room. */}
          {index + 1}
          {(item.tier ?? 0) > 0 ? ' ↓' : ''}
        </Text>
      </View>

      <Pressable
        onPress={onRemove}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Remove page ${index + 1}`}
        hitSlop={10}
        style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
      >
        <Text style={styles.removeText}>✕</Text>
      </Pressable>
    </View>
  );
}

function hintFor(tray: MediaTray, sending: boolean): string {
  if (tray.items.length === 0) return 'Add at least one page — camera, camera roll or PDF.';
  if (tray.overBudget) return 'Too much paper for one batch, even shrunk. Remove a page.';
  if (tray.fitting) return 'Resampling your photos so they all fit in one upload…';
  if (sending && tray.pending > 0) return 'Finishing the last page…';
  if (tray.pending > 0) {
    return `Getting ${tray.pending} ${tray.pending === 1 ? 'page' : 'pages'} ready — you can send now, Zing will wait for ${tray.pending === 1 ? 'it' : 'them'}.`;
  }
  if (tray.failed > 0) {
    const one = tray.failed === 1;
    return tray.ready === 0
      ? `Zing could not read ${one ? 'that page' : 'any of these'}. Remove ${one ? 'it' : 'them'} and try another photo.`
      : `${tray.failed} ${one ? 'page' : 'pages'} could not be read. Remove ${one ? 'it' : 'them'} or send the rest.`;
  }
  if (tray.resampled > 0) {
    const one = tray.resampled === 1;
    return `Ready — ${tray.resampled} ${one ? 'photo was' : 'photos were'} shrunk to fit. Still plenty for Zing to read.`;
  }
  return 'Ready. One tap and the swarm starts reading.';
}

/**
 * `onDismiss` matters: on Android the dialog is cancelable by tapping outside,
 * and without it that would leave the send button spinning on an unresolved
 * promise.
 */
function confirmSkippingFailed(failed: number, ready: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `${failed} ${failed === 1 ? 'page' : 'pages'} could not be read`,
      `Send the other ${ready} ${ready === 1 ? 'page' : 'pages'} without ${failed === 1 ? 'it' : 'them'}?`,
      [
        { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
        { text: `Send ${ready}`, onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.lg, flexGrow: 1, justifyContent: 'center' },
  wordmark: {
    ...type.score,
    color: colors.text,
    letterSpacing: -2,
    marginBottom: spacing.xs,
  },
  tagline: { ...type.option, color: colors.textDim, marginBottom: spacing.lg },
  sectionLabel: { ...type.label, color: colors.accent, marginBottom: spacing.sm },
  difficultyRow: { flexDirection: 'row', marginBottom: spacing.lg },
  difficulty: {
    flex: 1,
    backgroundColor: colors.bgLift,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.hairline,
    padding: spacing.sm,
    marginRight: spacing.xs,
  },
  difficultySelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  difficultyLabel: { ...type.body, color: colors.textDim, fontWeight: '800' },
  difficultyLabelSelected: { color: colors.text },
  difficultyBlurb: { ...type.body, fontSize: 12, lineHeight: 16, color: colors.textDim, marginTop: 2 },

  sourceRow: { flexDirection: 'row', columnGap: spacing.xs, marginBottom: spacing.lg },
  source: {
    flex: 1,
    backgroundColor: colors.bgLift,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  sourceGlyph: { fontSize: 22, lineHeight: 28 },
  sourceLabel: { ...type.body, color: colors.text, fontWeight: '700' },

  trayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  traySize: { ...type.body, fontSize: 12, color: colors.textDim, marginBottom: spacing.sm },
  traySizeOver: { color: colors.wrong, fontWeight: '800' },

  empty: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  emptyText: { ...type.body, color: colors.textDim },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.xs,
    rowGap: spacing.xs,
    marginBottom: spacing.lg,
  },
  tile: {
    flexBasis: '31.5%',
    aspectRatio: 0.78,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.bgLift,
    overflow: 'hidden',
  },
  tileFailed: { borderColor: colors.wrong, borderWidth: 2 },
  thumb: { width: '100%', height: '100%' },
  pdf: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xs },
  pdfGlyph: { fontSize: 26, lineHeight: 32 },
  pdfName: { ...type.body, fontSize: 11, lineHeight: 14, color: colors.textDim, textAlign: 'center' },
  tileVeil: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4, 7, 10, 0.72)',
  },
  tileFailedGlyph: { ...type.caption, color: colors.wrong },
  tileFailedText: { ...type.body, fontSize: 11, lineHeight: 14, color: colors.textDim },
  tileIndex: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    minWidth: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(4, 7, 10, 0.78)',
    alignItems: 'center',
  },
  tileIndexText: { ...type.label, fontSize: 11, letterSpacing: 0, color: colors.text },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(4, 7, 10, 0.86)',
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { color: colors.text, fontSize: 12, lineHeight: 14, fontWeight: '800' },

  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...type.option, color: colors.onAccent, fontSize: 18 },
  spinner: { marginRight: spacing.xs },
  hint: { ...type.body, fontSize: 13, color: colors.textDim, textAlign: 'center', marginTop: spacing.sm },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.45 },
  historyLink: { alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xs },
  historyText: { ...type.body, color: colors.textDim, textDecorationLine: 'underline' },
});
