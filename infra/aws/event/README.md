# Deploying to the event's AWS instance

The event gives each team one **Code Editor instance** (Graviton, 2 vCPUs,
8 GB) in a Workshop Studio account, and nothing else we can use: no RDS, no
load balancer, no new instances. WattSteer runs there as the `ec2` option's
Compose stack (`../compose/compose.aws.yml`), with the same memory and CPU
ceilings, behind the instance's own proxy at `https://<id>.cloudfront.net/app/8081/`.

One command deploys the **committed `HEAD`** of your checkout:

```sh
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=…
EVENT_PUBLIC_URL=https://<id>.cloudfront.net/app/8081 infra/aws/event/deploy.sh
```

It takes about 15 minutes, most of it the web export.

## Before the first run

- **Docker with `buildx`** (Docker Desktop or OrbStack), `git`, `python3`,
  `openssl`. The AWS CLI runs from its Docker image (`../scripts/aws.sh`).
- **Credentials:** in Workshop Studio, open the event, then *Get AWS CLI
  credentials*, and export the three variables it shows. They expire after a
  few hours; get new ones when a call answers `ExpiredToken`.
- **The public URL:** the Code Editor's address, with `/app/8081` instead of
  the editor's path. Ask in the team channel if you do not have it.

## What it does

1. `git archive HEAD` into a temporary directory. Uncommitted changes and
   `.env` files are never in it.
2. Builds the five images for `linux/arm64`, the web one with
   `EXPO_PUBLIC_BASE_PATH=/app/8081` so the site works under the proxy's path.
3. Uploads the images, the compose file, the Caddyfile and `remote.sh` to a
   new private bucket, and runs `remote.sh` on the instance through SSM.
4. `remote.sh` loads the images, keeps the generated secrets in
   `/opt/wsdemo/.env`, runs the migration and `docker compose up -d`. The data
   in `/opt/wsdemo/data` is never touched.
5. Deletes the bucket, whether the deploy succeeded or not.

## Provider keys

Keys are not in the images and not sent unless you ask. To set or replace
them, put the lines in a file only you can read and pass it:

```sh
EVENT_KEYS_FILE=~/wattsteer-keys.env EVENT_PUBLIC_URL=… infra/aws/event/deploy.sh
```

Only `NVIDIA_API_KEYS`, `GROQ_API_KEYS` (the RAG) and `XAI_API_KEY` (the voice
agent) are read; an empty or missing line leaves the instance's value as it
was. Delete the file afterwards.

## The site password

The whole site is behind basic auth (user `wattsteer`). The password is
generated on the first deploy, printed once in its output, and kept in
`/opt/wsdemo/.site-password` on the instance. `/ingest/*`, `/internal/*` and
`/docs` answer 404 from outside.

## Looking at it

Run a command on the instance, as root, through SSM:

```sh
A=infra/aws/scripts/aws.sh
id=$($A ssm send-command --instance-ids <instance> --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/wsdemo && docker compose --project-name wsdemo --env-file .env -f compose.yml ps"]' \
  --query Command.CommandId --output text)
$A ssm get-command-invocation --command-id "$id" --instance-id <instance> --query StandardOutputContent --output text
```

Swap `ps` for `logs --tail 100 worker`, or `docker stats --no-stream` for
memory. The instance id is the only one SSM manages in the account
(`$A ssm describe-instance-information`); the participant role may not call
`ec2:Describe*`.

## Do not

- **Remove the limits** or run two ingestions at once: without them the
  worker's hourly ingestion (4.7 GB peak) took this instance down on 18/09,
  SSM included, until a reboot.
- **Deploy while someone else is deploying.** Say so in the team channel first:
  the second run replaces the first one's images halfway through.
- **Copy a `.env` or the source tree to the instance.** Only images go.
