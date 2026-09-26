# WattSteer on AWS

The whole deployment is one CloudFormation template, `stack.yaml`, and every
push to `main` deploys itself (`.github/workflows/deploy-aws.yml`).

```
GitHub push ─▶ Actions (OIDC, no stored keys) ─▶ source.zip in S3
                                                   │
                                  CodeBuild (arm64) builds the five images
                                                   │ SSM
                                                   ▼
viewer ─▶ CloudFront (HTTPS) ─▶ EC2 m7g.xlarge: Caddy ─▶ web · api · worker · ml · rag
                                                         Postgres · Redis (Compose)
```

| File | What it does |
|---|---|
| `stack.yaml` | instance, security group (port 80 from CloudFront only), Elastic IP, CloudFront, bucket, the deploy CodeBuild project, the GitHub OIDC role |
| `stack.sh` | creates or updates the stack through the account's CDK roles, writes `stack.env` |
| `stack.env` | the stack's outputs, read by every other script and by CI. Names, not secrets |
| `deploy.sh` | archives `HEAD` into the bucket and runs the deploy CodeBuild project |
| `buildspec.yml`, `ship.sh` | inside CodeBuild: build the images and run `remote.sh` on the instance |
| `remote.sh` | on the instance: load the images, write `.env`, migrate, seed, `compose up` |
| `set-keys.sh` | provider keys from `.env` into Parameter Store (`/wattsteer/keys/*`) |
| `seed-state.sh` | a state release (models, forecast rows, RAG corpus) into `s3://…/state/` |
| `compose/compose.aws.yml`, `Caddyfile` | the stack the instance runs, with its memory ceilings |
| `backfill.sh` | fills the instance's database from ONS and Open-Meteo, in the background |
| `train.sh`, `buildspec-train.yml`, `train-job.sh` | one training run on the 72-vCPU CodeBuild machine, inside a budget of machine minutes |
| `jobs/campaign.sh`, `jobs/fit_speed.py` | the arms a training run parallelises, and the benchmark that says why |
| `dump-db.sh` | the instance's database into the bucket, for `train.sh` |

## A new account, from nothing

With the Workshop Studio credentials exported (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; "Get AWS CLI credentials" on the
event page) and Docker running:

```sh
infra/aws/stack.sh               # the infrastructure, ~5 minutes; commit stack.env
infra/aws/set-keys.sh            # NVIDIA, Groq, Gemini and xAI keys from .env
infra/aws/seed-state.sh          # models, forecast rows and RAG corpus
infra/aws/deploy.sh              # the first deploy, ~20 minutes
```

After that, pushing to `main` is the deploy. `stack.sh` runs again only when
`stack.yaml` changes.

## Filling the database

```sh
infra/aws/backfill.sh            # starts the background ingestion on the instance
infra/aws/backfill.sh --status   # its last log lines
```

ONS takes minutes. Weather is bounded by Open-Meteo's free quota: 10 to 35
hours for the whole window from one address. The loop asks again for what the
quota cut short, an hour later; it never works around the quota.

## Training on the big machine

`train.sh` restores a database dump from the bucket into a scratch Postgres on
CodeBuild's `BUILD_GENERAL1_2XLARGE` (72 vCPU, 145 GB), builds the ml image
from `HEAD`, runs the command given after `--`, and writes the artifacts, the
log and a `timing.json` to `s3://…/training/<run id>/`.

```sh
infra/aws/train.sh --usage
infra/aws/train.sh --run-id f6 --timeout 90 -- python -m wattsteer_ml.retrain …
```

What the big machine buys, measured with `jobs/fit_speed.py` (one fit is
single-threaded by the model configuration):

| | M3 laptop, 8 cores | CodeBuild 2XLARGE, 72 vCPU |
|---|---|---|
| one fit | 13.4–14.9 s | 17.6 s |
| fits in parallel | 8.2 a minute | 110 a minute |

So a run is worth sending there when it has several independent arms, which
`jobs/campaign.sh` runs at once (v2, v3, the DESSEM A/B):

```sh
infra/aws/dump-db.sh
infra/aws/train.sh --run-id campaign-1 --timeout 240 -- sh /jobs/campaign.sh
```

The account does not show participants its spending limit, so the team keeps
its own: `WATTSTEER_TRAIN_BUDGET_MINUTES` (default 480) of this machine,
counted over every build of the project. A run whose timeout would pass it is
refused before it starts.

## Why this shape

- **CloudFormation through the CDK roles.** The participant role cannot run
  instances, pass a role to CodeBuild or push to ECR. The account's CDK
  execution role can create anything, and deploying through it is what the
  workshop's own `cdk deploy` does. Terraform could run in neither event
  account and was removed.
- **Images travel as a tarball through S3,** because nothing here may push to
  ECR. The instance loads them with `docker load`.
- **Built on arm64 in CodeBuild,** like the instance, so nothing is emulated and
  a laptop only uploads a zip.
- **The site password** is in Parameter Store at `/wattsteer/site-password`
  (user `wattsteer`), generated on the first deploy.

## Reading the password

```sh
infra/aws/scripts/aws.sh ssm get-parameter --name /wattsteer/site-password \
  --with-decryption --query Parameter.Value --output text
```
