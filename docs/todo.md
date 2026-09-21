# What is left to do

**Status:** open. Written 21/09/2026 from `main` at `b1f6474`, for whoever picks
the work up before the on-site hackathon (25–27/09). The organisation's rule for
that event is the yardstick: *what is standing and working on the 27th* is what
gets judged. Tick a box in the same PR that does the work, and delete an item
rather than leave it stale.

Every item says where the evidence is, so it can be checked instead of trusted.
There are no open pull requests or issues and every remote branch is merged, so
this file is the whole backlog.

## P0 — the demo does not stand without these

### 1. Bring Railway up to the trained state

The event's AWS account **ended on 21/09 12:21 UTC**, so Railway is the only
deployment left until the organisation reopens AWS on site. The trained state
(model artifacts, forecast rows, RAG corpus) is the release `state-2026-09-20`.

- [ ] Whoever owns the Railway project adds the `RAILWAY_TOKEN` secret
      (Railway → project → Settings → Tokens). This is the only manual step.
- [ ] Run `deploy-railway.yml` from Actions with `ship_state` on and
      `state_tag = state-2026-09-20`. Decide `with_rag` after reading
      Railway's chunk count (the script prints it).
- [ ] Open the Time Machine and press a day. A 200 from `curl` is not a check
      (`.claude/rules/deploy.md`).

Details: `infra/railway/README.md`.

### 2. Get a forecast lane promoted

No lane is promoted, so every forecast screen states an absence. The gate
refuses both lanes for two different reasons (`docs/environments.md`):

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

### 3. Take closed providers out of the runtime

The team decided that in the cloud only open models run (NVIDIA NIM, Groq,
Bedrock with open models). Two places still depend on closed ones:

- [ ] **Narration** calls the Anthropic SDK
      (`apps/api/src/diagnosis/narration-client.ts`). Move it behind the same
      OpenAI-compatible gateway the RAG uses (`docs/rag/gateway.yaml`), keeping
      its gates and its template fallback. The scheduled `narration-live` job
      fails today because `ANTHROPIC_API_KEY` is empty in CI.
- [ ] **Voice** uses xAI's realtime API (`apps/api/src/api/voice.ts`). Either
      replace it with NVIDIA's `nemotron-voice-agent` or leave voice out of the
      demo and say so on screen. Team decision.

### 4. RAG accuracy above 90%, measured on questions it was not tuned on

Last measured run (19/09, NVIDIA first, `apps/rag/eval/questions.jsonl`):
**67/80 correct (83.75%), 10 refused, 3 wrong** (I06, A01, A02). The target
is above 90%, and the number only counts on a fresh set.

- [ ] Write about 30 new questions with a published answer, never used while
      tuning, and run `apps/rag/eval/run_eval.py` on both sets.
- [ ] Open gaps found in validation, each a separate `fix/rag-*` branch:
  - no semantic check that the claim is what the quote says (a claim can pass
    every gate and still be wrong);
  - numbers are not tied to their row and column (LAPA answered 11,802 where
    the table says 9,39);
  - the bulletin's balance table only carries the subsystem in its HTML id;
  - the solar table is about 8,000 characters with no date in the chunk;
  - the corpus holds only the current revision of each operating instruction.
- [ ] Try Groq as the first provider if it measures better (the gateway allows
      it; decide by the number).

## P1 — needed before the 27th, not blocking the screens

### 5. Scheduled CI jobs that are red

- [ ] `publication-lag-conformance`: same cause as item 2.
- [ ] `narration-live`: same cause as item 3.
- [ ] `publication-watch`: fails because the `WATTSTEER_WATCH_DATABASE_URL`
      secret is not set, so it reads no deployment. Add it (read-only role on
      Railway's database) or disable the schedule until there is one.

### 6. Licence, and the organisation's repository

- [ ] The repository was relicensed from MIT to **AGPL-3.0** on 16/09
      (`7191e8b`). The hackathon rules ask for a public repository under **MIT**
      for the code written during the event, and
      `Hackathon-IA-2026/solucoes-grupo-09` is MIT. Decide which licence goes
      in before mirroring.
- [ ] Mirror `main` into `Hackathon-IA-2026/solucoes-grupo-09` (last push
      14/09), README in the organisation's template. Only with Guilherme
      Chaves's explicit go-ahead.

### 7. Answers still owed by the domain specialist (Bisogno)

- [ ] The 10 remaining smoke-test questions (5 of 15 arrived).
- [ ] What the CP 39/2023 note (AC-12) should say, and its source.
- [ ] Which item of Módulo 10 the footer cites: the compliance report calls it
      transparency and reproducibility, his 16/09 reply calls it the operation
      procedures manual.

### 8. Deck for the on-site presentation

- [ ] Replace every figure in the deck with one measured in this repository
      (RAG accuracy from item 4, Time Machine scores, forecast only if item 2
      lands). No number that is not verifiable.

## P2 — only if there is time

- [ ] RAG job surface: `rag.job` and `rag-job-status.schema.json` exist as the
      contract, nothing serves them (`docs/rag/decisions.md`).
- [ ] Local reranker for the RAG (`pip install -e ".[rerank]"`), measured
      against the RRF order before it is turned on.
- [ ] Read `answer_feedback` out of every database before it is torn down
      (command in `docs/environments.md`). The event instance's copy went with
      the account.
- [ ] When AWS reopens on site: `infra/aws/event/deploy.sh`, keeping the
      memory ceilings in `compose.aws.yml`. The CloudFront address will change.
