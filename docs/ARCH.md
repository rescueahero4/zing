# Zing — Architecture v4 (Hackathon POC)

**Stack:** Expo (React Native + TypeScript) via **Expo Go** · Next.js API-only backend on Vercel · Anthropic API (Claude Sonnet 4.6, vision + web_search) · fal.ai Flux schnell (720×1280 portrait) · ElevenLabs `eleven_flash_v2_5` (per-slide TTS) · AsyncStorage · `react-native-confetti-cannon`.

Everything builds from Windows; Expo Go runs the app on the phone from a QR code (no Mac even for iPhone); all keys stay on Vercel. The fixed 4-type question schema means **no WebView, no generated HTML** — every interaction is a native RN component, so the feed feels like TikTok, not a webpage.

---

## 1. System Overview

```
Expo Go on phone (RN + TypeScript)
 ├─ Capture      camera / photos / PDF into one tray, difficulty selector
 ├─ Generating   drives pipeline stages, narrates each agent as it runs
 ├─ BatchPlayer  vertical pager: lesson pages + quiz pages + scorecard
 ├─ ScoreCard    confetti, score, subjects, encouragement, Make it harder
 └─ History      AsyncStorage
        │  HTTPS
        ▼
Vercel serverless (Next.js API routes; ANTHROPIC / FAL / ELEVENLABS keys)
 ├─ POST /api/extract     Extractor: 1..8 pages, vision and/or PDF → topics, problems, grade band
 ├─ POST /api/research    Researcher swarm: ≤3 parallel calls, web_search on
 ├─ POST /api/compose     Planner → parallel Lesson & Quiz Writers → Encourager
 ├─ POST /api/assets      fan-out: fal image per slide ‖ ElevenLabs clip per slide
 ├─ GET  /api/audio/<id>  serves a clip when there is no Blob store (§2.S4)
 └─ GET  /api/fallback    cached demo batch — dev/diagnostic only
```

`/api/fallback` is off the runtime path: the app's insurance is the batch **bundled in the app** (§5), which needs no API to play. Note the media is only *files* in a standalone build: under Expo Go, `Image.resolveAssetSource` resolves bundled assets to Metro URLs, so a genuinely dead network degrades the fallback to captions-on-tint, silent, auto-advancing on the read-length timer. The route exists so the cached spec can be curled while developing.

The app is the Orchestrator's hands: it calls stages sequentially, passes outputs forward, narrates progress, enforces the 90s cap, and triggers fallback. Each function stays short (serverless-friendly), and progress narration is real, not simulated.

## 2. Agent Pipeline

**S1 `/api/extract` — Extractor** (1 Claude call over 1–8 pages, each an image or a native PDF `document` block, ≤100pp/32MB; ≤4.5MB of base64 per request): subjects, concrete problems, grade-band estimate, handwriting best-guess. K-12 curriculum framing. The pages are one worksheet gathered from any mix of sources (§1 Capture), labelled "Page N of M" and read together in a single call, so the ≤3 topics are chosen across the set rather than merged after the fact.

**S2 `/api/research` — Researcher swarm** (≤3 parallel calls, web_search): per topic — grade-band concepts, **misconceptions** (→ Challenge distractors), fun facts (→ lesson hooks).

**S3 `/api/compose` — the swarm's core** (one route, three internal waves):
1. **Curriculum Planner** (1 call): batch outline — 3–5 groups, lesson/quiz rhythm per group, which topic and question type each group gets, difficulty rubric applied (Easy: single-step recall, generous framing · On-level: grade-typical application · Challenge: multi-step + misconception distractors). **Hard budgets:** ≤12 slides, ≤12 images, 3–5 questions total (Zod-checked), plus ≥3 distinct question types and ~2 min of narration across the batch — the last two are Planner instructions that degrade with a logged warning rather than failing the batch, because a duller batch beats no batch.
2. **Lesson Writers ‖ Quiz Writers** (`Promise.all`, one call per group): writers get the plan slot + research; lesson writers return slides `{narration 2–3 warm sentences, caption, imagePrompt}`; quiz writers return one question `{type, prompt, config, answerKey, explanation}` — except `order`, where the writer returns its `items` **already in the correct sequence and no `answerKey` at all**, and the route scrambles them and derives `correctOrder` from its own scramble. A model asked to shuffle a list in its head and then describe where everything went gets it wrong often enough to matter; this makes the key a fact about what the server did. Image-prompt hard rule: scene/character/metaphor **only — no text, labels, numbers, diagrams** (models render glyph garbage; every word is a native RN overlay).
3. **Encourager** (1 small call, in the same `Promise.all`): three ScoreCard messages keyed to score bands (`high ≥80% · mid ≥50% · low`), growth-mindset, kid-addressed.
Route Zod-validates the assembled **Batch Spec**; malformed questions dropped; <3 valid questions → error → client falls back.

**S4 `/api/assets`** (fan-out `Promise.all`, bounded to 4 in flight per provider with one jittered retry on 429/5xx — the first real run lost 3 of 24 assets to provider rate limits, and throttling made the stage *faster*): fal Flux **schnell** `image_size:{width:720,height:1280}` with the prose style-lock prefix in `lib/fal.ts` (painterly airbrushed science-textbook illustration — saturated colour, soft graded shading, clean sky-blue ground — closing on the hard no-text/no-label/no-border rail) ~2–4s each; a `has_nsfw_concepts` hit is treated as a failed image and re-rolled, because the safety checker returns a black rectangle with a 200 rather than an error ‖ ElevenLabs `eleven_flash_v2_5`, one fixed teacher voice, mp3 per slide — via `POST /v1/text-to-speech/<voice>/with-timestamps`, which returns base64 audio plus a character-level `alignment` we fold into whole words for `narrationWords` (§3). Only the envelope differs; same model, same voice. Anything wrong with it — non-200, rate limit, alignment that will not parse — falls straight back to the plain bytes endpoint and the slide ships without `narrationWords`, because the karaoke overlay is optional and the clip is not. ElevenLabs returns bytes → hosted so the app receives plain URLs, three tiers: Vercel Blob when a token is set (the only one that survives a cold start) · else an in-process store served from `GET /api/audio/<id>` at the request's own host, which is enough for `next dev` · else base64 data-URIs inline, the POC last resort iOS may refuse to play. Returns the Batch Spec with `imageUrl`/`audioUrl` filled.

**Latency budget (batch starts <45s):** S1 ~8s · S2 ~15s · S3 ~12s (waves 2–3 parallel) · S4 ~10–15s (fully parallel). `maxDuration = 120` on research/compose/assets.

## 3. Batch Spec (the one contract)

```jsonc
{
  "batchId": "uuid",
  "topicSummary": "Fractions + animal habitats",
  "subjects": ["Math · Fractions", "Science · Habitats"],
  "difficulty": "on-level",
  "encouragement": { "high": "...", "mid": "...", "low": "..." },
  "groups": [
    { "lessons": [
        { "slides": [
            { "imageUrl": "...", "audioUrl": "...",   // filled by S4
              "narrationWords": [                     // filled by S4; absent if no timings
                { "word": "Eight", "startMs": 0,   "endMs": 267 },
                { "word": "equal", "startMs": 337, "endMs": 639 }],
              "narration": "Eight equal slices make one whole pizza — eight eighths.",
              "caption": "A pizza cut into 8 equal slices",
              "imagePrompt": "A cheerful pizza on a board, cut into eight even wedges",
              "kenBurns": "zoom-in" } ] }
      ],
      "quiz": {
        "id": "q1",
        "type": "slider",                     // slider | single | multi | order
        "prompt": "You ate 2 of 8 slices. What % is left?",
        "config":  { "min": 0, "max": 100, "step": 5, "unit": "%" },
        "answerKey": { "mode": "numeric-tolerance", "value": 75, "tolerance": 5 },
        "explanation": "6 of 8 slices = 6/8 = 75%!"
      } }
  ]
}
```

`narration` and `imagePrompt` are the writers' raw output and stay in the spec after S4 has consumed them: `narration` is what the player times a clip-less slide by, and `imagePrompt` is what makes a failed image re-runnable. `slider` `config.step` defaults to 1.

`narrationWords` is the karaoke track: whitespace-delimited display tokens with any trailing punctuation still attached (join with single spaces to get the narration back — no punctuation-only tokens), `startMs`/`endMs` integer milliseconds from the start of that slide's own clip, non-decreasing. It is **optional and its absence is never an error** — no clip, no timestamps, or an alignment that would not parse all mean the same thing to the app, which renders the narration statically instead of lighting it word by word.

Per-type `config`/`answerKey`: `single` → `{options[]}`/`{correctIndex}` · `multi` → `{options[]}`/`{correctIndices[]}` (set) · `order` → `{items[]}`/`{correctOrder[]}` (exact). The app flattens `groups` into a page list: `[...slides, quizPage] × groups, scoreCardPage`. Grading is a ~40-line pure function client-side.

## 4. Batch Player (RN)

- Vertical `FlatList`, `pagingEnabled`, full-screen pages; progress dots + mute persistent
- **Lesson slide page:** prefetched `Image` (`Image.prefetch` on all URLs the moment S4 returns) under a slow scale/translate loop (Ken Burns); `expo-audio` (`playsInSilentMode: true`) plays the clip; clip end → auto-advance, and a slide whose clip is missing falls back to a read-length timer off its `narration` so the feed still moves; batch starts from a user tap (never autoplay — iPhone audio policy)
- **Karaoke narration:** the slide draws `narration` — the words actually being spoken, not the written `caption` — and lights each word as the voice reaches it, driven by `narrationWords` (§3) against the player position. A clip without timings renders the narration statically rather than guessing: a highlight drifting out of sync reads as broken, static text does not. `caption` remains the fallback string when a slide has no narration.
- **2.5D parallax:** image, scrim and text sit on separate layers that move at different rates against device tilt (`expo-sensors`, smoothed and clamped) and against pager scroll, so the frame has depth and keeps moving between beats. Translation stays inside the Ken Burns overscan at every phase, or the image edge shows. One sensor subscription for the whole screen — eight slides are mounted at once — and every transform on the native driver.
- **Quiz page:** audio pauses, `scrollEnabled=false`; bottom-anchored card renders the widget:
  `slider` — `@react-native-community/slider` (in Expo Go) + big live readout · `single`/`multi` — option rows (+ confirm for multi) · `order` — **tap-to-order**: tap in sequence, numbered badges, re-tap to undo (no drag libs)
- Feedback: correct → mini confetti + chime; wrong → shake, highlight correct, explanation; then unlock scroll
- **ScoreCard page:** `react-native-confetti-cannon` full burst, score n/N, streak — the **longest** run of correct answers in ask order, not the run it ended on, and hidden below 2 — subject chips, encouragement picked by score band, Make it harder + Done
- State machine per page: `playing → question → feedback → playing → … → scorecard`

## 5. Difficulty, Recording, Insurance

- **Make it harder:** demo serves a pre-cached Challenge batch for the same worksheet (generated at rehearsal). Live path (`/api/compose`+`/api/assets` at level+1, reusing extraction+research) exists but off the critical path.
- **AsyncStorage** `zing.history`: `{batchId, topicSummary, difficulty, score, total, perQuestion:[{id,type,correct}], timestamp}`.
- **Fallback:** rehearsal batch spec + downloaded images/audio **bundled in the app** (fal/ElevenLabs URLs expire — save files, not links). Any stage error or >90s → seamless fallback; Generating screen finishes its animation either way.

## 6. Three-Hour Build Plan

| Time | Work |
|---|---|
| 0:00–0:20 | `create-expo-app` + API skeleton on Vercel; app open in Expo Go; camera + PDF pickers and one audio clip proven on phone |
| 0:20–1:10 | S1–S4 endpoints incl. Planner→Writers fan-out and fal/ElevenLabs assets; CLI-test on the demo worksheet until one good batch emerges |
| 1:10–2:00 | BatchPlayer: pager, Ken Burns, audio auto-advance, 4 widgets, grading, feedback, ScoreCard w/ confetti |
| 2:00–2:25 | Capture + Generating (agent narration) + wiring; history |
| 2:25–2:40 | Cache fallback batch + Challenge batch from clean pipeline runs; bundle assets |
| 2:40–3:00 | Full rehearsal on cellular + `--tunnel`; fix the two worst bugs; freeze |

**Cut order if behind:** history → PDF input → ElevenLabs (silent batch: captions + bundled background music) → live research (fold facts into Planner prompt) → `order` degrades to `single`. Never cut: BatchPlayer, ScoreCard confetti, live photo→batch path. Make-it-harder is pre-cut to cached.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Text/diagram garbage in images | Writers' hard rule: scenery/metaphor only; words are native overlays |
| fal or ElevenLabs slow/down | Bundled fallback batch; silent-with-captions degrade |
| iPhone silent switch mutes demo | `playsInSilentMode` + start-from-tap |
| Venue Wi-Fi | `npx expo start --tunnel`; rehearse on cellular; prefetch all images |
| Vision misreads handwriting | Rehearsed worksheet; extraction asks best-guess topics, not OCR |
| Malformed writer output | Zod validation server-side; drop bad questions; <3 valid → fallback |
| Asset-count blowout | Planner hard budgets: ≤12 slides/images, 3–5 questions, ~2 min narration |