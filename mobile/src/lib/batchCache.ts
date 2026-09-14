import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BatchSpec, Difficulty } from '../types/batch';

/**
 * Replay cache: the batch a worksheet already produced, keyed by the bytes we
 * actually uploaded.
 *
 * The pipeline costs ~45s and real API spend (ARCH §2). The demo is judged live
 * (PRD §9), and the two moments that hurt most are the presenter showing the
 * same worksheet twice and the presenter retrying after a stumble — both of
 * which currently pay the full 45s again, on stage. They also make every
 * rehearsal run cost money. This turns the second run into a replay.
 *
 * Sits beside `zing.history` under its own key and follows the same rule: it is
 * a convenience, so **nothing in here may throw into the capture or player
 * path**. Every failure — unreadable JSON, a full disk, a dead media host —
 * degrades to a normal pipeline run and says nothing.
 */

const STORAGE_KEY = 'zing.batchcache';

/**
 * Measured on the real rehearsal specs: `api/batch-on-level.json` is 61.8KB
 * pretty-printed but **25.2KB** as `JSON.stringify` writes it, of which 16.4KB
 * (65%) is the per-word narration timings — ~3.1KB per slide. The Planner's
 * hard ceiling is 12 slides (ARCH §2 S3), so the worst batch this can be asked
 * to hold is ~38KB and four of them are ~150KB.
 *
 * That is a comfortable fit: AsyncStorage on Android is SQLite, whose
 * CursorWindow caps a single row at 2MB, and this stays under a tenth of it.
 * Four entries also covers the shape the demo actually needs — two worksheets
 * at two difficulties, or one worksheet plus a rehearsal spare.
 */
const MAX_ENTRIES = 4;

/** Belt and braces against a spec that somehow blows past the Planner budget. */
const MAX_ENTRY_BYTES = 384 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024;

/**
 * Long enough to cover a rehearsal day and the demo that follows it, short
 * enough that a stale entry cannot outlive the laptop session that produced it
 * by much. The liveness probe below is what actually protects a hit; this is
 * hygiene, so the store does not accumulate specs whose media died weeks ago.
 */
const TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A hit has to be *playable*, not just present. Generous enough that a live but
 * venue-Wi-Fi-slow host still passes — a false negative costs the presenter the
 * full 45s, which is the expensive mistake here.
 */
const PROBE_TIMEOUT_MS = 2_500;

interface CacheEntry {
  key: string;
  batch: BatchSpec;
  createdAt: number;
}

/**
 * The cache key: the content fingerprint of the prepared upload (see
 * `worksheet.ts` — the downscaled JPEG or the PDF, never the camera original)
 * plus the chosen difficulty, because the same worksheet at on-level and at
 * challenge are different batches and must not collide.
 *
 * `undefined` fingerprint means the platform would not hash the file; that is
 * simply "do not cache", not an error.
 */
export function batchCacheKey(
  fingerprint: string | undefined,
  difficulty: Difficulty,
): string | null {
  return fingerprint ? `${fingerprint}:${difficulty}` : null;
}

/**
 * One fingerprint for a whole upload set, since an upload is now any number of
 * photos and PDFs (see `mediaTray.ts`) and the batch they produce belongs to all
 * of them together.
 *
 * Order-sensitive on purpose: the tray's order is the order S1 reads the pages
 * in, so front-then-back is not the same input as back-then-front and must not
 * share a cache entry. A single unhashable item poisons the whole set — one page
 * we cannot pin means we cannot claim the batch matches what was sent, which the
 * cache reads as "do not cache" and simply runs the pipeline.
 */
export function combineFingerprints(
  fingerprints: (string | undefined)[],
): string | undefined {
  if (fingerprints.length === 0) return undefined;
  if (fingerprints.some((fingerprint) => !fingerprint)) return undefined;
  if (fingerprints.length === 1) return fingerprints[0];
  return `set${fingerprints.length}-${fingerprints.join('+')}`;
}

export async function readCachedBatch(key: string): Promise<BatchSpec | null> {
  const entries = await loadEntries();
  return entries.find((entry) => entry.key === key)?.batch ?? null;
}

/**
 * Fire-and-forget. Resolves rather than rejects on every failure path so the
 * caller can `void` it without a floating rejection reaching the player.
 */
export async function writeCachedBatch(key: string, batch: BatchSpec): Promise<void> {
  try {
    const entry: CacheEntry = { key, batch, createdAt: Date.now() };
    if (JSON.stringify(entry).length > MAX_ENTRY_BYTES) return;

    const existing = await loadEntries();
    let next = [entry, ...existing.filter((e) => e.key !== key)].slice(0, MAX_ENTRIES);

    // Evict oldest-first until the whole value fits. `next` is newest-first, so
    // dropping from the back drops the oldest.
    let serialized = JSON.stringify(next);
    while (next.length > 1 && serialized.length > MAX_TOTAL_BYTES) {
      next = next.slice(0, -1);
      serialized = JSON.stringify(next);
    }
    if (serialized.length > MAX_TOTAL_BYTES) return;

    await AsyncStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // A cache that cannot be written is a cache miss next time. Nothing else.
  }
}

export async function clearBatchCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignored
  }
}

/**
 * Is this entry's media still there?
 *
 * A cached spec's `imageUrl` points at fal (URLs expire) and its `audioUrl` at
 * `http://<laptop>/api/audio/<id>` — an in-process store that dies with the dev
 * server and whose host is the laptop's LAN address (ARCH §2 S4). So a hit can
 * hand back a spec whose media is gone, and the player would degrade it to
 * silent captions-over-tint. That is strictly worse than a cache miss, which
 * would have produced live media or, failing that, the bundled fallback batch
 * whose media is on disk.
 *
 * The bar is that a hit is never worse than a miss, so we check rather than
 * hope. A TTL alone cannot do this: the failure that actually happens on demo
 * day is the dev server restarting or the laptop changing IP, which has nothing
 * to do with elapsed time. One range request against one image and one clip
 * probes both hosts directly and costs a fraction of a second. Anything other
 * than a clean response — 404, connection refused, timeout, a server that
 * dislikes the request — reads as dead and we run the pipeline for real, so the
 * probe's own failure mode is the safe one.
 */
export async function cachedMediaIsLive(batch: BatchSpec): Promise<boolean> {
  const { urls, hasMedia } = probeTargets(batch);

  // Nothing to play at all: a fresh run can only do better.
  if (!hasMedia) return false;

  // Media that is not fetched over the network (bundled assets, data URIs)
  // cannot expire, so there is nothing to validate.
  if (urls.length === 0) return true;

  const results = await Promise.all(urls.map(probe));
  return results.every(Boolean);
}

/** The first remote image and the first remote clip — one probe per host. */
function probeTargets(batch: BatchSpec): { urls: string[]; hasMedia: boolean } {
  let image: string | undefined;
  let audio: string | undefined;
  let hasMedia = false;

  for (const group of batch.groups ?? []) {
    for (const lesson of group.lessons ?? []) {
      for (const slide of lesson.slides ?? []) {
        if (slide.imageUrl) {
          hasMedia = true;
          if (!image && isRemote(slide.imageUrl)) image = slide.imageUrl;
        }
        if (slide.audioUrl) {
          hasMedia = true;
          if (!audio && isRemote(slide.audioUrl)) audio = slide.audioUrl;
        }
      }
    }
  }

  return { urls: [image, audio].filter((url): url is string => Boolean(url)), hasMedia };
}

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // A one-byte range, so a live fal CDN answers 206 with nothing in it. A
    // host that ignores `Range` answers 200 with a small asset, which is still
    // cheap; both are `ok`.
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loadEntries(): Promise<CacheEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as CacheEntry[]).filter((entry) => isUsable(entry, now));
  } catch {
    return [];
  }
}

function isUsable(entry: CacheEntry | undefined, now: number): boolean {
  return (
    !!entry &&
    typeof entry.key === 'string' &&
    typeof entry.createdAt === 'number' &&
    // `Math.abs` so a device clock that moved backwards expires an entry rather
    // than making it immortal.
    Math.abs(now - entry.createdAt) < TTL_MS &&
    !!entry.batch &&
    Array.isArray(entry.batch.groups) &&
    entry.batch.groups.length > 0
  );
}
