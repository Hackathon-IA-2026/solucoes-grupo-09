# Deploy

Railway, project `wattsteer`, environment `production`. Services: `web`, `api`,
`ml`, `worker`, `rag`, plus Postgres and Redis.

## Order

**`rag` → `ml` → `api` → `worker` → `web`**, because the gateway proxies to the
modelling service, the gateway and the worker call the evidence service, and
the web app calls the gateway. Deploying the web first means shipping a client
that asks for routes the gateway does not yet serve.

```
railway up --service <name> --detach
```

Then wait for the deployment to reach a terminal status before the next one. A
failed build does **not** take production down — the previous deployment goes on
serving — so a red build is a reason to read the logs, not to panic.

## Verify in a browser, not with curl

A 200 from `curl` says the HTML was served. It says nothing about whether the
bundle booted. After a web deploy, drive the real page and check for page
errors, then check the routes you changed with their real parameters.

## Traps this repository has already hit

- **`railway domain --service x` with no subcommand *creates* a domain.** Use
  `railway domain list` or the MCP read tools. Creating one on `ml` exposed
  `/internal/*` — the prefix that marks what only the worker may call — to the
  public internet.
- **Cache-mount ids must carry the service's cache key**:
  `id=s/<service id>-<target path>`, with the id a **literal** (Railway rejects
  variables inside a cache-mount id). A plain name fails validation before a
  layer is built. `apps/ml/Dockerfile` documents this at the line that carries
  it.
- **The web image must vendor CesiumJS.** `scripts/vendor-cesium.ts` runs in the
  Dockerfile before `expo export`; Cesium resolves its Workers and assets by URL
  against `CESIUM_BASE_URL`, so bundling it does not work. Skipping the script
  404s `Cesium.js` **in production only**. Build the image locally before
  deploying when the Dockerfile changed.
- **The static server caches HTML at boot.** Re-export, then restart, or you are
  serving the previous build's bundle hash.

## Schedules, after a worker deploy

`apps/api/src/worker.ts` prints what it registered at boot. Confirm it:

| | |
|---|---|
| refresh | live `17 * * * *`, recent `0 3 * * 1`, history `0 4 1 * *` (UTC) |
| retrain | `WATTSTEER_RETRAIN_PATTERN`, currently `10 3 * * 5` — **weekly**, Fridays 03:10 UTC |

A retrain fix therefore waits up to a week for its own proof. Say that rather
than implying the next run is tomorrow.

## Before you deploy

1. `bun run check` and, if Python moved, `bun run check:ml`.
2. `bun run test:e2e` if the web app moved.
3. `git fetch` and confirm `origin/main` is an ancestor of `HEAD`.
4. Push, then deploy from the pushed commit.
5. After: check the routes you changed, in a browser, and report what you
   measured — not what you expect.
