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

- [x] **`gate_late`** — **addressed in code, merged in `#40`, not yet proven.**
      The fix written here was wrong and `docs/feature-alternatives-constrained-off-lag.md`
      shows why: the lag is measured from the *target hour*, so raising the
      configured lag only moves the cut further from the cutoff. The feature was
      dropped instead (migration `0055`), because it was NULL by construction —
      the block reads `(cutoff − 168 h, cutoff]` and only hours 00–03 of D−2
      fall inside, which is 20 of 24 hours, the 83.3% `serving_smoke` compared
      against. Needs a retrain to show a promotion.
- [ ] **`gate_early`**: fails the P10 calibration guardrail. Needs an ML
      decision (features, calibration window), not a gate change. Unchanged
      by `#40`.

### 0. 🔴 `/internal/*` on `ml` is reachable from the public internet

Verified 21/09: `ml-production-f9cb.up.railway.app` still exists, and
`GET /internal/retrain` answers **405 Method Not Allowed** — the route is there,
publicly routable, with no auth challenge. A `POST` starts a forty-minute
training run. `architecture.md` says the prefix *is* the marker for what only
the worker may call.

Nothing depends on the hostname: `worker` and `api` both hold
`WATTSTEER_ML_URL=http://ml.railway.internal:8000`, so deleting it breaks
nothing. The domain was created by accident by `railway domain --service ml`
with no subcommand, which *creates* rather than lists — `deploy.md` records that
trap.

- [ ] `railway domain delete ml-production-f9cb.up.railway.app --service ml --environment production`
      (agent attempts are refused by the DNS/domain guard, so this is a human
      command.)

### 2a. The migration went ahead of the services, and that is the whole story

Done 21/09, and the sequence cost more than this item predicted. It said the
window was "the retrain's ~40 minutes". That was wrong.

**What was applied**: `0053`, `0054`, `0055` on Railway, no data lost. **What
was not**: `ml`, `worker` and `api` were left on pre-`#40` code, so the schema
moved ahead of every service that reads it.

The retrain triggered straight afterwards failed on both lanes, and neither
failure was about modelling:

- `gate_early` — **`FeatureContractError`**. The deployed `ml` cannot parse the
  row the new `feature_rows` returns.
- `gate_late` — **`serving_smoke`**, but on new columns:
  `programmed_load_daily_min_mwh` and `proxy_vre_surplus_mwh` are 100 % NULL,
  because they come from `#40`'s day-ahead-programme ingestion and the worker
  that fills them is not deployed.

**Why freezing was not the safe option**, which is the thing worth remembering:
`publication.py` reads `feature_rows` too. Forecasts were published through
22/09 before the migration, and the next `gate_early` publication — 09:00 BRT —
would have hit the same contract error. Freezing would have meant no forecast at
all on 25–27/09, the days being judged. The serving artifact looked safe only
because `ml` had not restarted since the migration.

So the chain is: **deploy `ml` → `worker` → `api`, let the programme ingestion
backfill, retrain, and only then is a lane promotable.** The forecast is dark
from the first `ml` restart until a retrain succeeds.

- [ ] Confirm `/v1/meta` shows a promoted **and usable** lane on the new
      contract, and `/v1/grid/outlook` draws a band, before the 25th.
- [ ] If the retrain still refuses after the backfill, that is a real modelling
      decision and not skew — `gate_early`'s P10 calibration guardrail is
      unchanged by `#40`.

**The lesson for the next migration**: a migration that redefines `feature_rows`
is not an out-of-band database step. It is a deploy of the database *and* every
service that reads it, in one window, and `deploy.md`'s `ml → api → web` order
is about exactly this.

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

### 5b. ~~The observed curtailment is too high by roughly 2–3×~~ — SETTLED 22/09

**The adapter read the wrong ONS field.** `val_geracaolimitada` is the
*ceiling* ONS set, not the energy cut under it. From ONS's own published
dictionary for `restricao_coff_eolica_usi`:

| field | ONS's definition |
|---|---|
| `val_geracaolimitada` | "Geração limitada. Representa o **limite** para a geração da usina/conjunto estabelecido pelo ONS em Tempo Real, em MWmed." |
| `val_geracaonaorealizadaapurada` (GNRa) | "Geração Não Realizada Apurada… a estimativa de geração frustrada, obtida pela **diferença entre a geração de referência e a geração verificada** (se menor que zero, GNRa = 0), nos períodos em que houve limitação de geração." |

One published row settles it — Conj. Paulino Neves, 2026-09-01 10:00, ENE:

| verificada | limitada | referência | GNRa |
|---|---|---|---|
| 319,268 | **322,000** | 428,899 | **109,631** |

428,899 − 319,268 = 109,631 exactly, and 322,000 / 109,631 = **2,9×** — the
2–3× measured empirically, with a cause. It also explains the impossibility
that first raised it: a ceiling is naturally close to what the fleet actually
generated, so summing ceilings produces a number the size of generation itself,
which is how "21.940 MW curtailed against 30.828 MW installed" appeared.

The "37 % gap" between `constrained_off` and `reference − verified` was never a
gap: GNRa **is** `reference − verified`, and the two were different quantities.

Fixed in `apps/api/src/ingest/ons/constrained-off.ts`: GNRa where ONS wrote it,
and where the column predates the file, ONS's own formula — the difference,
floored at zero, only in half-hours ONS marked as limited.

- [x] Settle what `val_geracaolimitada` means against `val_geracaoreferencia`
      and `val_geracao`. **Answered by ONS's data dictionary, not by Bisogno.**
- [ ] **Re-ingest the history.** Every stored `constrained_off_mwh` is the
      ceiling and is ~2,9× too high. The code is right and the database is not
      until a `recent` + `history` sweep has rewritten it.
- [ ] Until it has, the caveat below still stands.

### 5b-old. The measurement that found it

Measured 21/09 against production, and **it is systematic rather than one
extreme day**. Every day of 01–16/09 reads 150–220 GWh for Nordeste.

Read out of the same database, for 2026-09-16:

| | |
|---|---|
| NE installed (949 wind plants, 308 solar) | **42,449 MW** |
| Verified generation | 400,964 MWh — 16,707 MW average |
| Constrained off | 181,382 MWh — **7,558 MW average** |
| Implied "would have been" | **24,265 MW average — 57 % CF over 24 h, night included** |
| Largest single hour | **21,940 MW curtailed against 30,828 MW of wind installed — 71 % of the fleet, in one hour, while generating** |

The last row is the one that settles it. A fleet cannot be 71 % curtailed and
generating at the same time.

**What was ruled out**, so nobody re-derives it:

- *The adapter's unit conversion.* `mwmedToMwh` is `mwmed × interval/60` over
  half-hourly rows, which is right.
- *A cross-grain double count.* `conjunto` (178,668 MWh) and
  `self_reporting_plant` (2,596 MWh) are disjoint and sum to exactly the
  181,263 the readout shows.
- *Forecast contamination.* The forecast agrees with the observation, so both
  sides read the same number; this is upstream of the model.

**The live lead**: `constrained_off` (181,382) does not equal
`reference_generation − verified_generation` (533,659 − 400,964 = 132,695) — a
37 % gap. Those three come from the same ONS row, so one of them is not the
quantity it is being read as. That is where to look next, and it is a question
about ONS's own field definitions rather than about this code.

- [ ] Settle what `val_geracaolimitada` means against `val_geracaoreferencia`
      and `val_geracao`, and whether the hourly rollup may sum what ONS
      already totalled. Bisogno is the short path.
- [ ] **No absolute MWh figure for observed curtailment goes in the deck** —
      not Nordeste's and not the national total, which is `sum_of_four` over the
      same rows. Ratios over a shared denominator (avoidability, % avoided) are
      unaffected and remain safe.

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
- [x] `/internal/rag/search` now takes `target_date` and passes it through, and
      says `day_window_applied` on every response so an axis that did not run
      cannot be mistaken for one that did. Guarded in `test_gates.py`.
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
- [x] Read `answer_feedback` out before it is torn down — done 21/09, and the
      honest result is that **there was nothing to save**. Railway holds
      exactly one row, and it is our own smoke test
      (`surface=forecast, verdict=up, subject={"subsystem":"NE"}`, recorded
      14:34 that day while verifying `POST /v1/feedback` returns 201). The
      real feedback was on the event instance and went with the AWS account,
      as this item warned; this closes because the window had already shut, not
      because it was caught in time.

      The export is in the session scratchpad rather than the repository: one
      synthetic row is not evidence of anything and does not belong in git.
      Whoever runs a demo that collects feedback should drain it the same day —
      `psql "$DATABASE_URL" -c "\copy (select * from answer_feedback) to
      'feedback.csv' csv header"` through a temporary TCP proxy on the Postgres
      service, deleted afterwards.
- [ ] When AWS reopens on site: `infra/aws/event/deploy.sh`, keeping the
      memory ceilings in `compose.aws.yml`. The CloudFront address will change.
