import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { WorksheetSource } from './api';

/**
 * Turning what the child pointed the phone at into the base64 payload S1 wants.
 *
 * A worksheet is not always one page, and it is not always one *kind* of page —
 * a parent photographs the front, picks the back out of the camera roll, and
 * adds the teacher's PDF. So picking and preparing are split: the pickers below
 * return cheap descriptors the tray can show immediately, and `prepareAsset`
 * does the expensive resize/encode work off the tap (see `mediaTray.ts`).
 *
 * Photos are resized before encoding. A raw 12MP phone photo base64-encodes to
 * roughly 8MB, which is over Vercel's request-body limit — and Claude's vision
 * path downsamples anything past ~1568px on the long edge anyway, so the extra
 * pixels buy nothing and cost the whole upload.
 */
const MAX_IMAGE_EDGE = 1568;

/**
 * The resampling ladder, walked only when a set overflows `MAX_UPLOAD_CHARS`.
 *
 * Eight photos at full quality do not fit in one request, and the honest-but-
 * useless answer to that is "remove a page". So instead the tray re-encodes the
 * biggest contributors a rung at a time until the set fits (`mediaTray.ts`),
 * which is the same trade as compressing an image for the web: spend quality
 * nobody can see to buy bytes everybody pays for.
 *
 * Quality is spent before resolution, because a worksheet is line art on white —
 * it stays readable through aggressive quantisation long after a photograph
 * would look muddy, and losing pixels is what actually costs S1 its reading of
 * the handwriting. The floor is deliberate: 1024px on the long edge still
 * resolves printed text and pencil, and S1 is identifying topics rather than
 * transcribing (ARCH §2.S1), so the last rung is a page Claude can still read
 * rather than the smallest file we could produce. Eight pages at the floor come
 * to well under a megabyte, so the ladder always bottoms out inside the budget.
 *
 * A rung is never chosen by arithmetic — the tray re-encodes and *measures*,
 * because how much a JPEG or WebP gives back at a given quality depends entirely
 * on the picture.
 */
const IMAGE_TIERS: { edge: number; compress: number }[] = [
  { edge: MAX_IMAGE_EDGE, compress: 0.7 },
  { edge: MAX_IMAGE_EDGE, compress: 0.5 },
  { edge: 1280, compress: 0.45 },
  { edge: 1120, compress: 0.4 },
  { edge: 1024, compress: 0.35 },
];

/** The last rung; an item here cannot be squeezed further. */
export const MAX_IMAGE_TIER = IMAGE_TIERS.length - 1;

/**
 * Anthropic accepts ≤100pp / 32MB natively, but the PDF has to reach the
 * Vercel function first (PRD §2) and base64 inflates it by a third. The same
 * ~4.5MB request-body ceiling that governs photos governs this: 3MB of PDF
 * encodes to ~4MB, which fits; anything larger is rejected before it is read.
 */
const MAX_PDF_BYTES = 3 * 1024 * 1024;

/**
 * The whole upload's ceiling, counted in base64 characters because that is what
 * the request body actually carries.
 *
 * Per-item limits alone stopped being enough once a batch can hold several
 * items: eight photos that each pass the 1568px cap still add up past what the
 * function will accept. Set so the one biggest single item that has always been
 * allowed — a 3MB PDF, which encodes to exactly this — still fits on its own.
 *
 * Overflowing it is not an error the parent has to solve. The tray resamples
 * photos down `IMAGE_TIERS` until the set fits, and only a set the ladder cannot
 * save — PDFs, or photos already at the floor — becomes "remove a page".
 */
export const MAX_UPLOAD_CHARS = 4 * 1024 * 1024;

/**
 * How many items one batch may stage.
 *
 * Not a technical limit — `MAX_UPLOAD_CHARS` binds long before Claude's
 * per-request image cap does. It is the point past which "some pages of one
 * worksheet" has stopped being that, and a grid of eight thumbnails is still
 * something a parent can check at a glance before tapping send.
 */
export const MAX_UPLOAD_ITEMS = 8;

export class WorksheetError extends Error {}

export type SourceKind = 'image' | 'pdf';

/** Where the parent got this item; drives the tray's badge and nothing else. */
export type PickOrigin = 'camera' | 'library' | 'files';

/**
 * A picked-but-not-yet-processed item: what the picker told us, plus an id.
 * Cheap enough to put on screen in the same frame the picker closes.
 */
export interface PickedAsset {
  id: string;
  kind: SourceKind;
  origin: PickOrigin;
  /** Local file URI as the picker handed it back; the tray's thumbnail source. */
  uri: string;
  name?: string;
  width?: number;
  height?: number;
  /** Bytes on disk, when the picker reported it. */
  size?: number;
}

export interface PreparedAsset {
  source: WorksheetSource;
  /**
   * Base64 characters in `source.data` — the item's share of `MAX_UPLOAD_CHARS`.
   */
  chars: number;
  /**
   * What the tray should show. For a photo this is the *downscaled* JPEG rather
   * than the camera original, so the thumbnail is the picture being sent.
   */
  previewUri?: string;
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `item-${sequence}`;
}

export async function pickFromCamera(): Promise<PickedAsset[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new WorksheetError('Zing needs camera access to read the worksheet.');
  }

  const result = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: false });
  return result.canceled ? [] : result.assets.map((asset) => imageAsset(asset, 'camera'));
}

/**
 * `limit` is the number of free slots left in the tray, passed straight to the
 * system sheet so the parent is stopped inside the picker rather than told
 * afterwards that four of their six photos were dropped.
 */
export async function pickFromLibrary(limit: number): Promise<PickedAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing: false,
    allowsMultipleSelection: true,
    // The badges number the photos in the order they were tapped, which is the
    // order they are sent in — page order is content for a multi-page worksheet.
    orderedSelection: true,
    selectionLimit: Math.max(1, limit),
  });
  return result.canceled ? [] : result.assets.map((asset) => imageAsset(asset, 'library'));
}

export async function pickPdfs(): Promise<PickedAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];

  return result.assets.map((asset) => ({
    id: nextId(),
    kind: 'pdf' as const,
    origin: 'files' as const,
    uri: asset.uri,
    name: asset.name,
    size: asset.size,
  }));
}

function imageAsset(asset: ImagePicker.ImagePickerAsset, origin: PickOrigin): PickedAsset {
  return {
    id: nextId(),
    kind: 'image',
    origin,
    uri: asset.uri,
    name: asset.fileName ?? undefined,
    width: asset.width,
    height: asset.height,
    size: asset.fileSize,
  };
}

/**
 * The expensive half: resize, encode, hash. Runs in the tray's background queue.
 *
 * `tier` indexes the resampling ladder — 0 is full quality, and the tray only
 * asks for a higher rung when the set it is holding does not fit.
 */
export function prepareAsset(asset: PickedAsset, tier = 0): Promise<PreparedAsset> {
  return asset.kind === 'pdf' ? preparePdf(asset) : prepareImage(asset, tier);
}

async function preparePdf(asset: PickedAsset): Promise<PreparedAsset> {
  const file = new File(asset.uri);
  if (file.size > MAX_PDF_BYTES) {
    throw new WorksheetError(
      'That PDF is too big to send. Take a photo of the page you want instead — one page is all Zing needs.',
    );
  }

  const data = await file.base64();
  return {
    source: { kind: 'pdf', data, fingerprint: fingerprintOf(file, 'pdf') },
    chars: data.length,
  };
}

async function prepareImage(asset: PickedAsset, tier: number): Promise<PreparedAsset> {
  const { edge, compress } = IMAGE_TIERS[Math.min(Math.max(tier, 0), MAX_IMAGE_TIER)];
  const encoded = await encodeImage(asset, edge, compress);

  return {
    source: {
      kind: 'image',
      mediaType: encoded.mediaType,
      data: encoded.base64,
      // `encoded.uri` is the *re-encoded* image — the same bytes `data` carries,
      // not the camera original. Hashing the original would key the cache on
      // something we never send, and the resample step would be free to change
      // the payload underneath a "hit". It also means a squeezed page correctly
      // keys a different batch than the full-quality one did.
      fingerprint: fingerprintOf(new File(encoded.uri), 'image'),
    },
    chars: encoded.base64.length,
    previewUri: encoded.uri,
  };
}

/**
 * Whether this device's encoder actually honours a WebP request.
 *
 * WebP is worth asking for: at a matched appearance it lands ~25-30% under JPEG,
 * which is a page or two more per upload before the ladder above has to give up
 * any quality at all. Claude accepts it (`image/webp` is in S1's allow-list).
 *
 * But `mediaType` is a promise made to the API about the bytes, and a platform
 * that quietly hands back JPEG for a WebP request would have us break that
 * promise — Anthropic rejects the mismatch, which surfaces as the whole batch
 * dropping to the bundled fallback. Too quiet a failure to risk on a stage. So
 * the first encode is *verified* rather than trusted, and the answer is
 * remembered: `null` until asked, then true, or false and never asked again.
 */
let webpVerified: boolean | null = null;

async function encodeImage(
  asset: PickedAsset,
  edge: number,
  compress: number,
): Promise<{ base64: string; uri: string; mediaType: 'image/webp' | 'image/jpeg' }> {
  if (webpVerified !== false) {
    const attempt = await renderTo(asset, edge, compress, SaveFormat.WEBP);
    if (attempt.base64 && isWebp(attempt.base64)) {
      webpVerified = true;
      return { base64: attempt.base64, uri: attempt.uri, mediaType: 'image/webp' };
    }
    // Costs one wasted render, once per app session, and buys certainty.
    webpVerified = false;
  }

  const saved = await renderTo(asset, edge, compress, SaveFormat.JPEG);
  if (!saved.base64) {
    throw new WorksheetError('Could not read that photo. Try taking it again.');
  }
  return { base64: saved.base64, uri: saved.uri, mediaType: 'image/jpeg' };
}

async function renderTo(asset: PickedAsset, edge: number, compress: number, format: SaveFormat) {
  const context = ImageManipulator.manipulate(asset.uri);

  // Always from the *original*, never from a previous rung: re-compressing an
  // already-compressed image compounds its artefacts, so a page that steps down
  // the ladder twice would carry both rungs' damage for one rung's saving.
  //
  // Cap the **long** edge, not the width: a parent photographs a page in
  // portrait, and capping 3024×4032 by width still leaves 1568×2090 for Claude
  // to downsample server-side — the same picture, ~1.8× the upload.
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const longEdge = Math.max(width, height);
  if (!longEdge) {
    // The picker reports 0 when the system withheld the dimensions; cap the
    // width so an unknown photo is still bounded.
    context.resize({ width: edge });
  } else if (longEdge > edge) {
    context.resize(height > width ? { height: edge } : { width: edge });
  }

  const rendered = await context.renderAsync();
  return rendered.saveAsync({ format, compress, base64: true });
}

/**
 * WebP is a RIFF container, so its bytes open "RIFF" — which base64 renders as
 * the prefix "UklGR", readable straight off the encoded string with no second
 * read of the file. A JPEG would start "/9j/".
 */
function isWebp(base64: string): boolean {
  return base64.startsWith('UklGR');
}

/**
 * The batch cache's key material (see `batchCache.ts`).
 *
 * `expo-file-system` is already a dependency and its `File` exposes a native
 * MD5, so there is no new package to add and no multi-megabyte hash loop on the
 * JS thread — the platform reads the file and returns a digest. MD5's weakness
 * is collision *forgery*, which needs an attacker; here the input is a photo
 * the parent just took, so it is only ever being asked to tell two worksheets
 * apart. The byte length rides along anyway.
 *
 * Returns `undefined` when the platform will not hash the file, which the cache
 * reads as "do not cache" — a normal pipeline run, silently.
 */
function fingerprintOf(file: File, kind: SourceKind): string | undefined {
  try {
    const md5 = file.md5;
    return md5 ? `${kind}-${md5}-${file.size}` : undefined;
  } catch {
    return undefined;
  }
}
