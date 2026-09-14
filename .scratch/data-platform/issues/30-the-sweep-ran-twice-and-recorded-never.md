# 30 — the live sweep ran twice and recorded itself never

**What to build:** a job lock that outlives the job it is a claim about.

**Status:** done — `apps/api/test/job-lock-duration.test.ts`, and deployed.

Found by reading the worker's log two days after it first stayed up. Thirty-three
occurrences of:

```
error: could not renew lock for job repeat:refresh:live:1789402620000
```

The first reading — "noisy logs, data still lands" — was wrong, and the log says
so if you follow one job id through it.

## What actually happened, on one run

| time (UTC) | event |
| --- | --- |
| 16:17:00 | `repeat:refresh:live:1789402620000` starts |
| 16:17:42 | `could not renew lock` — the 30 s claim has lapsed |
| 16:17:48 … 16:23:20 | renewal fails every ~7.5 s, fourteen more times |
| 16:26:17 | `Lock mismatch … Cmd moveToDelayed from active` |
| 16:28:27 | `Lock mismatch … Cmd moveToFinished from active` |
| 16:29:57 | both again, **each line duplicated** |

Three things follow, and none of them is cosmetic:

1. **The sweep ran twice.** A lapsed claim is what BullMQ calls a stalled job,
   and the stalled-job checker hands it to another processor. The duplicated
   log lines at 16:29:57 are two processors finishing the same job. The worker's
   8.17 GB memory peak (limit 32 GB) is two concurrent passes over ONS monthly
   constrained-off files that are **244 MB apiece** — measured from the CKAN
   catalogue, not estimated.
2. **It recorded itself never.** `moveToFinished` failed. The run's result was
   never written.
3. **The schedule's own next occurrence failed too.** That is what
   `moveToDelayed` is.

## The measurement the fix is set from

The sweep ran **12m 57s** (16:17:00 → 16:29:57). BullMQ's default
`lockDuration` is 30 s. That is the whole defect: the default is a claim about a
job that finishes in seconds, and this one does not.

`WATTSTEER_JOB_LOCK_DURATION_MS` defaults to **20 minutes**, and both bounds are
derived rather than picked:

- **above** 12m57s, so a slow upstream cannot expire the claim;
- **below** the sweep's own hourly period (`REFRESH_CADENCE.live` = `17 * * * *`),
  so a genuinely wedged worker is still reclaimed before the next run is due.

`stalledInterval` moves with it. A checker that sweeps faster than a claim can
lapse reclaims jobs that are merely slow.

## Two causes measured and rejected first

- **The CSV scanner starving the renewal timer.** `parseDelimited` is a
  synchronous character scanner, so it was the obvious suspect. Measured on a
  real 102 MB `RESTRICAO_COFF_EOLICA_DETAIL_2026_09.csv`: **1.03 s**, 658,320
  rows, with a 100 ms heartbeat recording **0 ticks** — so the loop is fully
  blocked, and it is blocked for two orders of magnitude less than 30 s.
  Real, and not this.
- **The API contending for the queue.** It does not: `startWorker` is already
  `config.role !== "api"`, and the deployed API carries `WATTSTEER_ROLE=api`.

## Non-vacuity

Beside the assertion that the default covers the measured sweep sits one that
BullMQ's 30 s falls on the *failing* side of the same comparison, and the guard
was run against it: `WATTSTEER_JOB_LOCK_DURATION_MS=30000 bun test` fails, on
that assertion and no other. The ceiling is read out of `REFRESH_CADENCE.live`
rather than restated beside it.

## Left open, deliberately

`concurrency: 2` on a worker whose jobs are twelve-minute, multi-gigabyte
ingestions is a separate question from this one. With the lock corrected there
is no longer a mechanism turning it into duplicate work, so it is not a defect
today — but nothing has measured whether two concurrent sweeps are *wanted*.
