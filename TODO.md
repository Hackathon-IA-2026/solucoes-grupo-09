# TODO — the eighteen

Status: `[ ]` not started · `[~]` in progress · `[x]` done

## Screens and copy

- [x] **1.** Remove `PROTÓTIPO` from the header — it is a hackathon, so it is implicit.
- [ ] **2.** Promote a model.
- [ ] **3.** Avoid the "Sem previsão para este dia" wall — decide what the screen
      says instead when the gate has passed with nothing published.
- [x] **4.** "Eólica e solar · liquidado, duas medições" shows `Observado` twice.
      Remove the lower one.
- [ ] **5.** The landing's second-section sample card (chance of curtailment and
      the rest) is a good component — find where in the product it belongs and
      use exactly that frontend.
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
- [ ] **13.** Check `.wayfinder` and `.scratch` are fully implemented; if so,
      delete them.

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
