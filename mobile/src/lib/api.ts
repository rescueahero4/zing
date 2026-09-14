import { Image } from 'react-native';
import type { BatchSpec, Difficulty } from '../types/batch';
import { getChallengeBatch, getFallbackBatch } from './fallback';
import {
  batchCacheKey,
  cachedMediaIsLive,
  combineFingerprints,
  readCachedBatch,
  writeCachedBatch,
} from './batchCache';

/**
 * The app is the Orchestrator's hands (ARCH §1): it calls the four stages in
 * sequence, passes each output forward, narrates progress, enforces the 90s
 * cap, and drops to the bundled fallback batch on any failure.
 */

const BASE_URL = (process.env.EXPO_PUBLIC_ZING_API_URL ?? '').replace(/\/+$/, '');

/** ARCH §5 — any stage error, or >90s total, means fallback. */
export const PIPELINE_DEADLINE_MS = 90_000;

export type StageId = 'extract' | 'research' | 'compose' | 'assets' | 'ready';

/** What the Generating screen reads out. Real progress, not a fake timeline. */
export const STAGE_SCRIPT: { id: StageId; agent: string; line: string }[] = [
  { id: 'extract', agent: 'Extractor', line: 'Reading your worksheet…' },
  { id: 'research', agent: 'Researcher swarm', line: 'Looking up how this is taught…' },
  { id: 'compose', agent: 'Planner + Writers', line: 'Writing your lessons and questions…' },
  { id: 'assets', agent: 'Illustrator + Narrator', line: 'Drawing the pictures and recording your teacher…' },
  { id: 'ready', agent: 'Zing', line: 'Your batch is ready!' },
];

export interface WorksheetSource {
  kind: 'image' | 'pdf';
  /** Base64, no data-URI prefix. */
  data: string;
  /** Required for `image`, e.g. "image/jpeg". */
  mediaType?: string;
  /**
   * Content hash of the bytes in `data`, from `worksheet.ts`. Keys the replay
   * cache; absent means this worksheet is not cacheable and the pipeline runs
   * normally.
   */
  fingerprint?: string;
}

export interface PipelineResult {
  batch: BatchSpec;
  /** True when the child is looking at the bundled batch, not a fresh one. */
  usedFallback: boolean;
  /** True when this batch was replayed from the cache rather than generated. */
  fromCache?: boolean;
  /** Kept so **Make it harder** can re-run compose+assets at level+1. */
  context?: { extraction: unknown; research: unknown };
  /**
   * Kept so **Make it harder** can find this worksheet's cached Challenge batch.
   * For a multi-page upload this is the whole set's combined fingerprint.
   */
  sourceFingerprint?: string;
}

export interface RunPipelineOptions {
  /**
   * Every page the parent staged, in tray order — one worksheet, gathered from
   * whatever mix of camera, camera roll and PDF they had (see `mediaTray.ts`).
   * S1 reads them together, so page order is content and is preserved.
   */
  sources: WorksheetSource[];
  difficulty: Difficulty;
  onStage?: (stage: StageId) => void;
}

class HttpError extends Error {}

async function postStage<T>(stage: string, body: unknown, signal: AbortSignal): Promise<T> {
  if (!BASE_URL) {
    throw new HttpError('EXPO_PUBLIC_ZING_API_URL is not set');
  }

  const response = await fetch(`${BASE_URL}/api/${stage}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = String(response.status);
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // keep the status code
    }
    throw new HttpError(`${stage} failed: ${detail}`);
  }

  return (await response.json()) as T;
}

/**
 * Prefetches every slide image the moment S4 returns (ARCH §4), so the first
 * page is already decoded when the child taps to start and the feed never
 * stutters on venue Wi-Fi.
 */
export function prefetchSlideImages(batch: BatchSpec): void {
  for (const group of batch.groups) {
    for (const lesson of group.lessons) {
      for (const slide of lesson.slides) {
        if (slide.imageUrl?.startsWith('http')) {
          Image.prefetch(slide.imageUrl).catch(() => {
            // A failed prefetch just means the <Image> fetches it later.
          });
        }
      }
    }
  }
}

/**
 * How long each agent line holds when a batch comes back from the cache.
 *
 * A hit could return in a single frame, and the first instinct is to let it.
 * But the Generating screen is not a spinner — it is the proof of the pitch's
 * central claim (PRD §5 priority 4, ARCH §1: "progress narration is real, not
 * simulated"), and the demo script spends a whole beat on it (PRD §9.2). Cutting
 * straight from a tap to a playing feed reads as a screen that failed to appear,
 * which on stage looks like a bug rather than like speed.
 *
 * So a hit still walks the same four agents, at ~4% of the real cadence: the
 * story stays continuous and the presenter keeps a sentence to land ("Zing
 * already knows this worksheet"), while ~1.0s here plus the existing 800ms
 * ready-dwell puts the batch on screen in under two seconds against ~45s. It is
 * also not a lie about the swarm — nobody watching four lines flash past thinks
 * an agent ran. Set to 0 to make replays truly instant during rehearsal.
 */
export const CACHE_REPLAY_STAGE_MS = 260;

/** One staged item as S1's request body carries it. */
function requestSource(source: WorksheetSource) {
  return source.kind === 'pdf'
    ? { kind: 'pdf' as const, data: source.data }
    : { kind: 'image' as const, mediaType: source.mediaType ?? 'image/jpeg', data: source.data };
}

async function narrateCacheHit(onStage?: (stage: StageId) => void): Promise<void> {
  for (const entry of STAGE_SCRIPT) {
    onStage?.(entry.id);
    if (entry.id === 'ready' || CACHE_REPLAY_STAGE_MS <= 0) continue;
    await new Promise((resolve) => setTimeout(resolve, CACHE_REPLAY_STAGE_MS));
  }
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const { sources, difficulty, onStage } = options;

  const fingerprint = combineFingerprints(sources.map((source) => source.fingerprint));

  // Replay check first, and deliberately outside the 90s deadline below: a hit
  // costs one probe round-trip, and a miss should still get the full budget.
  const cacheKey = batchCacheKey(fingerprint, difficulty);
  if (cacheKey) {
    const cached = await readCachedBatch(cacheKey);
    if (cached && (await cachedMediaIsLive(cached))) {
      prefetchSlideImages(cached);
      await narrateCacheHit(onStage);
      return {
        batch: cached,
        usedFallback: false,
        fromCache: true,
        sourceFingerprint: fingerprint,
      };
    }
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PIPELINE_DEADLINE_MS);

  try {
    onStage?.('extract');
    const { extraction } = await postStage<{ extraction: unknown }>(
      'extract',
      { sources: sources.map(requestSource), difficulty },
      controller.signal,
    );

    onStage?.('research');
    const { research } = await postStage<{ research: unknown }>(
      'research',
      { extraction, difficulty },
      controller.signal,
    );

    onStage?.('compose');
    const { batch: composed } = await postStage<{ batch: BatchSpec }>(
      'compose',
      { extraction, research, difficulty },
      controller.signal,
    );

    onStage?.('assets');
    const { batch } = await postStage<{ batch: BatchSpec }>(
      'assets',
      { batch: composed },
      controller.signal,
    );

    prefetchSlideImages(batch);
    // Only a real batch is worth replaying. The bundled fallback is never
    // cached: its media is on disk already, and storing it under a worksheet's
    // key would pin that worksheet to the insurance batch forever.
    if (cacheKey) void writeCachedBatch(cacheKey, batch);
    onStage?.('ready');
    return {
      batch,
      usedFallback: false,
      context: { extraction, research },
      sourceFingerprint: fingerprint,
    };
  } catch (error) {
    console.warn('[zing] pipeline fell back —', error instanceof Error ? error.message : error);
    onStage?.('ready');
    return { batch: getFallbackBatch(difficulty), usedFallback: true };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * ARCH §5 — **Make it harder** is pre-cut to the cached Challenge batch for the
 * demo. The live path (compose + assets at level+1, reusing the extraction and
 * research we already paid for) is implemented below but off the critical path;
 * flip this to try it.
 */
export const LIVE_MAKE_IT_HARDER = false;

export async function makeItHarder(previous: PipelineResult): Promise<PipelineResult> {
  // The demo path is the bundled Challenge batch, full stop — the cache is not
  // consulted and cannot get between the button and ARCH §5's insurance.
  if (!LIVE_MAKE_IT_HARDER) {
    return { batch: getChallengeBatch(), usedFallback: true };
  }

  // Live path only. Checked before the context guard, so a run that was itself
  // a replay (and therefore has no extraction/research to reuse) can still
  // serve a real Challenge batch if it generated one earlier.
  const cacheKey = batchCacheKey(previous.sourceFingerprint, 'challenge');
  if (cacheKey) {
    const cached = await readCachedBatch(cacheKey);
    if (cached && (await cachedMediaIsLive(cached))) {
      prefetchSlideImages(cached);
      return {
        batch: cached,
        usedFallback: false,
        fromCache: true,
        context: previous.context,
        sourceFingerprint: previous.sourceFingerprint,
      };
    }
  }

  if (!previous.context) {
    return { batch: getChallengeBatch(), usedFallback: true };
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PIPELINE_DEADLINE_MS);

  try {
    const { batch: composed } = await postStage<{ batch: BatchSpec }>(
      'compose',
      { ...previous.context, difficulty: 'challenge' as Difficulty },
      controller.signal,
    );
    const { batch } = await postStage<{ batch: BatchSpec }>(
      'assets',
      { batch: composed },
      controller.signal,
    );
    prefetchSlideImages(batch);
    if (cacheKey) void writeCachedBatch(cacheKey, batch);
    return {
      batch,
      usedFallback: false,
      context: previous.context,
      sourceFingerprint: previous.sourceFingerprint,
    };
  } catch (error) {
    console.warn('[zing] make-it-harder fell back —', error instanceof Error ? error.message : error);
    return { batch: getChallengeBatch(), usedFallback: true };
  } finally {
    clearTimeout(deadline);
  }
}
