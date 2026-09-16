# TODO — the eighteen

Status: `[ ]` not started · `[~]` in progress · `[x]` done

## Screens and copy

- [x] **1.** Remove `PROTÓTIPO` from the header — it is a hackathon, so it is implicit.
- [ ] **2.** Promote a model.
      ⛔ **I will not promote these. The floor is genuinely missed more often
      than the band claims**, and derived from the gate's own numbers rather
      than argued:

      `mean(p)` on the rows that state a floor is `coverage + |excess|` —
      **0.9723** on `gate_late`, **0.9923** on `gate_early`. A correctly
      calibrated band, conditioned on curtailed hours, covers `0.90 / p`:

      | | correct band | observed | shortfall |
      |---|---|---|---|
      | `gate_late` | 0.9256 | 0.8114 | **11.4 pts** |
      | `gate_early` | 0.9070 | 0.8477 | **5.9 pts** |

      Promoting either puts a floor in front of an operator that is breached
      about one hour in six while implying one in thirteen. On a product whose
      entire claim is honest uncertainty, that is the one number that must not
      be optimistic — a floor that is too high understates how bad a bad hour
      gets, which is the direction that costs money.

      **A claim of mine, withdrawn.** I wrote that the rail is mis-centred —
      that a correct band reads `0.90/p − p` rather than `0`, and therefore
      fails on both lanes. That derivation assumes the band is **continuous at
      the P10**, and this mixture is not: `MagnitudeQuantiles` is flat below its
      first knot, so probability mass sits *exactly at* the served P10. With an
      atom there, `P(Y ≥ P10) = p` is what the rail's own comment claims and
      forecaster 34 measured, and zero is the right centre. I do not have the
      data locally to settle which regime these rows are in, and a rail that
      decides promotions is not something to re-centre on a derivation I am not
      sure of — particularly not on the day I already took the site down by
      moving fast.

      **It does not change the conclusion.** Stated-floor coverage is 0.8114
      and 0.8477 against a band that claims 0.90. That is below 0.90 under
      either reading, so the under-coverage is real and promotion is still
      wrong.

      **The work, in order:**

      1. **Settle the rail's centre with data, not algebra.** Measure
         `P(Y ≥ P10)` on the qualifying rows directly: if the atom at the P10
         holds, zero is right and the rail stands. Needs the production
         dataset.
      2. **Find where the shortfall concentrates before choosing a remedy.**
         I started implementing Mondrian conformal stratified by subsystem and
         stopped on reading `lower_residual`: it is already
         `(q̂^0.10 − y) / spread`, normalised by each row's own positive spread
         since forecaster 43, *for exactly the reason one would stratify by
         subsystem* — "one fold's bands run 1,691→12,700 MWh on one subsystem
         and 0→3,029 on another". Cross-subsystem scale is already handled, so
         that stratum is likely inert and I would have shipped a change that
         bought nothing.

         What is left after scale is normalised out is **temporal**: `δ_lo` is
         fitted on a calibration window and evaluated on a later walk-forward
         fold, and split conformal's guarantee needs exchangeability the folds
         do not have. The candidate remedies are a calibration window nearer the
         test fold, or weighted/shift-robust conformal — not Mondrian by
         subsystem.

         So the next step is a measurement, not a refactor: break the
         stated-floor coverage down by fold recency, by subsystem and by
         magnitude, and let the shape of the shortfall pick the method. Needs
         the production dataset.
      3. Retrain, and let the gate judge.

      Step 2 cannot be validated anywhere but production: the local database is
      nine rows.

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

      **What the deploy would actually change in production**, checked against
      the live services rather than inferred:

      | change | production today | after |
      |---|---|---|
      | unknown paths | `/nope` → **200** (soft 404) | **404** |
      | `/app` layout shift | CLS **0.215** | **0** |
      | jobs dashboard guard | `WATTSTEER_DASHBOARD=false`, `/jobs` 404 | **no-op** |
      | everything else | — | no behaviour change |

      The first two are the fixes. The third is worth stating because it looks
      like a risk and is not: the guard fails closed in production without
      `WATTSTEER_DASHBOARD_TOKEN`, and production has the flag off, so it takes
      the same silent branch it takes today. Read off the container, not
      guessed — and `config.ts`'s `bool` only accepts `1` and `true`, so the
      string `"false"` is false rather than truthy.

      `apps/web/Dockerfile`'s `CMD` is `bun run server.ts`, so the 404 change
      does reach the deployment; that was confirmed rather than assumed.

      Production is otherwise sound for it: six services `SUCCESS`, no staged
      changes, ledger 52/52 with no empty hashes, schema identical to the
      current migration set (59 tables, 842 columns, 92 indexes), `/ready`
      true, ML reachable.
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
