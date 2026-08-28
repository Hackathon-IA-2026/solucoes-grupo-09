---
id: "005"
title: Provision vtorres/wattsteer and the Railway project
type: wayfinder:task
status: closed
assignee: vitor.torres@sparkshipping.com
blocked_by: []
---

## Question

Nothing to decide. Stand up the accounts and infrastructure the effort needs,
without touching anything Zalytix owns.

- Create the GitHub repo `vtorres/wattsteer`.
- Decide and record how history starts: fresh `init` vs a fork of the template.
  (If this turns out to be contested, it is a decision, not a task — kick it
  back to the map.)
- Create a **new** Railway project named `wattsteer`. Confirm explicitly that
  the existing Zalytix Railway project is untouched — list projects before and
  after.
- Provision Postgres and Redis in it.
- Record in the resolution: repo URL, Railway project id, service ids, and
  where the connection strings live. Later tickets depend on these facts.

**Guard rail:** never run a destructive or mutating Railway operation against
any project other than `wattsteer`.

## Resolution

**Repo** — already set by the dev: `git@github.com:vtorres/WattSteer.git`. Note
the capitalisation differs from the lowercase `vtorres/wattsteer` the map
recorded; GitHub is case-insensitive for routing, so this is cosmetic, but any
tooling that string-matches the repo name should use the real casing.

**Railway** — project `wattsteer`, id `59ea2fab-ae3e-46e9-8985-2e8977097fcb`,
production environment `2a2b7ea1-c079-44b5-bcad-05d42c3a656b`, in workspace
"Vitor Torres's Projects".

| Service | id | State |
|---|---|---|
| Postgres | `9a59458f-dd37-4456-939d-b721e1db05ef` | online, volume `postgres-data` at `/var/lib/postgresql/data` |
| Redis | `33336061-388b-460a-96c3-c99d87bc55f8` | online, AOF on, volume `redis-data` at `/data` |
| api | `a05f08a3-9e6c-494d-b7bb-8a0a02104510` | created, **no source attached** |
| worker | `49681bd2-1b12-4658-b7d2-17be602e844a` | created, **no source attached** |

The **ml** service is deliberately not created — `apps/ml` does not exist yet.
It belongs to **apps/ml scaffold and service topology**.

`api` and `worker` have their variables wired (`DATABASE_URL` and `REDIS_URL`
via Railway reference syntax to the two datastores, plus role, rate limits and
job concurrency) but **no GitHub source attached**, because nothing has been
pushed yet. Attaching a repo triggers an immediate build, which would fail
against a repo without the stripped code. Attach after the first push.

**Credentials live only in Railway service variables** — generated per service,
never written to this repo. Read them with `list-variables` if needed.

**Two things did not work as expected, both worth knowing:**

1. **Railway's MCP cannot provision a managed database.** The dashboard's "Add
   PostgreSQL" flow has no MCP equivalent; `create-service` takes an image and
   the container comes up with none of the connection variables set. Both
   datastores were therefore configured by hand — user, password, database,
   `PGDATA`, and a `DATABASE_URL`/`REDIS_URL` assembled from
   `RAILWAY_PRIVATE_DOMAIN`. Verified by reading the variables back rather than
   assuming.
2. **The Bitnami Redis image no longer exists on Docker Hub** — the deploy
   failed with `The image "docker.io/bitnami/redis:7.2.5" could not be found`.
   Switched to the official `redis:7-alpine` with an explicit start command for
   auth and AOF, and moved the volume mount from `/bitnami` to `/data`.
   Confirmed live from the deploy logs, not from the status field.

**Guard rail honoured.** Every mutating call targeted
`59ea2fab-ae3e-46e9-8985-2e8977097fcb` only. The Zalytix project
(`50348b0a-8546-48d9-9ae2-fff4dbeb9702`) was read once to confirm it still has
its three services, and never written to.

