# TODO — the eighteen

Status: `[ ]` not started · `[~]` in progress · `[x]` done

## Screens and copy

- [x] **1.** Remove `PROTÓTIPO` from the header — it is a hackathon, so it is implicit.
- [ ] **2.** Promote a model.
- [x] **3.** Avoid the "Sem previsão para este dia" wall — decide what the screen
      says instead when the gate has passed with nothing published.
- [x] **4.** "Eólica e solar · liquidado, duas medições" shows `Observado` twice.
      Remove the lower one.
- [x] **5.** The landing's second-section sample card (chance of curtailment and
      the rest) is a good component — find where in the product it belongs and
      use exactly that frontend. → The Overview now opens with a national panel
      on both halves, reading `national` off `GET /v1/grid/outlook` and
      `GET /v1/grid/now`; `ExpectationFigure` joins the product's charts.
- [x] **6.** "O que o WattSteer não vai afirmar" moves outside its card, with
      correct spacing.
- [x] **7.** The "Nenhuma manutenção de transmissão é lida" paragraph is
      left-aligned.
- [x] **8.** Replace the "Lendo a rede —…" loading text with a proper animated
      loader: `thinking-orbs-native` (+ Skia, Reanimated) or a very light
      skeleton. Perfect the UI/UX around it.
- [x] **9.** "Episódios recentes" is a wall of times — make it a decent table.

## Quality passes

- [x] **10.** Applied `thermo-nuclear-code-quality-review` — you pasted the skill
      text, which unblocked it. Findings fixed; the systemic one became ADR-0001.
- [x] **11.** Applied `improve-codebase-architecture` — same route. Four of the
      five candidates shipped; the fifth was **rejected on reading the callers**:
      one `mlRead()` adapter would have merged `model-card.ts`, which refuses,
      with `meta.ts`, which never throws. Opposite policies, both deliberate.
      `json/shape.ts` is the smaller thing that was actually shared.
- [x] **12.** API speed. `GET /v1/grid/now` — the Overview's first call —
      8,400–9,700ms → 420–486ms at origin, ~20×, via the canonical settled-hour
      read (`0051_the_latest_settled_hour_is_a_read.sql`). Cloudflare's 60s cache
      had been masking it.
- [x] **13.** Checked. **Neither is deleted, and both for a reason.**
      `.scratch` has **7 of 158 tickets genuinely open** — all forecaster, all
      about the unpromoted model (43, 44, 45, 46, 47, 36, 37). `.wayfinder`'s
      nineteen tickets are all `status: closed`, but **nine specs link into it**
      as their provenance — which ticket commissioned each spec — so deleting it
      orphans those links and fails the hygiene suite. It is not leftover
      scaffolding; it is the trail the specs cite. Two stale statuses corrected
      (44 and 45 were built today and still said "not yet").

## Ship and polish

- [~] **14.** Screenshots and montage **done** — `.github/images/wattsteer.png`,
      four retina captures of a real build reading the live gateway, composed
      into one 1800×1097 frame and placed at the top of the README. Deploy
      is the half that is left, and it is yours to authorise: everything is
      committed on `clauge/development-gridflex-7e0ba196` and I will pull,
      push and verify on your word.
- [x] **15.** Reviewed all four `/app` screens at 1440 and 412, against the real
      gateway. Three defects, all one species — a rule the product states
      clearly, applied unevenly:
      · `845eace` the header reflowed 42px at ~4s; `/app` CLS 0.215 → 0.
      · `db730af` the D−1 run pills were live and inert with no model promoted.
      · `8f159a5` + `89ab9c5` three of four ledes promised panels that were not
        there. ADR-0008 records it, because the Overview had already written the
        argument down and nobody had read it from the other three screens.
- [ ] **16.** `better-ui` skill — apply to the project.
      ⛔ **Blocked on you.** No skill by that name exists publicly: not in
      `~/.claude/skills/`, not in `.claude/skills/`, and not found by GitHub
      repo/code search or the skill registries. Send me the URL and I will
      fetch and run it the same way `emil-design-eng` was run.
- [x] **17.** `emil-design-eng` — fetched from `emilkowalski/skills` on GitHub
      and run without installing, as you asked. Most of its checklist already
      passed: no `transition: all`, no `ease-in`, nothing over 300ms. One real
      gap — **no easing curve anywhere**, so every transition ran on the CSS
      default. `95f14ec` adds `motion.ease`, routes the five hand-written call
      sites through `webTransition`, and names the one deliberate suppression.
- [ ] **18.** Final adversarial review: UI/UX, tests, react-doctor, all flawless.

## Standing rules for this run

- No subagents. No mutation testing.
- Tests at the **end of each stage**, not on every change.
- Commit messages in English. `git pull` before every push.
- Do not break anything.
