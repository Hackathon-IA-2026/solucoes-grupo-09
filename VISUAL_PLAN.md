# Ask WattSteer — Visual Briefing

**Status: plan only. Nothing here is built.**

The idea: a spoken question does not return a paragraph. It returns a short,
narrated, animated composition built from WattSteer's own numbers — the system
presenting its own operation rather than a chatbot describing it.

This document is written against the code that exists today, in this repository,
at `bdaceca`. Every claim about what already works is checkable, and the places
where the plan collides with something real are marked **⚠ Collision**.

---

## 0. What already exists

This matters more than the architecture diagram, because roughly half of "Live
UI" is shipped and the plan should not re-describe it as new work.

| Piece | Where | State |
|---|---|---|
| Realtime voice session (WebSocket, PCM16 @ 24 kHz) | `apps/web/src/lib/voice/session.ts`, `audio-codec.ts`, `web-audio-backend.ts` | **Built.** |
| Ephemeral credential mint | `apps/api/src/api/voice.ts` | **Built**, measured live. |
| Six tools the model may call | `apps/web/src/lib/voice/tools.ts` — `show_grid`, `explain`, `mitigate`, `replay`, `focus`, `highlight` | **Built.** |
| Tool → intent resolution | `apps/web/src/lib/voice/execute.ts` → `{ kind: "navigate" \| "params" \| "highlight" \| "refused" }` | **Built.** |
| Intents applied to the live UI | `apps/web/src/components/voice/voice-provider.tsx` — drives `router.push`, `router.setParams`, and a map highlight | **Built.** |
| Per-locale instructions + grounding context | `instructions.ts`, `context.ts` (`contextSentence`, `hasForecast`, `forecastRefusal`) | **Built.** |
| Dock, transcript, action card, orb | `apps/web/src/components/voice/*` | **Built.** |
| Test coverage | 291 tests across 12 files (`apps/web/test/voice-*.test.ts`, `apps/api/test/voice-session.test.ts`, `packages/core/test/client-voice-session.test.ts`, `apps/web/test/features/voice-demo-script.feature`) | **Built.** |

**So "Live UI" is not a new mode.** It is `highlight` + `focus` + navigation,
already wired. What this plan adds is *time*: today a tool call changes the
screen once, instantly. A briefing is a **timed sequence** of such changes,
locked to narration audio.

### Charts that already exist and can become scenes

All are `react-native-svg`, all read the palette, all already carry the
landing-page visual language after this week's parity work:

`subsystem-map` · `fan-chart` · `driver-bars` · `dispatch-chart` ·
`band-figure` (`BandStrip`/`BandFigure`/`BandCard`) · `compare-bars` ·
`reliability-curve` · `risk-class` · `episode-list` · `plan-vs-executed` ·
`technology-split` · `observed-profile`

### Dependencies actually installed

```
react-native-reanimated 4.5.0   ✅ present
react-native-svg        15.15.4 ✅ present
react-native-worklets   0.10.0  ✅ present
@shopify/react-native-skia      ❌ NOT installed
expo-audio                      ❌ NOT installed
expo-video                      ❌ NOT installed
```

**⚠ Collision 1 — Skia.** The proposal names Skia for the visuals. Every chart
in this product is already SVG, they have been tuned for contrast and a11y, and
`test/contrast.test.ts` measures them. Introducing Skia means a *second* renderer
with a second visual language, and on web it ships a CanvasKit WASM payload
(~2.5 MB) that would land on a bundle we have been keeping small for Lighthouse.

**Recommendation: do not add Skia for v1.** Reanimated 4 can animate SVG props,
opacity and transforms, which covers every scene in the storyboard. Revisit Skia
only if a specific scene is proven impossible — and then behind a lazy web
chunk, not in the main bundle.

**⚠ Collision 2 — `expo-audio` as master clock.** Correct instinct, wrong
source here. The narration does **not** arrive as a file to play; it arrives as
**streamed PCM16 frames from the realtime session**, which `web-audio-backend.ts`
already decodes and plays through Web Audio. There is no `expo-audio` sound
object to read `currentTime` from. The master clock must be the **Web Audio
playback clock we already own** (see §4). Adding `expo-audio` would introduce a
second audio path competing for the same output device.

---

## 1. The four modes

| Mode | Trigger | What happens | Build state |
|---|---|---|---|
| **Voice Copilot** | any short question | spoken answer, no scene change | built |
| **Live UI** | question naming a region/day/screen | spoken answer **+** navigate/params/highlight | built |
| **Visual Briefing** | "explique", "por quê", "amanhã", "o que aconteceu", "e se" | 10–30 s narrated, animated sequence | **this plan** |
| **Report** | "exporta", "relatório" | auditable document | later, §11 |

Routing between Live UI and Visual Briefing is decided by **the model**, not by
keyword matching in the client — it already decides which tool to call. The
briefing is simply a seventh tool (§3).

---

## 2. `WattSteerVisualLanguage` — the scene protocol

The model never invents layout. It chooses from a closed set of scene types and
fills their arguments. This is the same discipline `tools.ts` already applies to
navigation, extended to time.

### 2.1 Scene types (v1 — twelve)

Each maps onto a component that already exists, which is the point.

| Scene | Renders with | Arguments |
|---|---|---|
| `title` | new | `headline`, `sub`, `subsystem?` |
| `map_focus` | `subsystem-map` | `subsystem`, `emphasis: "risk" \| "energy"` |
| `forecast_curve` | `fan-chart` | `subsystem`, `window?: {from,to}` (hours) |
| `observed_curve` | `observed-profile` | `subsystem`, `date` |
| `kpi` | `band-figure`/`BandCard` | `label`, `band \| value`, `unit` |
| `comparison` | `compare-bars` | `left`, `right`, `unit` |
| `cause` | `driver-bars` | `subsystem`, `date` |
| `constraint` | new (reuses `driver-bars` geometry) | `reason_codes[]` |
| `counterfactual` | `plan-vs-executed` | `action`, `from`, `to`, `unit` |
| `recommendation` | `Panel` + `Pill` | `text`, `window?`, `cta` |
| `sources` | new | `reads[]` (endpoint + `as_of` + fidelity) |
| `refusal` | `HonestyNote` | `code` |

### 2.2 The plan object

```jsonc
{
  "locale": "pt",
  "narration": "…",              // what is spoken; also the transcript
  "scenes": [
    { "type": "map_focus", "start": 0,    "duration": 3500, "subsystem": "NE", "emphasis": "risk" },
    { "type": "forecast_curve", "start": 3500, "duration": 4500, "subsystem": "NE",
      "window": { "from": "14:00", "to": "17:00" } },
    { "type": "cause", "start": 8000, "duration": 3500, "subsystem": "NE", "date": "2026-09-17" },
    { "type": "counterfactual", "start": 11500, "duration": 4500,
      "action": "battery", "from": 423, "to": 240, "unit": "MW" }
  ],
  "sources": [
    { "read": "GET /v1/grid/outlook", "as_of": "…", "fidelity": "point_in_time" }
  ]
}
```

### 2.3 The rule that makes this safe

> **A scene carries selectors, never figures.**

`counterfactual` above is the single exception and it is a deliberate one, so it
gets a hard rule of its own (§5.3). Every other scene names *what to show* —
subsystem, date, window, driver — and the renderer fetches the number through
the same `ApiClient` the screens use. The model cannot put a wrong megawatt-hour
on screen because it is never given the chance to type one.

**This is not a style preference.** `packages/core` already forbids screens from
computing figures, `test/no-summed-bands.test.ts` guards the arithmetic, and the
whole product's claim is that every number is traceable to a published row. A
briefing that let an LLM speak numbers into a chart would break that claim in
the most visible place in the product.

---

## 3. The seventh tool

`brief` joins the six in `tools.ts`:

```
brief(subsystem?, date?, question_kind: "why" | "tomorrow" | "what_happened" | "what_if")
```

- The model calls it. `execute.ts` gains a `{ kind: "brief"; plan: BriefingPlan }`
  outcome beside the existing four.
- **The plan is composed on the client, not by the model.** `brief` returns a
  *kind*; `lib/voice/briefing/compose.ts` turns that kind plus the current
  `VoiceContextInput` into a scene list. The model decides *that* a briefing is
  owed and about what; a deterministic function decides which scenes exist and
  in what order.
- Why: a composer is testable with `bun test`, produces the same briefing twice
  for the same state, and cannot emit a scene for data that is absent.

**⚠ Collision 3 — the refusal states are the common case.** Today, in
production, no model is promoted: `/app/explain` and `/app/mitigate` render
refusals. `context.ts` already exposes `hasForecast()` and `forecastRefusal()`.
The composer **must** consult them first:

| State | Briefing |
|---|---|
| forecast available | full sequence |
| `observedOnly` | observed scenes only — `observed_curve`, `cause` (observed reasons), `sources`. No `forecast_curve`, no `counterfactual`. |
| refused | a single `refusal` scene, spoken plainly |

A briefing that animates a forecast the product does not have is the worst
possible bug in this feature. It gets its own test file (§8).

---

## 4. The clock

The hardest part, and the part the original sketch gets wrong for this codebase.

- Narration audio arrives as **streamed PCM16 frames** over the realtime session.
- `web-audio-backend.ts` already schedules them into Web Audio.
- **Master clock = the Web Audio output position**, exposed as a new
  `playedSeconds()` on the backend (frames scheduled × samples ÷ 24 000, minus
  what has not yet played).

`BriefingDirector` subscribes to that clock and derives the active scene. It does
**not** run its own `setInterval` timeline, because audio and timers drift apart
and a chart that moves ahead of the sentence describing it is worse than no
animation.

Three cases that must be handled explicitly, all of which happen:

1. **Barge-in.** The user speaks over the briefing. The session already cancels
   the response; the director must abort at the current scene and leave the UI
   on that scene rather than snapping back.
2. **Audio blocked.** Autoplay policy can refuse the context. The director then
   runs the sequence on a wall clock **and** shows the narration as text — the
   briefing must be fully legible with no sound at all.
3. **Narration shorter or longer than the plan.** Scenes are *proportional*: if
   audio ends early, the remaining scenes are compressed to a floor of 1200 ms
   each; if it runs long, the last scene holds.

---

## 5. Rendering

### 5.1 Where it lives

A `BriefingStage` overlays the current screen — the app dims behind it rather
than navigating away, so the reader keeps their place and can dismiss back into
exactly the screen they were on. It mounts inside `VoiceProvider`, which already
owns the dock and the highlight.

### 5.2 Animation

Reanimated 4, already installed. Per scene: enter (opacity + 8 px rise, 240 ms),
hold, exit (opacity, 180 ms). Numbers count up with `withTiming` on a shared
value. The map's focus is an SVG `viewBox` interpolation — no new renderer.

**`useReducedMotion` is already respected across this codebase** (`risk-bar`, the
map, the orb). Under reduced motion the briefing does not animate: scenes
cut, counters land on their final value, and the sequence still advances with
the narration.

### 5.3 The one scene allowed to carry numbers

`counterfactual` shows "423 → 240 MW". Those come from an optimizer run, not from
the model. Rule: the composer **must** have an `OptimizationResult` in hand before
emitting this scene, and it copies `baseline_curtailment_mwh` and
`optimized_curtailment_mwh` off that object. If there is no result, the scene is
not emitted. No exceptions, and a test asserts the scene cannot be constructed
without its source object.

---

## 6. Sources scene

Non-negotiable for this product. The last scene lists every read that fed the
briefing, with its `as_of` and `vintage_fidelity` — the same vocabulary
`ForecastStamp`, `ObservedBadge` and `VintageBadge` already use. A briefing is a
claim; the product's rule is that a claim says where it came from.

---

## 7. File plan

```
apps/web/src/lib/voice/briefing/
  types.ts        Scene union, BriefingPlan. No behaviour.
  compose.ts      VoiceContextInput + question_kind -> BriefingPlan
  clock.ts        Web Audio position -> active scene index
apps/web/src/components/briefing/
  briefing-stage.tsx      overlay, dim, dismiss, reduced-motion
  scene-renderer.tsx      Scene -> component
  scenes/*.tsx            one per type, each wrapping an existing chart
```

Touched, not created: `tools.ts` (+1 tool), `execute.ts` (+1 outcome),
`voice-provider.tsx` (hold the active plan), `instructions.ts` (when to brief),
`web-audio-backend.ts` (+`playedSeconds`), `i18n/copy.*.ts` (scene chrome).

---

## 8. Tests

Matching how this repo already tests voice (291 tests, no mocking of the thing
under test):

| File | Asserts |
|---|---|
| `test/briefing-compose.test.ts` | one plan per state; **observedOnly never yields `forecast_curve` or `counterfactual`**; refused yields exactly one `refusal` scene |
| `test/briefing-clock.test.ts` | scene selection at boundaries; compression floor; hold-last |
| `test/briefing-numbers.test.ts` | `counterfactual` cannot be built without an `OptimizationResult` |
| `test/briefing-i18n.test.ts` | every scene's chrome exists in both locales — the rule `i18n.test.ts` already enforces |
| `e2e/briefing.spec.ts` | stage appears, scenes advance, dismiss returns to the same screen, **no horizontal overflow at 320/360/400 px** (the sweep that just caught nine real bugs) |
| `test/features/visual-briefing.feature` | the gherkin narrative, beside `voice-demo-script.feature` |

---

## 9. Order of work

1. `types.ts` + `compose.ts` + their tests. **No UI.** The composer is the safety
   boundary; it should be provably correct before anything is drawn.
2. `playedSeconds` on the audio backend + `clock.ts` + tests.
3. `BriefingStage` with two scenes only (`title`, `map_focus`) end to end.
4. Remaining scenes, one per commit, each wrapping an existing chart.
5. `brief` tool + instructions; the model can trigger it.
6. e2e + gherkin + the overflow sweep.

Each step ends with `bun run check` green. Step 3 is the first one worth looking
at on screen.

---

## 10. Honest risks

- **It can be slow.** Composing may need an optimizer call; `/v1/optimize` is not
  instant. The stage should open on `title` immediately and stream later scenes
  in, never hold a blank overlay.
- **It can feel like a toy.** The defence is that every scene is a real product
  panel with real numbers, and the sources scene at the end. If a scene cannot
  be traced to a read, it should not exist.
- **It is a lot of surface for a feature nobody asked for yet.** The staged order
  above means steps 1–2 are useful even if the visual work is dropped: a tested,
  deterministic briefing composer is also what the Report mode (§11) needs.

---

## 11. Later: Report and Export as video

Both consume the **same `BriefingPlan`**, which is the reason the plan object is
worth defining carefully now:

- **Report** — render the plan to a document with the sources table. No new model
  work.
- **Export as video** — Remotion server-side, rendering the same scenes. Remotion
  is React and the scenes are React, but they are *react-native-svg* React, so
  this needs a web-only rendering path. Not v1, and not free.
