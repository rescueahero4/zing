import { StageError, isRetryableStatus, requireEnv } from './http';
import { isMock, mockAudioBytes, mockNarrationWords } from './mock';
import type { NarrationWord } from './schema';

/**
 * ElevenLabs `eleven_flash_v2_5` — one clip per slide. ARCH §2.S4 wants a batch
 * to sound like a single person, so the teacher is drawn *once per batch* from
 * a small pool and every slide in that batch reuses it: two runs of the demo
 * get different teachers, one run never switches mid-lesson.
 *
 * We call the `/with-timestamps` variant, which returns base64 audio plus a
 * character-level alignment, so the player can light the narration word by word
 * (ARCH §3 `narrationWords`). It is the same model and the same voice — only
 * the response envelope differs. If it fails for any reason we fall straight
 * back to plain TTS and the slide simply ships without timings: the karaoke
 * overlay is a nicety, the audio is not.
 *
 * Returns raw mp3 bytes; the caller decides where they land (Blob or data-URI).
 */
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'mp3_44100_128';

/**
 * Stock pool — four teacher voices. Override with ELEVENLABS_VOICE_IDS (a
 * comma-separated list) so swapping or adding teachers needs no code change.
 */
const DEFAULT_VOICE_IDS = [
  'Xb7hH8MSUJpSbSDYk0k2', // Alice — clear, engaging educator (British)
  'Rsz5u2Huh1hPlPr0oxRQ', // Josh — slow, natural, calm (American)
  'hpp4J3VqNfWAUOO0d1Us', // Bella — professional, bright, warm (American)
  'JBFqnCBsd6RMkjVDRZzb', // George — warm, captivating storyteller (British)
];

export const AUDIO_CONTENT_TYPE = 'audio/mpeg';

/** One clip: bytes, plus per-word timings when ElevenLabs gave us any. */
export interface NarrationClip {
  audio: Buffer;
  /** Absent when the timestamps call failed or its alignment did not parse. */
  words?: NarrationWord[];
}

/**
 * The configured pool, in order, never empty. `ELEVENLABS_VOICE_ID` (singular)
 * still works and simply pins the pool to one voice.
 */
export function voicePool(): string[] {
  const configured = (process.env.ELEVENLABS_VOICE_IDS || process.env.ELEVENLABS_VOICE_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_VOICE_IDS;
}

/**
 * Draw the narrator for one batch. Call this once per request and thread the
 * result through every slide — calling it per slide would change teacher
 * between slides, which is exactly what ARCH §2.S4 rules out.
 */
export function pickVoiceId(): string {
  const pool = voicePool();
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function synthesizeNarration(
  text: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<NarrationClip> {
  if (isMock()) return { audio: mockAudioBytes(), words: mockNarrationWords(text) };

  try {
    return await synthesizeWithTimestamps(text, voiceId, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Deliberately swallowed: /api/assets is allowed to lose the karaoke
    // timings, not the clip. Retrying at *this* level is the caller's job —
    // a 429 here will usually 429 below too, and the route's jittered retry
    // then brings the whole slide back round.
    console.warn(
      `[zing:assets] timestamps unavailable, falling back to plain TTS — ${describe(error)}`,
    );
  }

  return { audio: await synthesizePlain(text, voiceId, signal) };
}

/**
 * POST /v1/text-to-speech/{voice}/with-timestamps — verified against the live
 * API: returns `audio_base64` plus `alignment` and `normalized_alignment`, each
 * `{ characters[], character_start_times_seconds[], character_end_times_seconds[] }`.
 *
 * We read `alignment`, not `normalized_alignment`: normalization is what the
 * model *spoke* (it rewrites "—" to "--", collapses runs of spaces, and pads
 * with a leading and trailing space), whereas `alignment.characters` joins back
 * to the exact narration string the app is rendering. Karaoke has to highlight
 * the words on screen, so it has to be indexed against the text on screen.
 */
async function synthesizeWithTimestamps(
  text: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<NarrationClip> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': requireEnv('ELEVENLABS_API_KEY'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
      signal,
    },
  );

  if (!response.ok) throw await responseError(response);

  const payload = (await response.json()) as {
    audio_base64?: unknown;
    alignment?: unknown;
  };

  if (typeof payload.audio_base64 !== 'string' || payload.audio_base64.length === 0) {
    throw new StageError('elevenlabs timestamps response had no audio_base64', 502, 'assets');
  }

  const words = wordsFromAlignment(payload.alignment);
  return {
    audio: Buffer.from(payload.audio_base64, 'base64'),
    // An alignment we could not read is the same as no alignment: ship the clip.
    words: words.length > 0 ? words : undefined,
  };
}

/** The original bytes-only call, still the floor under every failure above. */
async function synthesizePlain(
  text: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': requireEnv('ELEVENLABS_API_KEY'),
        'Content-Type': 'application/json',
        Accept: AUDIO_CONTENT_TYPE,
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
      signal,
    },
  );

  if (!response.ok) throw await responseError(response);

  return Buffer.from(await response.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * Alignment → words
 * ------------------------------------------------------------------ */

/**
 * Collapses a character-level alignment into the `narrationWords` contract.
 *
 * Words are whitespace-delimited runs, so punctuation stays welded to the token
 * it trails ("eighths!") and a hyphenated word stays one token ("hands-on") —
 * joining the result with single spaces reproduces the narration closely enough
 * to highlight against. A word starts at its first character's start time and
 * ends at its last character's end time; runs of whitespace, leading or
 * trailing, contribute nothing but a boundary.
 *
 * Pure and total: anything it cannot read comes back as `[]`, which the caller
 * reads as "no timings" and omits the field.
 */
export function wordsFromAlignment(alignment: unknown): NarrationWord[] {
  const source = alignment as
    | {
        characters?: unknown;
        character_start_times_seconds?: unknown;
        character_end_times_seconds?: unknown;
      }
    | null
    | undefined;

  const characters = source?.characters;
  const starts = source?.character_start_times_seconds;
  const ends = source?.character_end_times_seconds;

  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return [];
  if (characters.length !== starts.length || characters.length !== ends.length) return [];

  const words: NarrationWord[] = [];
  let current: { word: string; startMs: number; endMs: number } | null = null;
  // The Batch Spec requires the timings to be non-decreasing across the array.
  // ElevenLabs already returns them that way; this makes it true by
  // construction so a provider hiccup cannot produce a spec that fails Zod.
  let floorMs = 0;

  const flush = () => {
    if (current) words.push(current);
    current = null;
  };

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (typeof char !== 'string' || char.trim() === '') {
      flush();
      continue;
    }
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i])) return [];

    const startMs = Math.max(floorMs, Math.round((starts[i] as number) * 1000));
    const endMs = Math.max(startMs, Math.round((ends[i] as number) * 1000));
    floorMs = endMs;

    if (current) {
      current.word += char;
      current.endMs = endMs;
    } else {
      current = { word: char, startMs, endMs };
    }
  }
  flush();

  return words;
}

/* ------------------------------------------------------------------ */

async function responseError(response: Response): Promise<StageError> {
  let detail = '(no body)';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    // keep the placeholder
  }
  return new StageError(
    `elevenlabs returned ${response.status}: ${detail}`,
    502,
    'assets',
    isRetryableStatus(response.status),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
