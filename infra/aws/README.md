# WattSteer on AWS

Terraform for running WattSteer on AWS, with one deploy command. It adds
nothing to the Railway deployment and changes none of it: Railway keeps
running from `.railway/railway.ts` as before.

Two options, because we do not know yet what the event's AWS account allows:

| | **`ecs`** (preferred) | **`ec2`** (fallback) |
|---|---|---|
| Shape | One ECS Fargate service per app: `web`, `api`, `worker`, `ml`, `rag`. The closest match to Railway. | One Graviton instance running the same containers with Docker Compose, next to a Postgres and a Redis container. |
| Postgres | RDS Postgres 16 (pgvector), deletion-protected | `pgvector/pgvector:pg16` container on the data volume |
| Redis | ElastiCache | `redis:7-alpine` container on the data volume |
| Volumes (`ml-models`, `rag-store`) | EFS | directories on the data volume |
| Entry point | Application Load Balancer | Caddy on the instance (automatic HTTPS with a domain) |
| Needs these services | ECS, ECR, RDS, ElastiCache, EFS, ELB, EC2 (VPC), IAM, SSM, S3, CloudWatch Logs, Cloud Map | EC2, EBS, ECR, IAM, SSM, S3 |

Each option has its own name prefix (`wattsteer` and `wattsteer-ec2`), so
falling back from one to the other in the same account creates a second set
of resources instead of colliding with the first.

**The event's account allows neither.** Measured on 18/09/2026: no RDS,
ElastiCache, ALB, VPC or new instances. What runs there is the `ec2` option's
Compose stack on the Code Editor instance the event provides, deployed with
`event/deploy.sh` — see [`event/README.md`](event/README.md). That is the one
to use during the event.

Both route the same way: `/v1/*`, `/ready`, `/ingest/*` and `/docs` go to the
API, everything else to the site. They share the network, registry and storage
modules. Choose on the day by trying `ecs` first; if the account refuses a
service, use `ec2`.

## What is where

```
infra/aws/
  bootstrap/        run once per account: the S3 bucket for the Terraform state
  modules/          network (VPC), registry (ECR), storage (archive bucket, secrets)
  ecs/              option 1: ECS Fargate + RDS + ElastiCache + EFS + ALB
  ec2/              option 2: one instance + Compose
  compose/          the EC2 stack (compose.aws.yml, Caddyfile, up.sh)
  event/            the event's Code Editor instance: deploy.sh, remote.sh, Caddyfile
  docker/           migrate.Dockerfile: the database migration as an image
  scripts/          deploy.sh (the one command), set-secrets.sh, guard_plan.py,
                    tf.sh and aws.sh (Terraform and the AWS CLI, in Docker)
  sim/              the local simulation (no AWS account needed)
```

Nothing is installed on your machine: Terraform and the AWS CLI run from their
official Docker images through `scripts/tf.sh` and `scripts/aws.sh`. You need
Docker (with `buildx`, which Docker Desktop has), `git`, `python3` and `curl`.

## Safety: what stops an accident

- **Every apply goes through a saved plan, and the plan is checked.**
  `scripts/guard_plan.py` stops the deploy if the plan would delete or replace
  anything, and lists what. A normal deploy only creates and updates. The only
  way past is `--allow-destroy`, which you should never need.
- **The stateful resources refuse deletion inside Terraform**
  (`prevent_destroy`): the RDS database (also `deletion_protection` and a final
  snapshot), the archive bucket, the EFS file system, the EC2 data volume, and
  the state bucket. A plan that would delete one fails before anything runs.
- **Image repositories refuse deletion while they hold images.**
- **There is no destroy script.** Tearing down is a deliberate, manual job
  (see "Tearing down" below).
- **Your keys stay out of git and out of the Terraform state.** You put the
  provider keys in SSM with `scripts/set-secrets.sh`; Terraform only creates
  placeholders and never reads or overwrites them. The deploy refuses to
  continue while a required one is unset.
- **The credentials Terraform generates are in its state**: the database
  password, the archive key pair and the RAG access token. So the state is a
  secret: it lives only in the private, encrypted, versioned state bucket, and
  only people allowed to deploy should be able to read that bucket.
- **The API's archive key pair cannot rewrite `deploy/`**, the files the `ec2`
  instance runs as root.
- **The deploy asks you to type `deploy`** after showing the account and region
  it is about to touch.
- **The state is locked** (S3 lock file), so two people cannot apply at once.

## On the day: from zero to running

You need an AWS identity that can create the resources in the table above.

### 1. Credentials

Whatever the event hands out, make it visible to the AWS CLI in your shell:

```bash
# an access key pair
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1
# (add AWS_SESSION_TOKEN=... if it is temporary)

# or a profile in ~/.aws
export AWS_PROFILE=hackathon AWS_REGION=us-east-1

infra/aws/scripts/aws.sh sts get-caller-identity   # must print the event's account
```

`deploy.sh` passes `AWS_REGION` on to Terraform, so the region is set in one
place. Run `bootstrap/` with the same region (`export TF_VAR_region=$AWS_REGION`).

### 2. State bucket (once per account)

```bash
infra/aws/scripts/tf.sh bootstrap init
infra/aws/scripts/tf.sh bootstrap apply          # review, type yes
cp infra/aws/backend.hcl.example infra/aws/backend.hcl
# put the printed state_bucket name (and the region) in infra/aws/backend.hcl
```

`bootstrap/` keeps its own tiny state in `infra/aws/bootstrap/terraform.tfstate`
(git-ignored). Keep that file; it is how Terraform knows it created the bucket.

### 3. First deploy (it stops at the secrets, on purpose)

```bash
infra/aws/scripts/deploy.sh ecs        # or ec2
```

It creates the network, the image registry, the archive bucket and the secret
placeholders, then stops with `still unset: /wattsteer/NVIDIA_API_KEYS ...`
(`/wattsteer-ec2/...` for `ec2`).

### 4. Secrets

Write a file **outside the repository** with the keys, one per line:

```
NVIDIA_API_KEYS=nvapi-...,nvapi-...
GROQ_API_KEYS=gsk_...
XAI_API_KEY=xai-...                   # optional: voice
EXPO_PUBLIC_CESIUM_ION_TOKEN=...      # optional: the 3D map's imagery
```

```bash
infra/aws/scripts/set-secrets.sh ecs ~/wattsteer-secrets.env   # or ec2
```

Only those four names are read; a copy of a larger `.env` is safe to pass.
The database password, the archive key pair and the RAG access token are
generated by Terraform. For voice on the `ecs` option, also
`export TF_VAR_enable_voice=true`.

### 5. Deploy

```bash
infra/aws/scripts/deploy.sh ecs        # the same option as in step 3
```

It builds the five images for arm64 (the slowest step, above all the first time),
pushes them, runs the migration, rolls out every service and waits until the
site and `/v1/meta` answer. It ends with the address:

```
deployed 3569aa1f0c2e → http://wattsteer-123456789.us-east-1.elb.amazonaws.com
```

The first boot of `rag` builds the document corpus in the background (downloads
plus the embedding calls). The site is usable before that.

Every later deploy is just step 5 again, from the commit you want live.
`deploy.sh <option> --plan` shows what would change and touches nothing.

### Optional: a domain with HTTPS

- `ecs`: request an ACM certificate for the domain, then
  `export TF_VAR_certificate_arn=arn:aws:acm:... TF_VAR_public_url=https://your.domain`,
  point the domain (CNAME) at the load balancer, and deploy.
- `ec2`: `export TF_VAR_site_address=your.domain`, point the domain (A record)
  at the instance's public IP (`public_ip` output), and deploy. Caddy obtains
  the certificate by itself.

The site's address is built into the web image, so changing it means running
the deploy again.

## Rehearse locally, without AWS

```bash
infra/aws/sim/simulate.sh              # both options (most of the time is image builds)
infra/aws/sim/simulate.sh ecs          # one option
```

It runs the real `deploy.sh` against [Moto](https://github.com/getmoto/moto),
an open-source AWS simulator, on a Docker network with no route to the
internet (so nothing can reach real AWS by mistake), and then runs the
containers:

1. applies `bootstrap/`, and keeps the state in the simulated bucket, as on the day
2. the first deploy must stop at the secrets check; it sets fake secrets and
   deploys again, which must finish
3. `ecs`: reads the task definitions Terraform registered back from the
   simulator and starts each container in Docker with exactly their image,
   command, environment, secrets and service names; runs the migration task;
   checks `web`, `api`, `ml`, `rag` answer on their health endpoints, the
   gateway's `/ready`, and that the worker keeps running
   (`sim/run_task_defs.py`)
4. `ec2`: downloads the compose file, Caddyfile and settings Terraform uploaded
   to the simulated bucket, builds the secrets file from the simulated SSM (as
   `up.sh` does on the instance), runs the migration and the stack, and checks
   the site and the API through Caddy (`sim/smoke.sh`)
5. a second plan must delete and replace nothing

What the simulation cannot show: that the event's account allows these
services, real IAM permission checks, Fargate pulling from ECR, the load
balancer's path routing (Caddy's identical routing is tested instead), and the
RAG indexing with real provider keys (turned off in the simulation so fake keys
never reach NVIDIA or Groq). Known simulator echoes: Moto does not store a few
attributes, so the second plan shows six in-place updates
(`availability_zone_rebalancing` and the health-check grace period on the ECS
services, the ElastiCache security groups). They are not drift on real AWS.

CI runs the same simulation on every change under `infra/aws`
(`.github/workflows/infra-aws.yml`), plus `terraform fmt`, `validate`, `tflint`,
`shellcheck` and the plan guard's test.

## Deploy from GitHub

`.github/workflows/deploy-aws.yml` runs `deploy.sh` from the Actions tab, by
hand only (`plan_only` is on by default). Create an environment named `aws`
(Settings → Environments), add a required reviewer if you want approval, and
set: secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or
`AWS_ROLE_ARN` for OIDC), variables `AWS_REGION` and `TF_STATE_BUCKET`. Steps 2
and 4 above still run once from a laptop.

## Operating

| | `ecs` | `ec2` |
|---|---|---|
| Logs | CloudWatch Logs, group `/wattsteer/<service>` | `aws ssm start-session --target <instance_id>`, then `sudo docker compose -p wattsteer logs -f <service>` in `/opt/wattsteer` |
| Stop everything, keep all data | `export TF_VAR_desired_count=0`, deploy | stop the instance in the console |
| Roll back | deploy an older commit (`git checkout <sha>`, step 5) | same |

## Tearing down

Deliberately not scripted. Everything holding data is protected, so a teardown
is: take a final RDS snapshot or `pg_dump`, remove the `prevent_destroy` and
`deletion_protection` lines by hand in a branch nobody merges, then
`infra/aws/scripts/tf.sh <option> destroy`. Do it only with the team's
agreement.
