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
`.railway/railway.ts` should be authored so that all thirteen fields survive,
with the emitted file used only as a starting shape.

**One thing to check while doing it**, because it is invisible today: the
production services carry `WATTSTEER_ARCHIVE_*` variables referencing the
`wattsteer-archive` bucket through `${{wattsteer-archive.*}}`. Those references
resolve at deploy time and have never been resolved, since nothing has
deployed. The first deployment is also the first test of that wiring, and a
reference that does not resolve leaves custody silently unconfigured — which is
the defect data-platform 26 and 27 exist to prevent, arriving by another route.

**Blocked by:** None for the migration itself. Deploying is a separate
decision.

**Status:** ready-for-agent — the automated path is measured and rejected; the authoring is not done

- [ ] Both `railway.json` files are migrated to the form the platform reads.
      **Not** by `railway config migrate --apply`: measured above, it drops 8
      of 13 fields and misnames the services
- [ ] The builder, healthcheck path, timeout and restart policy survive the
      migration, compared field by field against the originals
- [ ] The deprecation warning is gone from a plain CLI invocation, which is the
      observable that says it took
- [ ] The archive variable references are confirmed to resolve, or the way they
      would be confirmed at first deploy is written down
