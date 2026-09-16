# 45 — the retrain is a twelve-minute HTTP request, and the network will not hold it

**What to build:** a retrain the worker can start, observe and conclude without
holding a socket open for the length of the run.

**Status:** built and deployed. `POST /internal/retrain` answers 202 with the
run id, `GET /internal/retrain/{run_id}` reports `running` / `decided` /
`failed`, and the worker polls with backoff bounded by `RETRAIN_TIMEOUT_MS` —
which now bounds a sequence of short requests rather than one long one.

**The measured ceiling was 300 seconds**, against a run of roughly 750. The
diagnosis below is kept in full: three separate things made it look like
something else, and each was a defect in what the system *said* rather than in
what it did.

## What happens

`jobs/retrain.ts` POSTs `/internal/retrain` and waits for the whole run in one
request. `RETRAIN_TIMEOUT_MS` is forty minutes and the endpoint is configured
with it, so the intent is clear and the code is correct on its own terms.

It does not survive the network. Measured on 2026-09-15:

| | |
|---|---|
| worker's call | aborts after **~2 minutes**, reported as `OPTIMIZER_TIMEOUT` |
| ML service | keeps training — **CPU 36%, RSS 2.80 GB**, well past the abort |
| uvicorn access log | writes nothing until the response completes, so the POST is invisible while it runs |
| decision lines | appear (or not) with no relation to what the worker reported |

Three firings — `20:29`, `20:34`, `20:40` — each reported

> ⚠️ retrain … the retrain did not finish inside 40 minutes

while the run itself was proceeding normally. **Every retrain reports a failure
that did not happen.**

## Why it looks like something else three times over

This cost an hour of wrong diagnosis, and each wrong turn is worth recording
because each was a defect in what the system *says* rather than in what it does.

1. **The message asserted a duration it never measured.** `describeFailure`
   mapped `OPTIMIZER_TIMEOUT` to "did not finish inside 40 minutes" whatever the
   elapsed time was. Fixed already: it now names the measured elapsed beside the
   ceiling, which is what tells a 2-minute connect abort from a real overrun.
2. **`ml-proxy` maps any `TimeoutError` to `OPTIMIZER_TIMEOUT`.** Bun raises
   that name for its own connect/idle timeouts too, so an abort that had nothing
   to do with our `AbortSignal` arrives wearing our ceiling's name.
3. **Absence of an access-log line read as absence of a request.** It is the
   opposite: uvicorn logs on response, so *the longer a request runs, the longer
   it stays invisible*. The only honest liveness signal during a run is the
   process metrics.

## The defect, stated plainly

A request that transmits no bytes for twelve minutes is not a shape this
deployment's internal networking will hold, and no timeout on either end changes
that. The run is fine; the *waiting* is what fails.

It also means the run is unobservable while it matters. `report({done, total})`
is called once before the POST and once after, so a forty-minute job has no
progress, and the operator's only window is `get-service-metrics`.

## What to build

- `POST /internal/retrain` returns **202** immediately with the run id, having
  started the child process. It does not wait.
- `GET /internal/retrain/{run_id}` reports `running` / `decided` / `failed`, and
  on `decided` carries the same report the POST used to return.
- The worker polls that, with backoff, up to `RETRAIN_TIMEOUT_MS` — which then
  means what it says, because it is bounding a *sequence of short requests*
  rather than one long one.
- `report()` per lane, so the queue's progress is the run's progress.
- The idempotency that already exists — a lane carrying a decision line for the
  run id is skipped — is what makes a redelivered poll safe, and forecaster 44
  made an all-skipped run exit zero rather than look like a failure.

## Boxes

- [ ] `/internal/retrain` returns 202 and does not block
- [ ] a status route, and the worker polls it
- [ ] `RETRAIN_TIMEOUT_MS` bounds the poll loop rather than one request
- [ ] progress per lane rather than one before and one after
- [ ] a test that a run longer than any single request's lifetime still reaches a
      decision — the property this ticket exists for, and one no current test
      makes
- [ ] `ml-proxy` distinguishes *our* abort from the runtime's, so a future
      timeout cannot borrow this one's name

## What this does not claim

That it is why nothing is promoted. The gate refused both lanes on the band's
floor (forecaster 43) and `gate_late` additionally on `crossing_rate` 0.0107
against 0.01; this ticket is about the *reporting* and the *shape* of the call,
and a run that completes despite it still gets a real verdict.
