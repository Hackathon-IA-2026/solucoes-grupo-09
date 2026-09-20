# Where WattSteer runs, and what each place cannot do

Two deployments, one codebase. They differ in what the machine underneath them
allows, and every limitation below was measured rather than assumed — the
numbers are from 19–20/09/2026 and the commands that produced them are named, so
a reader can disagree with the measurement rather than with the sentence.

| | **Railway** (`.railway/railway.ts`) | **Event AWS** (`infra/aws/event/`) |
|---|---|---|
| What it is | the standing deployment | one Workshop Studio instance, borrowed for the hackathon |
| Shape | five services + Postgres + Redis, managed | the same seven containers under Compose on one box |
| Machine | Railway's | Graviton, **2 vCPUs, 8 GB**, one 100 GB disk |
| Deploy | `railway up --service <name>` (see `.claude/rules/deploy.md`) | `infra/aws/event/deploy.sh`, one command |
| Lifetime | ongoing | **ends ~21/09/2026 12:21 UTC** with the account |
| Who can deploy | anyone with the Railway project | anyone with the event credentials |

The event instance is the one the team is testing on today. Railway is where the
work continues after it disappears, which is why nothing in this repository is
specific to the instance: the event path reuses the `ec2` option's own
`compose.aws.yml`, and the only thing it adds is a path prefix, a password and
the ceilings below.

## What the event account does not allow

Measured 18/09 by trying: **no RDS, no ElastiCache, no ALB, no VPC of our own
and no new instances.** `infra/aws/ecs` and `infra/aws/ec2` therefore do not
apply there at all; only the bootstrap S3 bucket would have run. The participant
role also cannot call `ec2:DescribeInstances`, which is why `deploy.sh` finds
the machine through SSM.

## The ceilings, and the incident behind them

On 18/09 the stack ran with no limits and the worker's hourly ingestion peaked
at **4.7 GB and 314 % CPU** while parsing the plant-level constrained-off detail
(660,000 rows in one parse). The instance stopped answering — SSH, SSM and the
site — until it was rebooted through a CDK role.

`compose.aws.yml` now gives every service a `mem_limit` and one CPU, the worker
runs `WATTSTEER_JOB_CONCURRENCY=1`, and `up.sh` creates 4 GB of swap once. Under
those ceilings the same ingestion peaks at **4.4 GB of its 5 GB**, one core, and
the host keeps 6.4 GB free. Raise them on a bigger machine: each is an env var.

**The cost is speed, and it is worth naming.** One core means the plant-level
detail takes minutes rather than seconds, and two ingestions never overlap.

## What is slow there, and why

Postgres on one core with 5.2 million curtailment rows is the constraint behind
every timeout the team will meet:

- The Time Machine's calendar asks for a **window**, not the whole archive: 902
  days took 21.4 s, 262 took 4.7 s, 111 took 2.4 s, and the gateway gives up at
  5 s. `apps/web/src/lib/replay-days.ts` carries the measurement and the page
  size it chose.
- That query used to read the whole table — the civil-date predicate no index
  covers — at 10.5 s for four months. Bounding `valid_time` instead made it
  1.7 s with identical results, which is what made the screen answer at all.
- History before the data window (2024-04-01) was deleted from the event
  database on 20/09: 2.8 million curtailment rows, 841,080 energy-balance rows
  and 813,966 exchange rows that no read could reach and every scan paid for.

## What the data is, in each place

The event instance holds a **copy taken from a laptop on 20/09**: ONS's
curtailment from 2024-01-01, the load and DESSEM series, 430,597 weather rows
and the RAG corpus (293 documents, 18,063 chunks). It keeps ingesting hourly
from ONS on its own.

Two absences the screens state rather than hide:

- **No promoted model.** The gate refused both lanes — `gate_early` on the P10
  calibration guardrail, `gate_late` because ONS's curtailment publication runs
  about three days behind, which leaves `observed_constrained_off_lag_48h` empty
  at serving time. The forecast screens say no model is promoted.
- **The Time Machine works anyway**, because a replay is scored against the
  artifact named on each stored forecast row and never against what is promoted.
  Fold F6's 81 days (2026-07-01 → 09-19) are loaded there.

## Feedback, and where it goes

`POST /v1/feedback` writes to `answer_feedback` in whichever database the
deployment has. It is an opinion and reaches no view, no band and no metric —
see the table's own header. On the event instance it disappears with the
account, so anything worth keeping should be read out before it ends:

```sh
psql "$DATABASE_URL" -c "\copy (select * from answer_feedback) to 'feedback.csv' csv header"
```

## Getting off the event instance

Nothing has to be migrated: Railway runs the same images from the same `main`.
What is *on* the instance and nowhere else is the database copy and the model
artifacts under `/opt/wsdemo/data`, and both were built locally and can be built
again — `infra/aws/event/README.md` has the dump and restore recipe for the RAG
corpus, and the same shape works for the rest of `public`.
