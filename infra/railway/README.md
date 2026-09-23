# Bringing Railway up to the state a laptop trained

Railway runs the same `main` as everywhere else, so **code needs no special
handling**: `railway up --service <name>`, in the order `.claude/rules/deploy.md`
gives. What does need handling is the three things a deployment cannot rebuild
from the repository, because they were produced by a run on somebody's machine:

| | What it is | Where it lives | Without it |
|---|---|---|---|
| `models.tgz` | the retrain's artifacts — a `.joblib` and a `.card.json` per lane | the `ml-models` volume, mounted at `/data/models` | the Time Machine cannot check a replay's windows, and no lane can be promoted |
| `forecasts.sql.gz` | the forecast rows a holdout backfill scored | `curtailment_forecast_{hour,day,national_day}` | the Time Machine has no day to replay and says so |
| `rag.sql.gz` | the evidence corpus: 469 documents, 28,340 chunks with their embeddings (BDO to 21/09/2026, IPDO of 21/09, the whole RAP) | the `rag` schema | Explicar answers without a citation, which is the one thing it exists not to do |

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

Two scripts, deliberately separate — the machine that trains need not be the one
that deploys, and a bundle is worth keeping as what a later run is compared to:

```sh
MODELS_DIR=<the local ml volume> infra/railway/make-state-bundle.sh ~/wattsteer-state
infra/railway/ship-state.sh ~/wattsteer-state
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
- **They write no table other than the three forecast ones**, and that write is
  a single transaction: truncate and insert, so a failure leaves what was there.

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
