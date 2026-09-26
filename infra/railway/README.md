# Bringing Railway up to the state a laptop trained

Railway runs the same `main` as everywhere else, so **code needs no special
handling**: `railway up --service <name>`, in the order `.claude/rules/deploy.md`
gives. What does need handling is the four things a deployment cannot rebuild
from the repository, because they were produced by a run on somebody's machine —
or, in the weather's case, by two and a half years of a quota nobody can hurry:

| | What it is | Where it lives | Without it |
|---|---|---|---|
| `models.tgz` | the retrain's artifacts — a `.joblib` and a `.card.json` per lane | the `ml-models` volume, mounted at `/data/models` | the Time Machine cannot check a replay's windows, and no lane can be promoted |
| `forecasts.sql.gz` | the forecast rows a holdout backfill scored | `curtailment_forecast_{hour,day,national_day}` | the Time Machine has no day to replay and says so |
| `rag.sql.gz` | the evidence corpus: 469 documents, 28,340 chunks with their embeddings (BDO to 21/09/2026, IPDO of 21/09, the whole RAP) | the `rag` schema | Explicar answers without a citation, which is the one thing it exists not to do |
| `weather.sql.gz` | the weather history: 1.46M hourly rows per centroid, 2024-03-31 to 2026-09-28, plus the run-request ledger | `weather_forecast_hour`, `weather_run_request` | the feature rows have no weather, so nothing can be trained or published for a day the target did not fetch itself |

## The short version, if somebody else already trained

The bundle from 23/09/2026 is a release asset on this repository, which is
private — so it is already scoped to the people who can read the code, and no
file has to be sent to anyone. Two commands, and the second is the work:

```sh
railway link            # the wattsteer project, environment production
infra/railway/ship-state.sh --from-release state-2026-09-23
```

That fetches `models.tgz` and `forecasts.sql.gz` with `gh`, puts the artifacts
on the volume and the rows in Postgres, and prints what is there afterwards.

The corpus is a **third** command and deliberately not part of that one, because
it replaces a whole schema rather than three tables and the target may have
indexed further on its own. Run it when Railway's corpus is empty or behind —
both scripts end by printing a count, so the next person can tell:

```sh
infra/railway/ship-rag.sh --from-release state-2026-09-23
```

The weather history is a **fourth** command, and the safest of them to run:
the load is idempotent, so it adds what the target lacks and discards nothing it
fetched itself. Run it on any deployment whose `weather_forecast_hour` does not
reach back to 2024 — without it, no day the target did not fetch can be trained
or published on.

```sh
infra/railway/ship-weather.sh --from-release state-2026-09-26
```

**Why it travels rather than being refetched.** `ecc10e5` measured it: each
weather task stops at the free tier's 138 weighted units, so the whole history
is about 1,800 such slots — on the order of 200,000 units against an allowance
of 10,000 a day. That is roughly three weeks, and it would spend the allowance
the hourly live sweep needs for tomorrow's forecast. `backfill.sh --weather` was
removed for that reason, and it named the alternative: a dump of a database that
already holds it.

**Code is separate and may need nothing**: if the project deploys from GitHub,
`main` is already live. If it deploys from the CLI, it is
`railway up --service rag`, then `ml`, `api`, `worker` and `web`: the order and
the reasons are in `.claude/rules/deploy.md`, and `rag` goes first because the
gateway and the worker call it.

`state-2026-09-23` carries the same models and forecast rows as 20/09 (nothing
newer was trained) and a new corpus. Replacing Railway's corpus with it loses
nothing that matters: its own was about 1,500 chunks, and whatever it fetched
after 21/09 comes back with the next daily refresh, which fills any missing
bulletin of the last week.

**Optional: the free Gemma fallback.** Add a `GEMINI_API_KEYS` secret to the
repository (a Google AI Studio key from a project with **no billing account**,
so it cannot be charged; see `apps/rag/README.md`) and the workflow sets it on
the rag service. Without it the service runs as before.

## Making a bundle yourself

Producing and shipping are deliberately separate — the machine that trains need
not be the one that deploys, and a bundle is worth keeping as what a later run
is compared to. One command produces `models.tgz`, `forecasts.sql.gz` and
`weather.sql.gz`; the corpus is not produced here, and `ship-rag.sh` carries the
two `pg_dump` invocations it needs in its own header.

```sh
MODELS_DIR=<the local ml volume> infra/railway/make-state-bundle.sh ~/wattsteer-state
infra/railway/ship-state.sh ~/wattsteer-state
infra/railway/ship-weather.sh ~/wattsteer-state
```

## Or from GitHub, with nobody running anything

`.github/workflows/deploy-railway.yml` does all of the above from Actions, so
the only manual step left is **one secret**: `RAILWAY_TOKEN`, a project token
(Railway → the project → Settings → Tokens). Whoever holds the project adds it
once; after that the whole handover is a form:

| Input | What it is |
|---|---|
| `services` | `none` when Railway already builds from GitHub, otherwise `all`: the job pushes `rag`, `ml`, `api`, `worker`, `web`, in that order |
| `ship_state` | the artifacts and the forecast rows |
| `state_tag` | the release they come from (`state-2026-09-23`) |
| `with_rag` | the corpus, on by default since `state-2026-09-23` for the reason above; off for a release older than what Railway holds |

It never runs on a push: a deploy is a decision, and the `railway` environment
can require a reviewer before the job starts.

## Who can run what

`ship-state.sh` needs a Railway session with **deploy rights on the `wattsteer`
project** — `railway login`, or `RAILWAY_TOKEN` set to a project token. That is
the only permission involved, and it is not personal: whoever holds it can run
the script. Nothing here needs an owner, a billing role or the dashboard.

If the project sits under one person's account and nobody else has been invited,
the cheapest fix is a **project token** (Railway → the project → Settings →
Tokens), scoped to `production` and revocable, pasted into a file only its owner
can read:

```sh
umask 077; printf 'RAILWAY_TOKEN=%s\n' '<token>' > ~/.wattsteer-railway.env
set -a; . ~/.wattsteer-railway.env; set +a
```

The alternative is an invitation to the project, which is better if more than
one person will deploy this week.

## What the scripts do not do

- **They do not deploy code.** A failed build and a half-restored table are two
  problems, and wearing one hat they are much harder to tell apart.
- **They do not restart a service.** The rows are read per request and the
  artifacts are read from the volume as the replay asks for them.
- **`ship-state.sh` does not touch the RAG corpus.** That is `ship-rag.sh`,
  separately, because replacing a corpus a target built itself is a decision
  and not a step.
- **`ship-state.sh` writes no table other than the three forecast ones**, and
  that write is a single transaction: truncate and insert, so a failure leaves
  what was there.
- **`ship-weather.sh` never truncates.** The receiving deployment writes
  `weather_forecast_hour` itself every hour, so the load goes through a temp
  table and inserts `ON CONFLICT DO NOTHING`: it adds the history the target
  lacks and discards nothing it fetched. Running it twice is running it once.

## After shipping

```sh
railway run -- sh -c 'psql "$DATABASE_URL" -At -c "select count(*) from curtailment_forecast_day"'
```

Then open the Time Machine and press a day. `.claude/rules/deploy.md` is
emphatic about this and it is right: a 200 from `curl` says the HTML was served,
not that the screen works.

## Why the forecast is not promoted, wherever you ship it

The gate refuses both lanes today, and for two different reasons —
`docs/environments.md` has them with the measurements. Neither is fixed by
copying files around: one is a calibration guardrail, the other is ONS's
publication running about three days behind. The Time Machine works regardless,
because a replay is scored against the artifact named on each stored row rather
than against whatever is promoted.
