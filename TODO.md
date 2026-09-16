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

- [ ] **10.** Apply the `thermo-nuclear-code-quality-review` skill and fix
      everything it finds.
- [ ] **11.** Apply the `improve-codebase-architecture` skill and fix everything
      it finds.
- [ ] **12.** API speed: find and apply every optimisation that does not break
      anything.
- [x] **13.** Checked. **Neither is deleted, and both for a reason.**
      `.scratch` has **7 of 158 tickets genuinely open** — all forecaster, all
      about the unpromoted model (43, 44, 45, 46, 47, 36, 37). `.wayfinder`'s
      nineteen tickets are all `status: closed`, but **nine specs link into it**
      as their provenance — which ticket commissioned each spec — so deleting it
      orphans those links and fails the hygiene suite. It is not leftover
      scaffolding; it is the trail the specs cite. Two stale statuses corrected
      (44 and 45 were built today and still said "not yet").

## Ship and polish

- [ ] **14.** Deploy everything, verify, take screenshots, build a striking
      montage for the README, store it in `.github/images/`.
- [ ] **15.** Review every internal screen and tab as a UI/UX designer would.
- [ ] **16.** `better-ui` skill — apply to the project.
- [ ] **17.** `emil-design-eng` skill — apply to the project.
- [ ] **18.** Final adversarial review: UI/UX, tests, react-doctor, all flawless.

## Standing rules for this run

- No subagents. No mutation testing.
- Tests at the **end of each stage**, not on every change.
- Commit messages in English. `git pull` before every push.
- Do not break anything.
