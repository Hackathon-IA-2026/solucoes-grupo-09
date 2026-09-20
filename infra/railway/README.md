# Bringing Railway up to the state a laptop trained

Railway runs the same `main` as everywhere else, so **code needs no special
handling**: `railway up --service <name>`, in the order `.claude/rules/deploy.md`
gives. What does need handling is the two things a deployment cannot rebuild
from the repository, because they were produced by a run on somebody's machine:

| | What it is | Where it lives | Without it |
|---|---|---|---|
| `models.tgz` | the retrain's artifacts — a `.joblib` and a `.card.json` per lane | the `ml-models` volume, mounted at `/data/models` | the Time Machine cannot check a replay's windows, and no lane can be promoted |
| `forecasts.sql.gz` | the forecast rows a holdout backfill scored | `curtailment_forecast_{hour,day,national_day}` | the Time Machine has no day to replay and says so |

Two scripts, deliberately separate — the machine that trains need not be the one
that deploys, and a bundle is worth keeping as what a later run is compared to:

```sh
MODELS_DIR=<the local ml volume> infra/railway/make-state-bundle.sh ~/wattsteer-state
infra/railway/ship-state.sh ~/wattsteer-state
```

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
- **They do not touch the RAG corpus.** It has its own dump-and-restore recipe
  in `infra/aws/event/README.md`, and the same shape works here.
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
