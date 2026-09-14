# 28 — `railway.json` is deprecated and stops working on 2026-12-01

**What to build:** the deployment's configuration in the form the platform will
still read next year.

Found while linking the project to migrate the production database. The Railway
CLI answers every invocation in this repository with:

```
warning: Config as Code (railway.json / railway.toml) is deprecated.
  Prefer Infrastructure as Code (.railway/railway.ts).
  Run `railway config migrate`
  Existing files keep working until 2026-12-01.
```

This repository has **two** such files — `railway.json` at the root and
`apps/ml/railway.json` — and they carry the only deployment configuration that
exists: the `DOCKERFILE` builder, `/health` as the healthcheck path, its 120 s
timeout, and `ON_FAILURE` restart with five retries. Nothing else in the tree
states them.

**Why it matters more here than the date suggests.** Neither service has ever
deployed — `latestDeployment` is null on both `api` and `worker`. So the first
deployment this project ever makes will be made under whichever mechanism is
live at the time, and there is no prior run to compare it against if the
healthcheck path or the builder quietly stops being read. A silent default
would show up as a service that builds and never passes its healthcheck.

## The platform's own path is lossy here — measured, not assumed

`railway config migrate` is the documented route and it was the obvious thing
to prefer over hand-authoring. **It drops 8 of the 13 configured fields.** Run
as a dry-run against this tree, field by field:

| field | root | apps/ml |
|---|---|---|
| `build.builder` = `DOCKERFILE` | **lost** | **lost** |
| `build.dockerfilePath` = `Dockerfile` | — | **lost** |
| `build.watchPatterns` = `["apps/ml/**"]` | — | **lost** |
| `deploy.restartPolicyType` = `ON_FAILURE` | **lost** | **lost** |
| `deploy.restartPolicyMaxRetries` = `5` | **lost** | **lost** |
| `deploy.startCommand` | — | carried |
| `deploy.healthcheckPath` | carried | carried |
| `deploy.healthcheckTimeout` | carried | carried |

The builder and the watch patterns are emitted as *comments* in the generated
TypeScript (`// builder from CaC: "DOCKERFILE"`), which is the migration
telling you it could not express them. The restart policy is not emitted at
all, in any form.

It also names the services wrongly: with two Config-as-Code files it merges
them and derives one name from the **working directory**, emitting
`service("development-gridflex-7e0ba196", …)` — a git worktree, not a service.
The real services are `api` and `worker`.

**The builder loss is not theoretical.** `describe-service` reports the live
`api` service's builder as `RAILPACK` today, not `DOCKERFILE` — because no
source is connected, `railway.json` has never been read by a deployment. So
the first deploy is already at risk of using the wrong builder, and migrating
via the automated path would remove the only written record that `DOCKERFILE`
was ever intended.

**Therefore: do not run `railway config migrate --apply` on this repository.**

## `railway config pull` is the right route, and it was tried

`pull` imports the *live* project rather than translating the local files, and
on this project it produced a faithful snapshot in one command: `Redis` and
`Postgres` with their private-network endpoints and Redis's start command, both
50,000 MB volumes with their usage alerts and `allowOnlineResize`, the
`wattsteer-archive` bucket at `iad`, and `api` and `worker` under their real
names with every variable as `preserve()`.

That matters beyond convenience, because the IaC contract is **"one project
definition, one apply, omit means delete"**. Hand-authoring from the two
`railway.json` files would have declared two services and omitted Postgres,
Redis, both volumes and the bucket — and an apply would then have destroyed
them. `pull` is the only route that starts from everything.

It also confirmed, incidentally, that the `WATTSTEER_ARCHIVE_*` variables set
alongside data-platform 27 are present on both services.

## Three fields have no IaC expression at all

Checked against the DSL reference rather than assumed. `service()` documents
`source`, `build`, `start`, `healthcheck`, `healthcheckTimeout`, `preDeploy`,
`replicas`, `env`, `volumeMounts`, `domains`. It does **not** document:

- `builder: "DOCKERFILE"`
- `restartPolicyType` / `restartPolicyMaxRetries`
- `watchPatterns`

So these are not lost by a careless migration — **they cannot be carried by
any migration**, careful or not. The restart policy in particular is a real
behaviour (`ON_FAILURE`, five retries) with nowhere to live. Before this
migration is finished, someone has to establish whether Railway infers the
Dockerfile builder from the repository, and where a restart policy now
belongs. That question, not the authoring, is the actual work.

## Two more things the pull exposed

- **`apps/ml/railway.json` configures a service that does not exist.** The
  project has `api`, `worker`, `Postgres` and `Redis`; there is no `ml`
  service. That file has never applied to anything.
- **`railway config plan` needs the `railway` npm package** installed at the
  repository root. Adding a dependency and running a plan against production
  are both decisions for whoever owns the deployment, so neither was taken.

**Deliberately not committed: the pulled `.railway/railway.ts`.** It is
faithful to *live state*, which is exactly the problem — the live services have
never deployed, so their live state has no healthcheck, no timeout and no
restart policy, and IaC takes precedence over `railway.json` once present.
Committing it half-authored would silently drop the three deploy settings that
`railway.json` is currently the only record of, which is the failure this
ticket was written about. Regenerate it with `railway config pull` as the first
step of the real migration.

**One thing to check while doing it**, because it is invisible today: the
production services carry `WATTSTEER_ARCHIVE_*` variables referencing the
`wattsteer-archive` bucket through `${{wattsteer-archive.*}}`. Those references
resolve at deploy time and have never been resolved, since nothing has
deployed. The first deployment is also the first test of that wiring, and a
reference that does not resolve leaves custody silently unconfigured — which is
the defect data-platform 26 and 27 exist to prevent, arriving by another route.

**Blocked by:** None for the migration itself. Deploying is a separate
decision.

**Status:** done. `railway config plan` reads *"Your Railway configuration is
already up to date"*, and both `railway.json` files are deleted.

**The ticket's central worry was unfounded, and finding that out took reading
the platform's defaults rather than the importer's output.** The fear was that
`restartPolicyType: ON_FAILURE` would silently revert to `ALWAYS` once Config as
Code stopped being read. It cannot revert: **`ON_FAILURE` *is* Railway's default
policy** (with a maximum of 10 restarts). The platform stores nothing for it and
never reads it back — which is why it is absent from every `get-service-config`
response, and why the importer dropped it.

Declaring it anyway had a cost that took an apply to see. The plan reported
`0 to add, 4 to change, 0 to destroy` and applying it changed nothing, so the
next plan reported the same four. A permanently dirty plan, which would make
`plan --detailed-exit-code` useless as a CI drift gate. The field is now absent
from the authoring file.

What *is* worth stating, and what the importer correctly kept, is
`restartPolicyMaxRetries: 5` — five rather than the platform's ten. That is the
only part of the restart policy this project actually differs from Railway on.

- [x] Both `railway.json` files are translated into the form the platform
      reads. **Not** by `railway config migrate --apply` — the measurement below
      stands — but by `railway config pull` followed by hand-authoring
- [x] The builder, healthcheck path, timeout and restart policy survive, compared
      field by field against live. **The question this ticket was written around
      is answered, and the answer is not the one it assumed**: `restartPolicyType`
      *does* have an IaC expression. `deploy: { restartPolicyType: "ON_FAILURE" }`
      plans cleanly. So does `build: { builder: "DOCKERFILE", dockerfilePath }`,
      via the object form of `build` rather than the string sugar the reference
      documents. Neither is in the DSL reference; both work
- [x] `apps/ml/railway.json` is reconciled — by the service coming to exist. The
      project now has an `ml` service, deployed, healthchecking, with a 50 GB
      volume at `/data`
- [x] Both `railway.json` files are deleted, and the plan stays clean with them
      gone
- [ ] The deprecation warning is gone from a plain CLI invocation. **Still
      present with both files deleted**, so it is not driven by the files: the
      four application services still carry a server-side `propertyFileMapping`
      recording that their *last deployment* was configured by Config as Code.
      It should clear as each redeploys from a tree without one. Nothing live is
      lost by the deletion — every field that mapping carried (builder,
      `healthcheckPath`, timeout, retry count) is stored on the service records
      and now declared in `.railway/railway.ts`
- [x] The archive variable references resolve. `list-variables` renders
      `WATTSTEER_ARCHIVE_*` on both services with real values, so the
      `${{wattsteer-archive.*}}` references are live, not pending

## What the pull got wrong — four findings, each caught by `plan`

The ticket said `pull` "produced a faithful snapshot in one command". It did.
Faithful to live state is not the same as correct, and applying it unedited
would have done four things nobody asked for:

1. **Upgraded both live data stores.** `redis("Redis")` plans `redis:8` and
   `postgres("Postgres")` plans `postgres:18`; live they are `redis:7-alpine`
   and `ghcr.io/railwayapp-templates/postgres-ssl:16`. A major version bump of
   Postgres and Redis as a side effect of a configuration migration. Both are
   now pinned to what is running.
2. **Dropped `ml`'s `source.rootDirectory`.** `get-service-config` reports
   `apps/ml` live; the importer omits it. The ML build context *is* that
   directory. The failure is not hypothetical — `couldn't locate the dockerfile
   at path Dockerfile` is what the service did on its first deploy, before the
   root directory was set.
3. **Dropped `restartPolicyType`,** keeping only `restartPolicyMaxRetries` —
   a retry count without a policy, which is the platform default wearing one.
   Worth noting that the *live service records* do not carry the policy either:
   it has been arriving from `railway.json` at deploy time all along. That is
   precisely the silent revert this ticket predicted, and it was one apply away.
4. **Demonstrated omit-means-delete on itself.** Adding `WATTSTEER_ML_URL` to
   `api` and re-planning produced `- Delete variable api.WATTSTEER_ML_URL`, with
   `! 1 destructive change(s)`. The hazard is real and the plan does catch it.

`railway` is now a root devDependency (`^3.11.0`) — `plan` cannot evaluate the
authoring file without it, and that dependency was the reason this ticket
stopped short the first time.

