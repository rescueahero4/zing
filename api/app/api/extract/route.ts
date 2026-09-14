import { z } from 'zod';
import { askJson, imageBlock, pdfBlock, textBlock } from '@/lib/claude';
import { EXTRACTOR_SYSTEM, extractorUser } from '@/lib/prompts';
import { StageError, fail, ok, readBody } from '@/lib/http';
import { Difficulty, Extraction } from '@/lib/schema';

export const runtime = 'nodejs';
export const maxDuration = 60;

const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/**
 * One worksheet arrives as any number of pages from any mix of sources — the app
 * stages them in a tray and sends them together (mobile `mediaTray.ts`).
 */
const MAX_SOURCES = 8;

/**
 * Vercel rejects a request body past ~4.5MB before this handler runs, so the
 * point of checking here is the *diagnosis*: a caller that overshoots gets a
 * 400 saying which limit it hit instead of a bare platform error. The app keeps
 * its own tighter budget and shows it to the parent as pages are added.
 */
const MAX_TOTAL_BASE64_CHARS = 4.5 * 1024 * 1024;

const ImageSource = z.object({
  kind: z.literal('image'),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  /** Base64, no data-URI prefix. */
  data: z.string().min(1),
});

const PdfSource = z.object({
  kind: z.literal('pdf'),
  data: z.string().min(1),
});

const Source = z.discriminatedUnion('kind', [ImageSource, PdfSource]);
type Source = z.infer<typeof Source>;

const RequestBody = z
  .object({
    difficulty: Difficulty,
    /** Pages in reading order. */
    sources: z.array(Source).min(1).max(MAX_SOURCES).optional(),
    // The single-source shape this stage shipped with. `scripts/smoke.ts` and
    // anything else pointed at one file still speak it; both forms normalize to
    // `sources` below.
    image: ImageSource.omit({ kind: true }).optional(),
    pdf: PdfSource.omit({ kind: true }).optional(),
  })
  .refine((body) => [body.sources, body.image, body.pdf].filter(Boolean).length === 1, {
    message: 'provide exactly one of `sources`, `image` or `pdf`',
  });

function normalize(body: z.infer<typeof RequestBody>): Source[] {
  if (body.sources) return body.sources;
  if (body.image) return [{ kind: 'image', ...body.image }];
  return [{ kind: 'pdf', ...body.pdf! }];
}

/**
 * S1 — Extractor. One Claude call over every page the parent sent, photo or
 * native PDF: subjects, concrete problems, grade-band estimate, handwriting
 * best-guess (ARCH §2.S1).
 *
 * Still **one** call, not one per page: the pages are one worksheet, and the
 * three topics this returns have to be chosen across all of them rather than
 * merged after the fact — which also keeps S1 inside its ~8s budget as pages are
 * added, since vision blocks in a single request are processed together.
 */
export async function POST(request: Request) {
  try {
    const body = await readBody(request, RequestBody);
    const sources = normalize(body);

    const totalChars = sources.reduce((total, source) => total + source.data.length, 0);
    if (totalChars > MAX_TOTAL_BASE64_CHARS) {
      throw new StageError(
        `upload is ${(totalChars / 1024 / 1024).toFixed(1)}MB of base64 across ${sources.length} pages; the limit is ${(MAX_TOTAL_BASE64_CHARS / 1024 / 1024).toFixed(1)}MB`,
        413,
      );
    }

    // Each page gets a label ahead of it. With several images in one turn, an
    // unlabelled run is exactly the case Claude confuses — "the answers on page
    // 2" needs page 2 to have been named.
    const pages = sources.flatMap((source, index) => [
      textBlock(pageLabel(index, sources.length)),
      source.kind === 'image' ? imageBlock(source.mediaType, source.data) : pdfBlock(source.data),
    ]);

    const extraction = await askJson({
      agent: 'extractor',
      system: EXTRACTOR_SYSTEM,
      user: [...pages, textBlock(extractorUser(body.difficulty, sources.length))],
      schema: Extraction,
      // Vision at `medium` cost ~12s against an 8s budget, and this stage is
      // identifying topics, not transcribing (ARCH §2.S1) — a job `low` does
      // as well in half the time.
      effort: 'low',
      maxTokens: 1024,
    });

    return ok({ extraction });
  } catch (error) {
    return fail(error instanceof StageError ? error : error, 'extract');
  }
}

function pageLabel(index: number, total: number): string {
  return total === 1 ? 'The worksheet:' : `Page ${index + 1} of ${total}:`;
}
