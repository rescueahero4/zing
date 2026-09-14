# Zing — Content Generation Pipeline

Diagrams for the four-stage swarm described in [ARCH.md](ARCH.md) §2. The app is
the orchestrator: it calls each stage over HTTPS in sequence, passes outputs
forward, narrates progress, and enforces one 90s deadline over the whole run
(`PIPELINE_DEADLINE_MS`, `mobile/src/lib/api.ts`).

---

## 1. Flow chart

```mermaid
flowchart TD
    A["Capture<br/><i>photo or PDF + difficulty</i>"] --> B{"Replay cache hit?<br/><i>fingerprint + difficulty</i>"}
    B -->|hit, media still live| CACHE["Narrate 4 agents at 4% cadence<br/>~1s, then play"]
    CACHE --> PLAY

    B -->|miss| DEADLINE["Start 90s AbortController"]

    DEADLINE --> S1

    subgraph S1G ["S1 · /api/extract — Extractor"]
        S1["1 Claude call<br/>1–8 pages: vision and/or PDF document blocks"] --> S1O["topics · problems<br/>grade band · subjects"]
    end

    S1O --> S2

    subgraph S2G ["S2 · /api/research — Researcher swarm"]
        S2["&le;3 parallel Claude calls<br/>web_search on, 1 search each"]
        S2 --> R1["topic 1"]
        S2 --> R2["topic 2"]
        S2 --> R3["topic 3"]
        R1 --> RD{"14s shared<br/>deadline"}
        R2 --> RD
        R3 --> RD
        RD -->|in time| S2O["concepts · misconceptions · fun facts"]
        RD -->|late or failed| DROP["topic omitted<br/><i>Planner works from worksheet alone</i>"]
    end

    S2O --> S3
    DROP --> S3

    subgraph S3G ["S3 · /api/compose — Planner &rarr; Writers &rarr; Encourager"]
        S3["<b>Wave 1</b> Curriculum Planner<br/>3-5 groups, budgets: &le;12 slides,<br/>3-5 questions, &ge;3 widget types"]
        S3 --> TRIM["applySlideBudget<br/><i>shave back-to-front to fit</i>"]
        TRIM --> W["<b>Wave 2</b> one Promise.all"]
        W --> LW["Lesson Writers<br/>1 per group<br/>slides: narration, caption, imagePrompt"]
        W --> QW["Quiz Writers<br/>1 per group<br/>type, prompt, config, answerKey"]
        W --> EN["Encourager<br/>high / mid / low messages"]
        QW --> SCR["order questions:<br/>server scrambles items and<br/><i>derives</i> correctOrder"]
        LW --> ASM["<b>Wave 3</b> assemble<br/>+ Ken Burns cursor"]
        SCR --> ASM
        EN --> ASM
        ASM --> VAL{"Zod BatchSpec<br/>&ge;3 valid groups?"}
    end

    VAL -->|no| FB
    VAL -->|yes| S4

    subgraph S4G ["S4 · /api/assets — fan-out, 4 in flight per pool"]
        S4["mapWithLimit over every slide"]
        S4 --> IMG["fal Flux schnell<br/>720x1280 + STYLE_PREFIX<br/>~2-4s each"]
        S4 --> AUD["ElevenLabs flash v2.5<br/>with-timestamps, 1 voice per batch"]
        IMG --> NSFW{"has_nsfw_concepts?<br/><i>black rect + 200</i>"}
        NSFW -->|yes| RETRY["1 jittered retry, then drop"]
        NSFW -->|no| IMGOK["imageUrl"]
        AUD --> HOST["hostAudio<br/>Blob &rarr; /api/audio/&lt;id&gt; &rarr; data-URI"]
        HOST --> AUDOK["audioUrl + narrationWords"]
        RETRY -.-> IMGOK
    end

    IMGOK --> FILLED["Batch Spec, assets filled"]
    AUDOK --> FILLED
    FILLED --> PRE["Image.prefetch all URLs<br/>+ write replay cache"]
    PRE --> PLAY["BatchPlayer<br/>slides &rarr; quiz &rarr; ScoreCard"]

    S1 -.->|any stage error| FB
    S2 -.->|route throws| FB
    S4 -.->|route throws| FB
    DEADLINE -.->|&gt;90s abort| FB
    FB["Bundled fallback batch<br/><i>spec + media inside the app binary</i>"] --> PLAY

    classDef degrade fill:#3a2a1a,stroke:#c98a3a,color:#f0e6da
    classDef fail fill:#3a1f1f,stroke:#c25555,color:#f7e4e4
    class DROP,RETRY,TRIM degrade
    class FB fail
```

**Reading the dashed edges:** every one of them is a *degrade*, not a crash. The
design rule across all four stages is that a duller batch beats no batch — a
dropped research topic, a trimmed slide, a blanked image and a missing clip all
ship, and only "fewer than 3 valid questions" or the 90s cap sends the child to
the bundled fallback.

---

## 2. Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Kid
    participant App as Expo app<br/>orchestrator
    participant EX as /api/extract
    participant RE as /api/research
    participant CO as /api/compose
    participant AS as /api/assets
    participant CL as Anthropic<br/>Claude
    participant FAL as fal.ai<br/>Flux schnell
    participant EL as ElevenLabs<br/>flash v2.5
    participant BL as Vercel Blob

    Kid->>App: photo of worksheet + difficulty
    App->>App: fingerprint bytes, check replay cache
    Note over App: miss → start 90s AbortController

    rect rgb(28,38,52)
    Note over App,CL: S1 · Extractor — ~8s
    App->>EX: POST {image|pdf, difficulty}
    EX->>CL: 1 call, vision / document block
    CL-->>EX: subjects, topics, problems, gradeBand
    EX-->>App: {extraction}
    end

    rect rgb(28,44,38)
    Note over App,CL: S2 · Researcher swarm — ~14s hard cap
    App->>RE: POST {extraction, difficulty}
    par topic 1
        RE->>CL: web_search, maxSearches 1
        CL-->>RE: concepts, misconceptions, facts
    and topic 2
        RE->>CL: web_search, maxSearches 1
        CL-->>RE: concepts, misconceptions, facts
    and topic 3
        RE->>CL: web_search, maxSearches 1
        CL--xRE: still in flight at 14s → dropped
    end
    RE-->>App: {research: topics that made it}
    end

    rect rgb(42,34,52)
    Note over App,CL: S3 · Planner → Writers → Encourager — ~12s
    App->>CO: POST {extraction, research, difficulty}
    CO->>CL: Planner (sequential — the only blocking call)
    CL-->>CO: 3–5 groups within hard budgets
    CO->>CO: applySlideBudget
    par per group
        CO->>CL: Lesson Writer
        CL-->>CO: slides {narration, caption, imagePrompt}
    and per group
        CO->>CL: Quiz Writer
        CL-->>CO: question {type, config, answerKey}
    and once
        CO->>CL: Encourager
        CL-->>CO: high / mid / low messages
    end
    CO->>CO: scramble `order` items, derive correctOrder
    CO->>CO: Zod-validate BatchSpec, drop broken groups
    alt ≥3 valid groups
        CO-->>App: {batch} — text complete, no media
    else fewer
        CO--xApp: 502 → bundled fallback
    end
    end

    rect rgb(52,38,28)
    Note over App,BL: S4 · Illustrator ‖ Narrator — ~10–15s, 4 in flight per pool
    App->>AS: POST {batch}
    AS->>AS: pickVoiceId() once for the whole batch
    par image pool
        loop each slide, ≤4 concurrent
            AS->>FAL: STYLE_PREFIX + imagePrompt, 720×1280
            FAL-->>AS: url — or black rect + has_nsfw_concepts → 1 retry
        end
    and audio pool
        loop each slide, ≤4 concurrent
            AS->>EL: narration → /with-timestamps
            EL-->>AS: base64 mp3 + char alignment
            AS->>AS: fold chars into narrationWords
            AS->>BL: upload mp3
            BL-->>AS: public URL
        end
    end
    AS-->>App: {batch} with imageUrl / audioUrl / narrationWords
    end

    App->>App: Image.prefetch all slides, write replay cache
    App-->>Kid: "Your batch is ready" → tap to start
    Kid->>App: tap
    Note over App,Kid: slides auto-advance on clip end,<br/>karaoke lights each word, quiz pauses audio
```

---

## 3. Budget at a glance

| Stage | Route | Calls | Budget | Degrade |
|---|---|---|---|---|
| S1 Extractor | `/api/extract` | 1 Claude (vision) | ~8s | none — a failure is fallback |
| S2 Researcher | `/api/research` | ≤3 Claude, parallel, `web_search` | ~14s hard | topic dropped, plan from worksheet |
| S3 Compose | `/api/compose` | 1 + (2 × groups) + 1 Claude | ~12s | trim slides, drop groups, <3 → fallback |
| S4 Assets | `/api/assets` | 2N provider calls, 4 in flight each | ~10–15s | caption-over-gradient · silent slide |
| **Total** | | | **<45s** (90s cap) | bundled fallback batch |
