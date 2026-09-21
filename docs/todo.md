# What is left to do

**Status:** open. Written 21/09/2026, last worked 21/09/2026, for whoever picks
the work up before the on-site hackathon (25–27/09). The organisation's rule for
that event is the yardstick: *what is standing and working on the 27th* is what
gets judged. Tick a box in the same PR that does the work, and delete an item
rather than leave it stale.

Every item says where the evidence is, so it can be checked instead of trusted.

`bun run check` exits 0 — typecheck, `biome check` and all four TypeScript
suites, 5,159 tests passing across the six suites. The five hygiene failures and
two lint errors that were once called a baseline are closed; one of them was a
real defect (the Overview's copy never moved into the dictionaries) and two were
developer prose being rendered on the Time Machine screen.

## P0 — the demo does not stand without these

### 1. Bring Railway up to the trained state

The event's AWS account **ended on 21/09 12:21 UTC**, so Railway is the only
deployment left until the organisation reopens AWS on site. The trained state
(model artifacts, forecast rows, RAG corpus) is the release `state-2026-09-20`.

**Status on 21/09: one of the three parts is shipped.** The corpus is on
Railway; the model artifacts and the forecast rows are not. "Bring Railway up
to the trained state" is not done, and was briefly reported as done — the
corpus is the part that was shipped, not the state.

- [x] ~~`RAILWAY_TOKEN` secret~~ — not needed for the corpus, which went up
      with the local `railway` CLI rather than through Actions. Still needed if
      `deploy-railway.yml` is to run the rest from CI.
- [x] Before choosing `with_rag`, read Railway's corpus size **first**.
      **Read on 21/09: Railway holds 1,508 chunks over 240 documents, with no
      RAP at all and one IPDO** — against the release's 18,063 over 293. So
      `with_rag` is **yes**. Measured through a temporary TCP proxy on the
      Postgres service, which was deleted immediately afterwards.
      Consequence worth knowing before the demo: the deployed evidence service
      cannot answer the goldset's disturbance or IPDO questions at all, so any
      RAG figure quoted from Railway today is about a different corpus from the
      one measured below.
- [x] **The RAG corpus**, shipped 21/09: Railway went from 1,508 chunks over
      240 documents to **18,063 over 293**, with the HNSW and GIN indexes, both
      foreign keys and the `public.rag_migration` ledger. The previous schema is
      kept as `rag_pre_20260921` for rollback
      (`ALTER SCHEMA rag_pre_20260921 RENAME TO rag`) and should be dropped once
      the demo is proven. `public.rag_migration` lost its primary key in the
      swap — the renamed table still holds the constraint name — which does not
      affect boot, because the migration runner does a `SELECT` then a plain
      `INSERT` with no `ON CONFLICT`.
- [x] **The reranker**, which was measured and running nowhere: the image now
      installs the `[rerank]` extra and bakes the cross-encoder in, confirmed in
      the build log and by the first query after deploy paying the model load.
- [x] **`models.tgz` and `forecasts.sql.gz` — deliberately NOT shipped.**
      Checked before writing, on 21/09, and shipping them would be a
      regression:

      Railway's volume already holds an artifact the gate **promoted**
      (`gate_early`, 2026-09-16T20:00:00Z), and `/v1/meta` on production reads
      `state=promoted, usable=true` for that lane. The release bundle's
      `promotions.jsonl` carries only refusals — `gate_early` on
      `p10_calibration_excess +0.0509` against `0 ± 0.0193`, `gate_late` on
      `serving_smoke`. Untarring it over the volume replaces the one serving
      artifact with two refused ones, and `forecasts.sql.gz` opens with
      `TRUNCATE ... CASCADE` on all three forecast tables, replacing rows the
      promoted artifact published with rows from a machine that has none.

      `state-2026-09-20` is newer by date and **worse by state**. Ship it only
      onto a target that has nothing, which is what `ship-rag.sh`'s header says
      about the corpus and what `ship-state.sh` does not say about artifacts.

Details: `infra/railway/README.md`.

### 2. Get a forecast lane promoted

**This is a statement about the laptop, not about Railway.** Measured on
21/09: production has `dessem_free_v1__gate_early__thr5` at
`state=promoted, usable=true`, and `/v1/grid/outlook?gate_profile=gate_early`
returns a complete four-subsystem outlook for today and tomorrow from artifact
`2026-09-16T20:00:00Z`. The forecast screens are not stating an absence there.

What is still true is that the **latest** retrains refuse both lanes, so the
serving artifact is ageing and `gate_late` has never promoted. The gate refuses
them for two different reasons (`docs/environments.md`), and both carry a
measured margin over the baseline while being refused — 319.5 against 475.2
quantile-loss MWh for `gate_early`, 324.2 against 476.2 for `gate_late`, each
with `P(candidate better) = 1.0`. A gate that refuses a model which beats its
baseline by a third is the product working, and it is worth a slide.

The two reasons:

- [ ] **`gate_late`**: ONS publishes curtailment about three days late, so
      `observed_constrained_off_lag_48h` is empty at serving time. The scheduled
      `publication-lag-conformance` job fails on exactly this, and its message
      says the fix is **a migration raising the configured lag**, not an edit to
      the test. Then retrain.
- [ ] **`gate_early`**: fails the P10 calibration guardrail. Needs an ML
      decision (features, calibration window), not a gate change.
- [ ] Done when the local `/v1/meta` shows a promoted lane and a forecast
      screen draws a band. Then ship the new artifacts with
      `infra/railway/make-state-bundle.sh` and item 1.

### 3. RAG accuracy above 90%, measured on questions it was not tuned on

Last measured run (19/09, NVIDIA first, `apps/rag/eval/questions.jsonl`):
**67/80 correct (83.75%), 10 refused, 3 wrong** (I06, A01, A02). The target
is above 90%, and the number only counts on a fresh set.

- [ ] Write about 30 new questions with a published answer, never used while
      tuning, and run `apps/rag/eval/run_eval.py` on both sets.
- [x] **The three wrong answers (I06, A01, A02): 0 correct → 2 correct**,
      measured end to end on 21/09 against the restored corpus. None of the
      three had the cause the list assumed:
  - **I06** quoted an instantaneous MW peak from the SIN table on page 13
    instead of the Northeast's daily 12.197 MWmed on page 1. The cause was the
    `verify` chain leading with Groq while `GROQ_API_KEYS` is empty, with a
    fallback that was answering 503 — so the claim reader had **no working
    link**, and a missing reader refuses the document. NVIDIA leads now, with
    kimi-k3 between it and Groq. Correct.
  - **A01** answered "34,5 % da carga": true, cited, and not what was asked.
    The sentence that answers it is on page 15 of a 572-page report and was in
    **none** of the 80 retrieved candidates. Fixed by the reranker below.
    Correct.
  - **A02** is still wrong, and now precisely: its chunk is at fused rank 11
    with the cut at 8, the cross-encoder still ranks eight above it, and the
    report holds several restoration timestamps — it answers 09h44 (LIGHT's
    ERAC) where 14h49 (the ONS authorising total restoration) is asked.
- [x] The second reader is tightened, not duplicated. Both shapes it still
      accepted were **already forbidden in its prompt**, so more prose was not
      the fix: it now names the grain and the regime it read and `_mismatch`
      refuses the disagreement in code. Checked-when-present, so a model that
      does not report it leaves the reader exactly as strict as before. The
      pointer gate learned `quadro`, `seguinte` and numbered tables for the
      other half.
- [ ] Older revisions of an operating instruction are not in the corpus (the
      listing is rendered by JavaScript), so a record from before a revision is
      checked against the current text. **Not started.**
- [x] Groq as first provider: **decided against, by the number.** It was
      already first for `verify` and that is what broke the reader — the
      deployment has no Groq key. NVIDIA leads, Groq is the fallback.

## P1 — needed before the 27th, not blocking the screens

### 4. Scheduled CI jobs that are red

- [ ] `publication-lag-conformance`: same cause as item 2.
- [ ] `narration-live`: same cause as item 3.
- [ ] `publication-watch`: fails because the `WATTSTEER_WATCH_DATABASE_URL`
      secret is not set, so it reads no deployment. Add it (read-only role on
      Railway's database) or disable the schedule until there is one.

### 5. Answers still owed by the domain specialist (Bisogno)

- [ ] The 10 remaining smoke-test questions (5 of 15 arrived).
- [ ] What the CP 39/2023 note (AC-12) should say, and its source.
- [ ] Which item of Módulo 10 the footer cites: the compliance report calls it
      transparency and reproducibility, his 16/09 reply calls it the operation
      procedures manual.

### 6. Deck for the on-site presentation

- [ ] Replace every figure in the deck with one measured in this repository.
      **`docs/deck-figures.md` is that list**, written 21/09 with each number
      labelled *measured*, *published contract* or *not available*. Two traps it
      names: the Time Machine's 612 / 281 / 45.9 % is the published **contract
      example**, not a replay measured today, and the RAG accuracy figure is on
      the set the system was tuned on until the ~30 fresh questions exist. The
      deck still has to be edited.

## P2 — only if there is time

- [ ] RAG job surface: `rag.job` and `rag-job-status.schema.json` exist as the
      contract, nothing serves them (`docs/rag/decisions.md`).
- [ ] `/internal/rag/search` does not pass `target_date`, so the day filter the
      real path applies is missing and the endpoint ranks other days' bulletins
      into the answer. It is the tool used to ask "why did retrieval do that",
      and it answers about a different retrieval. Pass the axis through, or say
      on the response that it was not applied (`docs/rag/decisions.md`).
- [x] Local reranker **now running on Railway**: the image installs the extra
      and bakes the cross-encoder in (`apps/rag/Dockerfile`), confirmed in the
      build log and by the first query after deploy paying the model load.
- [x] Local reranker for the RAG — **built and measured** (`rerank.py`,
      `eval/measure_rerank.py`). Over the 67 goldset questions that name the
      numbers their document states, a passage stating one reaches the drafter
      in **52/67 under RRF and 59/67 reranked** — seven rescued, none lost.
      Left **off by default** (`WATTSTEER_RAG_RERANK_MODEL` empty): the extra is
      a few hundred megabytes, and a deployment without it must run the
      retrieval that was measured. Turning it on in production is a decision
      with a number behind it now.
- [ ] Read `answer_feedback` out of every database before it is torn down
      (command in `docs/environments.md`). The event instance's copy went with
      the account.
- [ ] When AWS reopens on site: `infra/aws/event/deploy.sh`, keeping the
      memory ceilings in `compose.aws.yml`. The CloudFront address will change.
