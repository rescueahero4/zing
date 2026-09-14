import { useCallback, useMemo, useRef, useState } from 'react';
import type { WorksheetSource } from './api';
import {
  MAX_IMAGE_TIER,
  MAX_UPLOAD_CHARS,
  MAX_UPLOAD_ITEMS,
  WorksheetError,
  pickFromCamera,
  pickFromLibrary,
  pickPdfs,
  prepareAsset,
  type PickOrigin,
  type PickedAsset,
} from './worksheet';

/**
 * The staging tray behind the Capture screen.
 *
 * A worksheet is gathered, not captured: front page from the camera, back page
 * from the camera roll, the teacher's PDF from Files. So the three pickers stop
 * being three ways to *start* a batch and become three ways to add to one, and
 * the send button becomes a confirmation of what is already on screen.
 *
 * Which only reads as instant if the work is already done by the time it is
 * tapped. Resizing and base64-encoding a photo is the better part of a second
 * each, so every added item is prepared immediately, in the background, while
 * the parent is still picking the next one — and while they still have the
 * option of removing it. By the time the tray is full it is usually also ready,
 * and `settle()` is a no-op; when it is not, it waits on what is left rather
 * than starting from scratch.
 *
 * The queue is deliberately **serial**. Each prepare holds a decoded bitmap and
 * hands back a multi-megabyte base64 string; running eight of those at once on a
 * mid-range phone is how this turns into an out-of-memory crash, and the wall
 * clock barely improves because the work is native and already busy.
 */

/**
 * How long one item may spend preparing before the tray gives up on it.
 *
 * Generously past the worst measured case (a 3MB PDF read and encoded on a slow
 * device is a couple of seconds), because the point is not to police speed. It
 * is that `settle()` is what the send button awaits, so a native call that never
 * comes back — a corrupt file the manipulator chokes on, a cloud photo the
 * system stops serving mid-read — would otherwise leave that button spinning
 * with no way out of it. On timeout the item fails like any other unreadable
 * page: the parent sees which one, and can drop it and send the rest.
 */
const PREPARE_TIMEOUT_MS = 25_000;

export type TrayStatus = 'pending' | 'ready' | 'failed';

export interface TrayItem extends PickedAsset {
  status: TrayStatus;
  /** Set once `status === 'ready'` — the payload S1 gets. */
  source?: WorksheetSource;
  /** Base64 characters this item contributes to the upload. */
  chars?: number;
  /**
   * Which rung of the resampling ladder produced `source`. 0 is full quality;
   * anything higher means this page was re-encoded smaller so the set would fit.
   */
  tier?: number;
  /** The downscaled JPEG for images; falls back to the picker's own URI. */
  previewUri?: string;
  /** Set once `status === 'failed'`, in the parent's words. */
  error?: string;
}

export interface AddOutcome {
  added: number;
  /** Picked but not staged: duplicates, or past the item cap. */
  dropped: number;
}

export interface MediaTray {
  items: TrayItem[];
  /** Ready items' share of `MAX_UPLOAD_CHARS`; pending items are not counted yet. */
  chars: number;
  pending: number;
  ready: number;
  failed: number;
  /** How many pages were re-encoded smaller so the set would fit. */
  resampled: number;
  /** True while the tray is resampling to fit. */
  fitting: boolean;
  /**
   * True when what is already prepared will not fit in one request *and* the
   * ladder has nothing left to give — PDFs, which we cannot re-encode, or images
   * already at the floor.
   */
  overBudget: boolean;
  freeSlots: number;
  add: (origin: PickOrigin) => Promise<AddOutcome>;
  remove: (id: string) => void;
  /** Resolves when nothing is left preparing; returns the settled tray. */
  settle: () => Promise<TrayItem[]>;
}

export function useMediaTray(): MediaTray {
  const [items, setItems] = useState<TrayItem[]>([]);
  const [fitting, setFitting] = useState(false);

  // The tray is read from two places React state cannot serve: the background
  // queue, which must see removals that happened during an `await`, and
  // `settle()`, which has to return the tray as it is *now* rather than as it
  // was when the pressed button rendered. So the ref is the source of truth and
  // state is its mirror.
  const itemsRef = useRef<TrayItem[]>([]);
  const pumping = useRef(false);
  const waiters = useRef<(() => void)[]>([]);

  const commit = useCallback((next: TrayItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<TrayItem>) => {
      // Silently drops the update when the item was removed mid-prepare, which
      // is the whole point of doing this against the ref.
      if (!itemsRef.current.some((item) => item.id === id)) return;
      commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    },
    [commit],
  );

  /**
   * Bring the set inside `MAX_UPLOAD_CHARS` by re-encoding the biggest image a
   * rung further down the ladder, then measuring again.
   *
   * Greedy on the largest contributor because that is where a rung buys the most
   * per render, and it tends to leave the small pages untouched entirely rather
   * than degrading all eight to save one. Terminates either way: every pass
   * either raises some item's tier or returns, so it is bounded by items × rungs.
   */
  const fit = useCallback(async () => {
    for (;;) {
      const items = itemsRef.current;
      if (readyChars(items) <= MAX_UPLOAD_CHARS) return;

      const squeezable = items
        .filter(
          (item) =>
            item.status === 'ready' && item.kind === 'image' && (item.tier ?? 0) < MAX_IMAGE_TIER,
        )
        .sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0));
      const target = squeezable[0];
      // Nothing left to give: PDFs, or every image already at the floor. The
      // screen surfaces this as "remove a page", which by now it truthfully is.
      if (!target) return;

      const tier = (target.tier ?? 0) + 1;
      try {
        const prepared = await withTimeout(prepareAsset(target, tier), PREPARE_TIMEOUT_MS);
        patch(target.id, {
          tier,
          source: prepared.source,
          chars: prepared.chars,
          previewUri: prepared.previewUri ?? target.uri,
        });
      } catch {
        // A rung that will not encode is not a broken page — the one we already
        // have is still sendable. Retire it from the ladder so this cannot spin.
        patch(target.id, { tier: MAX_IMAGE_TIER });
      }
    }
  }, [patch]);

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((item) => item.status === 'pending');
        if (next) {
          try {
            const prepared = await withTimeout(prepareAsset(next), PREPARE_TIMEOUT_MS);
            patch(next.id, {
              status: 'ready',
              tier: 0,
              source: prepared.source,
              chars: prepared.chars,
              previewUri: prepared.previewUri ?? next.uri,
            });
          } catch (error) {
            patch(next.id, {
              status: 'failed',
              error:
                error instanceof WorksheetError
                  ? error.message
                  : 'Zing could not read this one. Try adding it again.',
            });
          }
          continue;
        }

        // Nothing left to prepare. Resampling runs here, inside the pump, so
        // that `settle()` — and therefore the send button — waits for it too,
        // and so it happens as the set grows past the budget rather than all at
        // once at the end.
        if (readyChars(itemsRef.current) > MAX_UPLOAD_CHARS) {
          setFitting(true);
          try {
            await fit();
          } finally {
            setFitting(false);
          }
          // A page added while that was running has to be picked up here: `add`
          // saw the pump as busy and did not start another one.
          if (itemsRef.current.some((item) => item.status === 'pending')) continue;
        }
        break;
      }
    } finally {
      pumping.current = false;
      const pendingWaiters = waiters.current;
      waiters.current = [];
      for (const resolve of pendingWaiters) resolve();
    }
  }, [patch]);

  const add = useCallback(
    async (origin: PickOrigin): Promise<AddOutcome> => {
      const free = MAX_UPLOAD_ITEMS - itemsRef.current.length;
      if (free <= 0) {
        throw new WorksheetError(
          `That is ${MAX_UPLOAD_ITEMS} pages already — remove one to add another.`,
        );
      }

      const picked = origin === 'camera'
        ? await pickFromCamera()
        : origin === 'library'
          ? await pickFromLibrary(free)
          : await pickPdfs();
      if (picked.length === 0) return { added: 0, dropped: 0 };

      // The library sheet honours `selectionLimit`, but Files does not take one
      // and the same photo can be picked twice across two trips, so both are
      // enforced here as well.
      const staged: TrayItem[] = [];
      for (const asset of picked) {
        if (staged.length >= free) break;
        const seen = [...itemsRef.current, ...staged].some((item) => item.uri === asset.uri);
        if (seen) continue;
        staged.push({ ...asset, status: 'pending' });
      }

      if (staged.length > 0) {
        commit([...itemsRef.current, ...staged]);
        void pump();
      }
      return { added: staged.length, dropped: picked.length - staged.length };
    },
    [commit, pump],
  );

  const remove = useCallback(
    (id: string) => {
      commit(itemsRef.current.filter((item) => item.id !== id));
    },
    [commit],
  );

  const settle = useCallback(async (): Promise<TrayItem[]> => {
    if (itemsRef.current.some((item) => item.status === 'pending')) {
      // A pump is normally already running; this covers the window where one
      // finished just as the last item was added.
      void pump();
      await new Promise<void>((resolve) => waiters.current.push(resolve));
    }
    return itemsRef.current;
  }, [pump]);

  const totals = useMemo(() => summarize(items), [items]);

  return {
    items,
    ...totals,
    fitting,
    freeSlots: MAX_UPLOAD_ITEMS - items.length,
    add,
    remove,
    settle,
  };
}

/**
 * The abandoned work is not cancellable — `ImageManipulator` and `File.base64`
 * have no abort — so it is simply orphaned: nothing awaits it and nothing patches
 * the tray from it, which is why the item's state is decided in one place.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WorksheetError('That page took too long to get ready. Remove it and try again.')),
      ms,
    );
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** What the request body would weigh right now. */
function readyChars(items: TrayItem[]): number {
  return items.reduce(
    (total, item) => (item.status === 'ready' ? total + (item.chars ?? 0) : total),
    0,
  );
}

function summarize(items: TrayItem[]) {
  let chars = 0;
  let pending = 0;
  let ready = 0;
  let failed = 0;
  let resampled = 0;
  let squeezable = 0;
  for (const item of items) {
    if (item.status === 'pending') pending += 1;
    if (item.status === 'failed') failed += 1;
    if (item.status === 'ready') {
      ready += 1;
      chars += item.chars ?? 0;
      if ((item.tier ?? 0) > 0) resampled += 1;
      if (item.kind === 'image' && (item.tier ?? 0) < MAX_IMAGE_TIER) squeezable += 1;
    }
  }
  return {
    chars,
    pending,
    ready,
    failed,
    resampled,
    // Over budget with a rung still to spend is not something to report — it is
    // about to be fixed. Only a set the ladder cannot save is the parent's problem.
    overBudget: chars > MAX_UPLOAD_CHARS && squeezable === 0,
  };
}

/** For the screen's "N of 4MB" line — the tray's only unit the parent sees. */
export function describeSize(chars: number): string {
  // Base64 characters, not bytes on disk: this is what the request body weighs,
  // and the ceiling it is measured against is written in the same unit.
  const mb = chars / (1024 * 1024);
  return mb < 0.1 ? '<0.1 MB' : `${mb.toFixed(1)} MB`;
}

export { MAX_UPLOAD_CHARS, MAX_UPLOAD_ITEMS };
