# WattSteer Voice — the grid, spoken to

**Status:** plan only. Nothing here is built. Every file path below is a file to
*create*; every existing file named is one to *read* before touching.

> You don't talk to a chatbot about the grid. You talk to the grid **through**
> WattSteer.

That sentence is the whole design constraint, and it rules out the obvious
build. Voice is not a screen, not a drawer item, not a chat log with a
microphone on it. It is a **second input device for the four screens the product
already has** — one that can do things a mouse cannot: change three parameters
and a route in a single sentence, and say *why* while it does.

---

## 0. Why this fits WattSteer specifically

Most "add voice to the dashboard" projects fail at the same place: the assistant
can talk about the app but cannot *drive* it, because the app's state lives in
twelve React providers the model has no handle on.

**WattSteer does not have that problem, and it is worth being precise about
why.** `apps/web/src/components/app/params.ts` opens with the decision:

> The product is **public, read-only, with no accounts**. The URL is the only
> place cross-screen state can live that survives a reload or a paste into
> Slack. […] The four screens are four views of **one selection**.

So the entire user-visible state of the product is:

| | | |
|---|---|---|
| route | `/app`, `/app/explain`, `/app/mitigate`, `/app/replay` | which of the four modes |
| `subsystem` | `N` `NE` `SE` `S` | which region |
| `technology` | `wind` `solar` | which fleet |
| `run` | `00Z` `12Z` | which gate's weather run |
| `episode` | a replay day id | Time Machine's own |
| `scenario` | URL-encoded assets | Mitigate's battery and shiftable load |

Every one of those is a query parameter, parsed by one pure function
(`parseAppParams`) and written by one call (`router.setParams`). The scenario
has its own codec — `writeScenario` / `readScenario` in `scenario.ts` — with
`withBattery`, `withLoad`, `withBrlPerMwh`, `withSubsystem`, `withTargetDate`
already written as pure transforms.

**That means the voice agent's entire action surface is already built, tested,
and URL-addressable.** The agent does not need to reach into the app. It needs
to compute a URL. And because it computes a URL, every single thing the voice
agent does is:

- **shareable** — the state it navigated you to is a link you can paste
- **undoable** — browser Back reverses it
- **inspectable** — you can see in the address bar exactly what it did
- **testable without audio** — the tool layer is a pure function from a tool
  call to a URL, so the whole agent's behaviour is unit-testable with no
  microphone, no socket and no API key

That last point is what makes this shippable rather than a demo. Write that
down now, because it is the property every decision below protects.

---

## 1. What we take from `EvanBacon/grok-voice-demo`

Cloned and read at `scratchpad/grok-voice-demo`. It is ~720 lines of substance
across four files, and the split is genuinely good: **transport and protocol are
platform-agnostic; audio I/O is a swappable backend.**

### 1.1 Take almost verbatim

`src/utils/grok-voice-core.ts` (314 lines) — this is the asset. It contains:

| piece | what it is | our verdict |
|---|---|---|
| `GrokVoiceCore` class | socket lifecycle + realtime event switch | **take, then extend with tools** |
| `AudioBackend` interface | `openSocket` / `startCapture` / `playChunk` / `teardown` | **take as-is** — the seam is right |
| `levelFromFloat` | RMS → 0..1 display level | **take as-is** — drives our waveform |
| `resampleLinear` | mono resampler | take (unused on web, needed if we ever do native) |
| `bytesToBase64` / `base64ToBytes` | pure-JS base64, no `atob` | **take as-is** — Hermes-safe, and our RNW build should not assume DOM globals |
| `encodePCM16Base64` / `decodePCM16Base64` | Float32 ↔ PCM16 | **take as-is** |
| `VoiceStatus` union | `idle`/`connecting`/`listening`/`speaking`/`error` | **take, and add `thinking` and `acting`** — see §3.2 |

`src/utils/grok-voice.ts` (129 lines) — the web `AudioBackend`. Take nearly
whole: `getUserMedia` with `echoCancellation`, an inlined `AudioWorklet` blob
for capture, `AudioContext` scheduling for playback with a `playCursor` so
chunks queue without gaps, and the subprotocol auth trick:

```ts
new WebSocket(REALTIME_URL, [`xai-client-secret.${clientSecret}`])
```

> Browsers can't set Authorization headers on a WebSocket, so the ephemeral
> token is passed via the subprotocol with xAI's prefix.

`src/app/api/voice-session+api.ts` (78 lines) — the ephemeral-token minter. The
*shape* is right and the security reasoning is right: the browser never sees
`XAI_API_KEY`; it gets a 300-second client secret. **But we do not take the file**
— see §2.1, it belongs in `apps/api`, not in the Expo app.

### 1.2 Take the idea, rewrite the code

`src/utils/grok-voice.native.ts` — iOS/Android audio. **Defer entirely.**
WattSteer ships as a static web export; there is no native build. Keep the
`AudioBackend` seam so this stays possible, and write no native file.

The demo's UI — `drawer-layout.tsx`, `sidebar.tsx`, `main-header.*.tsx`,
`touchable-glass.tsx`, `blur-raw.tsx`, `symbol-image.tsx` — is a **ChatGPT-style
app shell**: a drawer, a chat list, a model picker, a settings stack. That is
exactly the product shape this plan rejects. It also uses Uniwind/Tailwind
(`src/components/tw.tsx`, `uniwind-types.d.ts`) and SF Symbols, neither of which
exists here.

**Take zero UI files.** Every pixel is ours, built on `@wattsteer/ui` tokens.

### 1.3 The gap the demo does not fill

**The demo has no tool calling.** Its `handleMessage` switch handles audio
deltas, transcripts and errors — and nothing else. It is a talking head: it can
answer, it cannot *act*.

Everything that makes this plan interesting lives in that gap. §3 is about
closing it.

---

## 2. Architecture

```
  ┌────────────────────────── browser ───────────────────────────┐
  │                                                              │
  │  VoiceDock (UI, 3 sizes)                                      │
  │       │                                                       │
  │       ├── useVoiceAgent()        ← React binding, one hook    │
  │       │        │                                              │
  │       │        ├── WattSteerVoiceSession extends GrokVoiceCore│
  │       │        │        │                                     │
  │       │        │        ├── WebAudioBackend  (mic + speaker)  │
  │       │        │        └── ws → api.x.ai/v1/realtime         │
  │       │        │                                              │
  │       │        └── executeTool()  ← PURE. call → intent       │
  │       │                 │                                     │
  │       └─────────────────┴──→ router.setParams / router.navigate│
  │                                                              │
  │  ...the four screens, unchanged, re-rendering off the URL     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ GET /v1/voice/session
                  ┌───────────────▼────────────────┐
                  │ apps/api  (holds XAI_API_KEY)  │
                  │  → POST api.x.ai/v1/realtime/  │
                  │         client_secrets         │
                  └────────────────────────────────┘
```

### 2.1 The token endpoint belongs in `apps/api`

The demo puts it in an Expo API route. **We cannot**: `apps/web` is a static
export served by a file server — there is no server-side runtime in it at all.
There is exactly one service that holds secrets and talks to the browser, and
`docs/specs/api-surface.md` is the register of what it exposes.

**New route: `GET /v1/voice/session`.** It must be added to the api-surface
table as row 19 (and both "eighteen" count sentences updated to "nineteen" — the
spec has a test that counts them).

```
GET /v1/voice/session
  → 200 { client_secret, expires_at, model, voice }
  → 503 VOICE_UNAVAILABLE   — no XAI_API_KEY configured on this instance
  → 429 RATE_LIMITED        — the gateway's existing limiter
```

Non-negotiables on it, and each is a guard to write:

1. **The long-lived key never leaves the server.** A test asserts
   `XAI_API_KEY` appears in no response body and in no log line — the same
   shape as `redactedRedisError()`, which exists because ioredis leaked a
   password into a log once already.
2. **Rate limited harder than the read endpoints.** A voice session is an
   expensive external call. `WATTSTEER_VOICE_RATE_LIMIT`, its own bucket,
   defaulting well below `WATTSTEER_RATE_LIMIT`.
3. **Expiry is echoed, not assumed.** The client shows a session's remaining
   life and re-mints before it lapses rather than dying mid-sentence.
4. **Absent key is a refusal, not a crash.** With no `XAI_API_KEY` the route
   returns `VOICE_UNAVAILABLE` and the dock does not render at all. A deploy
   without the key must look like a product without voice, not a broken one.

`VOICE_UNAVAILABLE` joins the closed `ErrorCode` enum in `packages/core`,
which means it needs `copy.error.VOICE_UNAVAILABLE` in **both** locales — there
is a test asserting every code has copy in both.

### 2.2 Files to create

```
apps/api/src/api/voice.ts                     the route + the xAI call
apps/api/test/voice-session.test.ts           key never leaks; refusal path

packages/core/src/errors.ts                   += VOICE_UNAVAILABLE   (edit)
packages/core/schema/*.json                    += the session shape  (edit)

apps/web/src/lib/voice/grok-voice-core.ts     ← vendored from the demo, + tools
apps/web/src/lib/voice/web-audio-backend.ts   ← vendored from the demo
apps/web/src/lib/voice/tools.ts               THE TOOL SCHEMA — pure
apps/web/src/lib/voice/execute.ts             tool call → NavigationIntent — pure
apps/web/src/lib/voice/instructions.ts        the system prompt, per locale
apps/web/src/lib/voice/context.ts             URL state → a sentence for the model

apps/web/src/components/voice/use-voice-agent.ts    the one React binding
apps/web/src/components/voice/voice-dock.tsx        the 3-size container
apps/web/src/components/voice/voice-orb.tsx         the waveform/orb
apps/web/src/components/voice/voice-transcript.tsx  expanded view
apps/web/src/components/voice/voice-action-card.tsx "↗ Abri Explicar para você"
apps/web/src/components/voice/voice-trigger.tsx     the header button

apps/web/test/voice-tools.test.ts             every tool → intent, exhaustively
apps/web/test/voice-context.test.ts           the context sentence
apps/web/test/voice-dock.test.ts              the three sizes, i18n, a11y
```

**`tools.ts` and `execute.ts` contain no React, no audio, and no network.** That
is deliberate and it is the single most important structural decision in this
document: it makes the agent's entire behaviour testable as arithmetic.

---

## 3. The part the demo does not have: tools

### 3.1 The tool set

Six tools. Not thirty — a small, sharp set the model can hold in its head, each
mapping onto state the app already has. Sent in `session.update` alongside the
voice and instructions the demo already sends.

```ts
// apps/web/src/lib/voice/tools.ts

show_grid          {}                                  → /app
explain            { subsystem?, driver? }              → /app/explain
mitigate           { subsystem?, battery_mwh?,
                     battery_mw?, load_mwh? }           → /app/mitigate
replay             { episode? | relative_day? }         → /app/replay
focus              { subsystem?, technology?, run? }    → setParams, no route change
highlight          { subsystem }                        → transient emphasis, no navigation
```

`highlight` is the one that makes the demo sing. *"Qual região devo me
preocupar mais amanhã?"* should **not** navigate. It should stay on Visão da
rede, light the NE on the map, and speak the band. The map's hover highlight is
already lifted to the overview for exactly this reason — see the comment in
`subsystem-map.tsx`:

> Lifted because the highlight has two ends: hovering a region lights its row
> and hovering a row lights its region.

There is now a third end: **the agent lights both.** That is a one-line change
to who can call `setHovered`, and no new highlight mechanism at all.

### 3.2 Two new statuses

The demo's `VoiceStatus` is `idle | connecting | listening | speaking | error`.
We add:

- **`thinking`** — response started, no audio yet. Without it the orb sits on
  "listening" through the model's latency and the UI feels dead at the exact
  moment the user is waiting hardest.
- **`acting`** — a tool call is executing. This is the state where the dock
  shows *"↗ Abrindo Explicar"* while the screen behind it changes. Naming it as
  a status is what stops the navigation feeling like a glitch.

### 3.3 Execution is a pure function

```ts
// apps/web/src/lib/voice/execute.ts
export type NavigationIntent =
  | { kind: "navigate"; pathname: string; params: Record<string, string> }
  | { kind: "params";   params: Record<string, string> }
  | { kind: "highlight"; subsystem: SubsystemCode | null }
  | { kind: "refused";  reason: ToolRefusal };

export function executeTool(call: ToolCall, current: AppParams): NavigationIntent
```

No `router` import. No hooks. The hook calls it and *then* performs the intent.
So `voice-tools.test.ts` can assert the full behaviour of the agent — every
tool, every argument shape, every refusal — with no audio stack in the room.

**Validation is refusal, not coercion.** A model that hallucinates
`subsystem: "SUDESTE"` must get `{ kind: "refused" }` and a spoken "não conheço
esse subsistema", never a silent default to `NE`. The parsing rules are already
written and already defensive — `parseAppParams` falls back rather than
crashing — but a *fallback* is right for a hand-edited URL and wrong for a tool
call, where silently answering about the wrong region is the worst outcome in
the product. Different callers, different rule, and the test says so.

**Scenario changes go through `withBattery` / `withLoad` / `withBrlPerMwh`.**
The agent must not construct a scenario string. Those transforms exist, they are
tested, and `writeScenario` is the only encoder. *"E se eu tivesse uma bateria de
500 MWh?"* becomes `withBattery(current, { energyMwh: 500, ... })` and the
existing codec does the rest.

### 3.4 The model must be told what the user is looking at

Before each turn, push a compact context sentence via `session.update`:

```
The reader is on Explicar, looking at NE · Eólica · run 12Z · target 2026-09-16.
Risk: high. P10 120 MWh / P50 480 MWh / P90 1,900 MWh. Top driver: interchange limit.
No model is promoted, so no forecast figures are available for this day.
```

`context.ts` builds that from the same hooks the screens use (`use-network`,
`use-explain`, `use-serving`). It is a pure function of already-fetched state —
it must not issue a request of its own, or the agent's context and the screen's
numbers could disagree.

**That last line is not optional.** Nothing is promoted right now; the forecast
endpoints refuse. An agent that cheerfully invents a P50 during a demo is worse
than no agent. The context sentence carries the absence, and the instructions
(§4) make refusing the only allowed response to it.

---

## 4. Instructions — the honesty contract

`instructions.ts`, one per locale, and this is where WattSteer's existing
discipline has to survive contact with a language model.

The repo's rule everywhere else is: **a number is published with the thing that
makes it interpretable, or it is not published.** The gate refuses artifacts
rather than shipping a band it cannot stand behind. `MARGINAL_COVERAGE_NOT_RUN_YET`
travels with every withheld claim. A voice that rounds all that off into a
confident sentence would undo it in one demo.

Non-negotiable instruction clauses:

1. **Never state a figure not in the context block.** No estimating, no "roughly",
   no recalling. If it is not in context, the answer is that it is not available.
2. **A band is three numbers.** Never speak a P50 alone. "Entre 120 e 1.900 MWh,
   com 480 no centro" — that is the product's promise, spoken.
3. **Never say "the model predicts" while nothing is promoted.** Say the gate
   refused and why, in the reader's language. The gate refusing is the gate
   *working*, and the voice should sound like someone who knows that.
4. **Short.** These are spoken aloud. Two sentences, then offer to show.
5. **Answer in the reader's locale** — `copy` already knows which, and the voice
   picks from it rather than detecting from audio.
6. **Prefer showing over describing.** Ambiguity resolves to a tool call, not a
   clarifying question. "Qual região?" is a worse demo and a worse product than
   opening the overview with all four visible.

---

## 5. The interface

Three sizes, exactly as sketched. Bottom-right, `position: fixed`, above the
content, never over the primary reading column at desktop width. The dashboard
stays visible behind it — that is the entire point.

### IDLE
```
                    ╭──────────────────────────────╮
                    │ ◉  Pergunte ao WattSteer  🎙 │
                    ╰──────────────────────────────╯
```
A pill. `colors.accent` hairline on `surfaceSunken`, the lime the product
already uses. Not a floating circle — a floating circle says "chat bubble", and
we are not a chat bubble.

### ACTIVE — listening
```
                    ╭──────────────────────────────╮
                    │ ))) Ouvindo você…         ✕ │
                    ╰──────────────────────────────╯
```

### ACTIVE — speaking / acting
```
                    ╭──────────────────────────────╮
                    │ 🔊 Explicando previsão…      │
                    ╰──────────────────────────────╯
```

### EXPANDED — 400px
```
╭────────────────────────────────────────╮
│ ◉ WATTSTEER AI                    ─  ✕ │
│                                        │
│              ))) ◉ (((                 │
│                                        │
│ "Por que o Nordeste está com risco     │
│  tão alto amanhã?"                     │
│                                        │
│ 🔊 Excesso de geração eólica com       │
│    restrição de intercâmbio. Entre     │
│    120 e 1.900 MWh, 480 no centro.     │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ ↗  Abri Explicar para você         │ │
│ │    NE · Eólica · 12Z               │ │
│ └────────────────────────────────────┘ │
│                                        │
│ 🎙 Mudo   ⌨ Digitar            ─   ✕ │
╰────────────────────────────────────────╯
```

The action card is the load-bearing element. It is what makes an automatic
navigation feel like **the assistant did something for you** rather than the app
jumping. It states what changed and stays there after the speech ends, so a
reader who looked away can see what happened. Tapping it re-navigates; it is
also the undo affordance's anchor.

### 5.1 The futuristic part, done with restraint

The brief asks for futuristic. The trap is chrome that fights the data — this is
a grid operations product, and a reader deciding about tomorrow's curtailment is
not served by glow.

So: **the futurism is in the motion and the responsiveness, not in the
decoration.**

- **The orb is the live audio level.** `levelFromFloat` already gives a 0..1
  value per frame, mic while listening and playback while speaking. Drive a ring
  of bars — the same lime as the risk glyphs on the map — off the real signal.
  It reacts to *your actual voice*, and that reads as alive in a way no looping
  animation does.
- **Distinct signatures per status.** Listening breathes outward and tracks the
  mic. Thinking is a slow sweep with no level input. Speaking tracks playback.
  Acting is a directional pulse toward the screen edge the navigation is heading
  to. Four states, four legible motions, zero text needed to tell them apart.
- **The navigation itself is the effect.** When the agent opens Explicar, the
  route transition *is* the animation: the dock's action card slides in as the
  screen changes. Nothing extra.
- **The map lights up when spoken about.** Already possible — §3.1. A region
  glowing as the voice names it is the single most convincing moment available
  in this product, and it costs almost nothing.
- **`useReducedMotion` is honoured throughout.** Every animation above degrades
  to a state change. The repo already threads this hook through the map and the
  landing; voice does not get an exemption.

No glassmorphism, no particles, no gradient mesh. The product's existing
restraint *is* its aesthetic, and a voice panel that breaks it would look
bolted on.

### 5.2 Where the trigger lives

Header, right of `PT / EN`, as sketched:

```
WattSteer     Visão  Explicar  Mitigar  Máquina do tempo      PT EN   ◉ Falar
```

Full label, not a bare microphone — discoverability matters for a demo and a
lone icon reads as decoration. On narrow screens it collapses to the icon and
the dock's idle pill carries the label instead.

**It is not a nav item and there is no route for it.** The brief is right and
the reason is structural: a `/voice` route would put voice *beside* the four
modes, when its whole value is sitting *across* them. Adding it to the tab row
would also break `sharedParams`, which is built on the four screens being four
views of one selection.

---

## 6. The demo script, as an acceptance test

This sequence is what gets built toward, and each step is a test in
`voice-tools.test.ts` driven by a recorded tool call — no audio needed.

| # | said | tool | result |
|---|---|---|---|
| 1 | "Qual região devo me preocupar mais amanhã?" | `highlight{NE}` | **stays** on Visão da rede; NE lights on map *and* row; speaks the band |
| 2 | "Por quê?" | `explain{NE}` | → Explicar, NE carried, top driver named |
| 3 | "O que eu poderia fazer?" | `mitigate{NE}` | → Mitigar, NE and date carried |
| 4 | "E se eu tivesse uma bateria de 500 MWh?" | `mitigate{battery_mwh:500}` | `withBattery` → URL → the solver re-runs |
| 5 | "Isso teria funcionado na semana passada?" | `replay{relative_day:-7}` | → Máquina do tempo at that date |
| 6 | "Volta pra visão geral" | `show_grid{}` | → Visão da rede, selection intact |

**Step 4 is the one to demo.** The URL changes, the MILP re-solves on the
server, and a real optimisation result comes back — because the scenario codec
and the solver are already there and the agent just wrote a query parameter.

**Step 1 is the one that proves the thesis.** It is the step where the assistant
*does not navigate*, and a lesser design would have opened a chat panel with a
paragraph in it.

---

## 7. Phasing

| phase | what | demo-ready after |
|---|---|---|
| **1** | `GET /v1/voice/session`, `VOICE_UNAVAILABLE`, key-leak guards | — |
| **2** | vendor core + web backend; `useVoiceAgent`; dock at IDLE/ACTIVE; talk and be answered, no tools | first voice |
| **3** | `tools.ts` + `execute.ts` + tests; `focus`, `show_grid`, `explain` | **the thesis is provable** |
| **4** | `context.ts` + instructions; honest refusal while nothing is promoted | safe in front of an audience |
| **5** | `highlight` into the map; action card; EXPANDED transcript | the moment that sells it |
| **6** | `mitigate` with scenario writes; `replay` with relative days | steps 4–5 of the script |
| **7** | orb motion per status, reduced-motion paths, keyboard, mobile | ship |

Phases 1–4 are the product. 5–7 are what make it land in a room.

---

## 8. Risks, named rather than discovered live

| risk | mitigation |
|---|---|
| **Nothing is promoted; the agent has no forecast to speak about** | §3.4 and §4.3 — the absence is in the context and refusing is instructed. The demo works on observed history and the gate's own reasoning, which is real content. |
| **A hallucinated parameter sends the reader to the wrong region** | §3.3 — refuse, never coerce. The single highest-stakes rule here. |
| **`XAI_API_KEY` leaks** | §2.1 — ephemeral tokens only, key stays in `apps/api`, a guard asserts it never appears in a body or a log. |
| **Cost / abuse on a public unauthenticated product** | Its own rate-limit bucket, short expiry, and a hard session cap. This is a **public** product with no accounts — anyone who can load the page can mint a session. Decide the cap before phase 1 ships. |
| **Mic permission denied** | An explicit state in the dock with the ⌨ typed fallback, not an error toast. |
| **Safari `AudioWorklet` / autoplay** | Backend is a seam; a `ScriptProcessorNode` fallback fits behind it. Must be tested in Safari specifically — our other browser bugs this week were all Safari-adjacent. |
| **The voice talks over the reader** | `enable_echo_detection_filtering` is already in the demo's `session.update`, plus `server_vad`. Take both. |
| **Grok voice API changes** | The vendored core is ours the moment we copy it. Pin the model string in one constant; the demo already does. |

---

## 9. What this plan deliberately does not do

- **No chat history, no threads, no model picker.** The demo has all three; they
  belong to a chat product. Voice here is stateless across sessions by design —
  the state is the URL.
- **No native build.** The `AudioBackend` seam keeps it open; no native file gets
  written.
- **No voice on the landing page.** The copilot operates on the four modes. A
  microphone on the marketing page is a gimmick with nothing behind it.
- **No writes.** Every tool is a navigation or a scenario parameter. The agent
  cannot promote a model, trigger a retrain, or change anything on the server.
  The product is read-only and the voice does not get a wider hand than the
  mouse has.
