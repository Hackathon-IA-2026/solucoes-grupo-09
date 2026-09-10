# WattSteer

**Renewable curtailment intelligence for the Brazilian grid.** Predict how much
wind and solar will be curtailed tomorrow, explain the grid conditions driving
it, and size the storage and flexible demand that could absorb it — from
openly published ONS, ANEEL and weather data.

> **Status: early.** The repository was rebuilt from a template; the previous
> product's domain has been removed and WattSteer's is being specified. The API
> serves health and readiness, the web app renders its shell, and no product
> feature exists yet. See `.wayfinder/map.md` for the plan.

## Monorepo layout

Bun workspaces, split by responsibility:

```
apps/
  api/    Gateway + ingestion: the public HTTP API and the scheduled jobs that
          pull ONS, ANEEL and weather data into Postgres.
          (Elysia, BullMQ, Drizzle/Postgres.)
  web/    The product frontend: Expo (React Native) universal app —
          static-rendered SEO web build, plus iOS/Android from the same code.
packages/
  core/   The shared domain: the vocabulary (`domain.ts`), the published
          constants (`constants.ts`) and the cross-language golden vectors in
          `fixtures/`, which `bun test` and `pytest` both enumerate.
          Pure TypeScript, zero UI deps.
  ui/     The design system: tokens, brand, icons and primitives.
```

A Python service (`apps/ml`) for feature engineering, model training, inference
and the flexibility optimizer joins this layout later; it reads Postgres and is
reached only through the API gateway.

## Quick start

```bash
bun install

# 1. the API (defaults to http://localhost:3000)
bun run api

# 2. the web app (Expo dev server; press w for web)
bun run web
```

Point the web app at a different API with `EXPO_PUBLIC_API_URL`.

## Scripts (repo root)

| Script | What it does |
| --- | --- |
| `bun run api` / `api:dev` / `worker` | Run the API / watch mode / BullMQ worker |
| `bun run web` | Expo dev server |
| `bun run web:export` | Static web build (SEO-ready) to `apps/web/dist` |
| `bun run test` | Unit tests: core + api + web |
| `bun run test:e2e` | Playwright e2e (exported web bundle) |
| `bun run test:live` | Live conformance against the real ONS / ANEEL / Open-Meteo sources (gated, scheduled) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run lint` | Biome |
| `bun run docker:up` | Postgres + Redis + API + worker via compose |
| `bun run preflight` | Refuse to start work on a base behind `origin/main` (fetches) |

## The base guard

A ticket branched behind the tip is the one defect no test in this repository
can see. It typechecks, lints, passes its own suite — and then merges a
regression back over work it never saw. `scripts/preflight-base.ts` decides that
question and refuses; `bun run preflight` asks it by hand about the worktree you
are standing in.

Asking by hand is not a guard, so the merge is gated:

- **`.githooks/`** holds `pre-merge-commit` and `pre-commit`, both of which run
  the same check against the *incoming* head — not `HEAD`, because merging a
  current branch into a local `main` that has drifted is harmless and a gate
  that fires on the harmless case gets switched off. `pre-commit` is inert
  except when a merge is in progress, which is the path git takes when the merge
  conflicted and `pre-merge-commit` never ran.
- **`core.hooksPath`** points git at that tracked directory, because
  `.git/hooks` is not committed and a hook written there enforces nothing for
  the next clone and nothing for anyone else.
- **`postinstall`** sets it (`scripts/install-hooks.ts`), so the gate arrives
  with `bun install` rather than with a paragraph in a README asking you to
  install it.

### Why a hook and not a documented step: observed, not hypothesised

On 2026-09-09 four agents were started in parallel. Their worktrees were created
from the local `main` ref rather than from the development tip, and **three of
the four began on a stale base.** One noticed unprompted; two had to be told.
`bun run preflight` existed at the time and none of them ran it. That is the
argument against leaving this as a step in a README or a lane document: the
mechanism has to be the one that runs whether or not anybody remembered it.

The same incident says something less comfortable about *where*, and it is
recorded here rather than smoothed over:

- **The stale base was created at worktree-creation time**, not at commit or
  check time. That is the earliest point a refusal would help, and it is not
  reachable from this repository. `post-checkout` does fire on `git worktree
  add`, but its exit status is ignored — the worktree already exists — so it can
  warn and cannot refuse. What actually chose those bases is harness
  configuration outside the repo. The merge is therefore the earliest point
  where a *refusal* is possible, which is why the gate is there.
- **`origin/main` is not currently the ref that matters.** On that day the tip
  work was landing on was a local development branch nine commits *ahead* of
  `origin/main`. So the guard answered `ok` for a base that was nine commits
  behind the real tip — correctly, by its own contract, and uselessly. The
  contract, not the enforcement, is the weak part: **this gate would not have
  caught that incident.** The candidate fix is for the merge gate to also
  require the incoming head to contain the branch it is being merged *into*,
  which needs no remote and no configuration because git already knows the
  target. It is not done here because it is a stricter property than the one
  898c6b1 specified, and it would serialise parallel merges behind a rebase
  each — a workflow decision, not a code one. Whoever owns the integration
  branch should make it deliberately.

### The tradeoffs this accepts, in plain terms

**`bun run check` was deliberately left alone.** It is the natural place to put
a guard and it is the wrong one: `check` runs dozens of times during a ticket,
takes about thirteen seconds, and works with no network — an invariant the
scheduled workflows are written around too. A fetch inside it would either fail
closed, making every offline commit impossible, or fail open, which is worse
than absent: the guard would report its healthiest verdict at the moment it read
nothing, the exact vacuity failure it was written against. So `check` stays
offline and the network check lives at the merge, which happens once and is the
moment the harm occurs.

**A hook only binds clones that ran `bun install`.** That is nearly everyone
here, and the wiring is committed and tested rather than living in one person's
`.git/hooks` — but it is not the same guarantee as a server-side check. There is
no CI on push or pull request in this repository (the three workflows are
scheduled and deliberately never run on push), so nothing today would catch a
stale base pushed from a clone with the gate uninstalled. If that flow ever
appears, this belongs there too.

**`core.hooksPath` is relative to each worktree, and it supersedes
`.git/hooks`.** Two consequences worth knowing. Nothing in `.git/hooks` runs any
more — no loss today, since this repository has never committed one. And a
worktree checked out at a commit from *before* this one has no `.githooks/`
directory in its tree, so it has no gate: git looks, finds nothing and says
nothing. That is the same class of blind spot as the stale base itself, and the
only cure is the tip reaching every worktree, which is what the guard is for.

**`git merge --no-verify` still bypasses it, by design.** So does deleting
`core.hooksPath`. The gate is a guard against forgetting, not against intent,
and a refusal that cannot be overridden gets removed the first time it is wrong.

**It fails closed, including when it cannot run.** No network, no readable ref,
no `bun` on `PATH`, no identifiable incoming head: each is a refusal. A gate that
waves the merge through whenever it could not do its job is not a gate.

## Testing

- **`packages/core`** — formatting helpers. `bun test`.
- **`apps/api`** — the surviving plugin-stack and job-runner suites: error
  mapping, rate limiting, security headers, body limit, CORS, request
  correlation, and both job runners. The BullMQ suite needs a throwaway Redis
  (`bun run test:redis`).
- **Live conformance** — `apps/api/test/live-conformance.test.ts`, gated on
  `WATTSTEER_LIVE_CONFORMANCE` and scheduled daily in CI. It talks to the real
  sources and asserts they still look the way `docs/research/` found them; a
  failure names the expired assumption in prose. It never runs in the default
  test path.
- **Publication-lag conformance** — `apps/api/test/publication-lag-conformance.test.ts`,
  gated on `WATTSTEER_PUBLICATION_LAG_CONFORMANCE` (`bun run test:lag`) and
  scheduled separately. Measures the real publication lag of every observation
  dataset against the constants the feature layer's migrations seed, and the
  day-ahead programme's availability relative to each gate. It reports in the
  same vocabulary (`apps/api/test/support/conformance.ts`) and publishes its
  numbers even when it passes; findings live in
  `docs/research/publication-lag.md`. It never runs in the default test path.
- **`apps/web`** — legal table-of-contents unit tests, plus a Playwright e2e
  suite covering the footer and legal pages against the real exported bundle.
  Run `bun run web:export` before `bun run test:e2e`.

## Data sources

ONS Dados Abertos (constrained-off, balanço energético, load, interchange,
DESSEM), ANEEL SIGA (plant coordinates), and Open-Meteo (weather). Their exact
shapes, traps and licensing are documented in `docs/research/`.
