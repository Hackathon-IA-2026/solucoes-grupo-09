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
