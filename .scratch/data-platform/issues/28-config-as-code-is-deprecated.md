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

`railway config migrate` is the platform's own path and should be preferred to
hand-writing `.railway/railway.ts`.

**One thing to check while doing it**, because it is invisible today: the
production services carry `WATTSTEER_ARCHIVE_*` variables referencing the
`wattsteer-archive` bucket through `${{wattsteer-archive.*}}`. Those references
resolve at deploy time and have never been resolved, since nothing has
deployed. The first deployment is also the first test of that wiring, and a
reference that does not resolve leaves custody silently unconfigured — which is
the defect data-platform 26 and 27 exist to prevent, arriving by another route.

**Blocked by:** None for the migration itself. Deploying is a separate
decision.

**Status:** ready-for-agent

- [ ] Both `railway.json` files are migrated to the form the platform reads,
      by `railway config migrate` rather than by hand where possible
- [ ] The builder, healthcheck path, timeout and restart policy survive the
      migration, compared field by field against the originals
- [ ] The deprecation warning is gone from a plain CLI invocation, which is the
      observable that says it took
- [ ] The archive variable references are confirmed to resolve, or the way they
      would be confirmed at first deploy is written down
