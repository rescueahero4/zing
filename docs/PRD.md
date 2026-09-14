# Zing — PRD v4 (Hackathon POC)

**Product:** Zing
**Author:** Robert Bagares
**Context:** Hackathon demo, judged live on Robert's phone. Build window: ~3 hours.
**One-liner:** Snap your kid's homework (or upload the PDF) and Zing turns it into a TikTok-style learning batch — AI-illustrated, teacher-narrated lesson contents with quiz questions woven between them — ending in a confetti scorecard.

---

## 1. Problem & Pitch

Parents want to help kids study, but turning a worksheet into an engaging session takes skill and energy most parents don't have on a school night. Zing makes the phone do it: photograph the homework and an agent swarm produces a vertical, swipeable batch in the format kids already can't put down — lessons that teach, quizzes that check, and a celebration at the end.

Core demo claim: **an orchestrated agent swarm turns any homework into native short-form learning content, live.**

## 2. Demo Constraints

| Constraint | Consequence |
|---|---|
| 3-hour build | Ruthless cuts; one happy path; fully cached fallback batch |
| Must be Kotlin, Flutter, or React Native | **React Native via Expo Go** — runs on the phone from Windows, no Mac/Xcode/build step |
| Judged live on the phone | Mobile-first; survives venue Wi-Fi; rehearsed on cellular |
| Sample content: mixed elementary math + science | Prompts, art style, and question mix tuned for this band |
| English only | ElevenLabs English teacher voice; no i18n |
| Vercel backend | All API keys (Anthropic, fal.ai, ElevenLabs) server-side only |

## 3. The Content Format: the Batch

One homework input → one **batch**, experienced as a full-screen vertical feed (Reels/TikTok grammar):

```
Batch
 ├─ Group ×3–5
 │    ├─ LessonContent ×1     — 1–4 slides (fal.ai Flux 720×1280 portrait
 │    │                          illustration + karaoke narration + ElevenLabs clip)
 │    └─ QuizContent  ×1      — one question, overlay card
 └─ ScoreCard                  — score, streak, subject chips, confetti, encouragement
```

- **Rhythm:** scroll a group's lesson slides → hit its 1 quiz content → repeat. 3–5 quiz questions per batch; the batch ends when all are answered.
- **POC budget (Planner-enforced):** ≤12 slides, ≤12 images, ~2 min total narration. The slide budget wins over the per-group count: a batch that overshoots is trimmed from the back, down to a single slide in a group if that is what fits. Demo default: 4 groups = 4 questions ≈ a 2–3 minute experience.
- **Images:** style-locked (painterly airbrushed science-textbook illustration — saturated, softly shaded, clean sky-blue ground — no text), 720×1280 — mobile-sharp, cheap, fast; never contain text/labels/diagrams (all words are native overlays).
- **Question schema** (Quiz Writer picks the fit): `slider` (0–100, tolerance-graded) · `single` (one tap) · `multi` (select + confirm) · `order` (tap-to-order with numbered badges). ≥3 types per batch.
- Quiz pages pause narration and lock scrolling until answered; instant feedback (confetti burst / shake + one-line explanation).

### ScoreCard
Score (n/N), streak, subject-matter chips ("Math · Fractions", "Science · Habitats"), full-screen confetti, and a **positive-reinforcement message** written by the Encourager agent at generation time in three score-band variants (crushing-it / solid / keep-going) — growth-mindset voice, kid-addressed, instant display with no extra API call. Buttons: **Make it harder** · Done.

## 4. Agent Swarm (the pitch's backbone)

| Agent | Role |
|---|---|
| **Orchestrator** | Drives the stage sequence, enforces budgets, validates outputs, triggers fallback |
| **Extractor** | Reads the photo/PDF → topics, problems, grade band |
| **Researcher swarm** | Parallel, web-search-armed; concepts, misconceptions, fun facts per topic |
| **Curriculum Planner** | Designs the batch: groups, lesson/quiz rhythm, difficulty application, budgets |
| **Lesson Writers** | Parallel, one per group: slide narration, captions, image prompts |
| **Quiz Writers** | Parallel, one per group: question, type choice, answer key, explanation |
| **Encourager** | ScoreCard messages ×3 score bands |

## 5. Priorities (stakeholder ranking)

1. **Immersive content** → the batch: images + voice + native interactions + scorecard payoff
2. **Difficulty calibration** → Easy / On-level / Challenge; demoed via a second cached Challenge batch
3. **Recording** → batch results in local history
4. **Visible swarm** → agent-by-agent status narration on the Generating screen

## 6. User Flow

1. Open Zing → pick difficulty (default On-level)
2. Add the homework — camera, camera roll, PDF, in any mix — check the tray, drop what you don't want, then **Zing it** once
3. Generating screen: swarm status narration (batch starts < 45s)
4. Swipe the batch: lessons play (Ken Burns + tilt parallax + narration lit word by word, auto-advance), quiz pages interrupt and lock until answered
5. All questions answered → **ScoreCard** (confetti, subjects, encouragement) → auto-saved
6. History: past batches (topic, difficulty, score, date)

## 7. Functional Requirements

**F1 Capture** — `expo-image-picker` camera and multi-select camera roll, `expo-document-picker` PDFs (Anthropic ingests PDFs natively), gathered into one tray of ≤8 pages from any mix of the three and sent in one request; on-device image downscale ≤1568px, done in the background as each page is added so the send button confirms rather than waits. A set that overflows the ~4MB request budget is resampled down a quality-then-resolution ladder (floor 1024px, WebP where the platform really supports it) rather than asking the parent to drop a page.
**F2 Batch generation** — extract → research → plan+write (parallel writers) → assets (parallel fal + ElevenLabs). Validated (Zod) before serving; malformed questions dropped, ≥3 valid or fallback.
**F3 Batch player** — vertical pager; slide pages auto-advance on audio end; quiz overlay cards with 4 native widgets; scroll lock during questions; prefetched images; mute + progress dots. The narration is drawn on the slide and lit **word by word against the audio** (ElevenLabs timestamps; static text when a clip has none), and the image, scrim and text move at different rates with device tilt and page scroll — a 2.5D parallax that keeps the screen alive between beats.
**F4 ScoreCard** — confetti cannon, score, subject chips, banded encouragement, Make it harder (cached Challenge batch in demo).
**F5 Recording** — AsyncStorage `{batchId, topicSummary, difficulty, score, total, perQuestion, timestamp}` + history screen.
**F6 Status narration** — Generating screen narrates the four real stages, one line each: "Reading the worksheet… Researchers are digging… Lesson writers drafting… Illustrating and recording narration…"

## 8. Non-goals
No auth, no server DB, no standalone binary, no offline, no COPPA review, no i18n, no social features despite the format.

## 9. Demo Script (~2.5 min)
1. "This is real homework." → snap, On-level
2. Talk the swarm over the status screen (~30s): name the agents as their stages light up
3. Batch plays: 2 lessons with sound up, answer a slider question live, one more lesson, deliberately miss an order question to show feedback
4. Finish remaining questions fast → **ScoreCard confetti moment** — this is the closing image judges keep
5. Tap Make it harder → flash one visibly tougher question (cached Challenge batch) → flash history

**Demo insurance:** rehearsal batch (spec + downloaded images + audio) bundled in the app; any error or >90s → seamless fallback.

## 10. Success Criteria
- Photo/PDF → batch playing < 45s (90s cap → fallback)
- Lesson→quiz rhythm lands: ≥3 question types, native feel, zero jank
- Difficulty visibly changes questions on the same topic
- ScoreCard: confetti + personalized-feeling encouragement, instantly
- Zero dead ends; audio survives iPhone silent switch; runs in Expo Go