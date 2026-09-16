# ADR-0009 — which advisories reach a deployed surface

**Status:** accepted · 2026-09-16

## Context

`bun audit` reports **56 vulnerabilities (32 high, 22 moderate, 2 low)**. A
number that size is worse than useless on its own: it is large enough to look
alarming and undifferentiated enough that nobody reads it twice, which is how a
real finding ends up sitting next to fifty build-tool advisories for a year.

So the question this ADR answers is not "how many" but **which of them run
anywhere a stranger can reach**. Three surfaces exist:

1. the **web bundle**, which every visitor's browser executes,
2. the **API process**, which is the only thing on the public network,
3. everything else — Metro, Expo's CLI, `drizzle-kit`, `tsx` — which runs on a
   developer's machine or in a build step and is in no deployed artifact.

## What was found

**The web bundle carries one flagged package, and it is not actually affected.**
`nanoid` appears in the built `entry-*.js` via `expo-router`. Two versions are
installed:

| version | where | in the advisory range (`>=4.0.0 <5.1.16`)? |
| --- | --- | --- |
| `3.3.15` | root, and the one bundled | **no** — below the range entirely |
| `5.1.11` | `@scalar/themes › @scalar/types`, from `@elysiajs/swagger` | yes |

The bundled copy is 3.3.15. The flagged copy is server-side, in the theming
chain behind Swagger UI.

**The API process loads the flagged `nanoid` and not the flagged `hono`.**
`/docs` is mounted and public (verified: `200`), so `@elysiajs/swagger` and its
`@scalar` dependencies are live. Both `nanoid` advisories require the *caller*
to pass a negative or zero `size`; no path through theme rendering takes a size
from a request.

`hono` — which carries the one genuinely serious advisory in the list, *"CORS
Middleware reflects any Origin with credentials when `origin` defaults to the
wildcard"* — arrives only through `@getworkbench/elysia`, the BullMQ dashboard.
That module is behind `await import("./jobs-dashboard.js")` **inside** the
`dashboard.mount` branch, so on a deployment with the flag off the package is
never loaded at all. `/jobs` answers `404` in production, and ADR-0008's guard
now means it cannot mount there without a token even if the flag is set.

**The remaining ~48 are build tooling** — `expo`, `expo-router`,
`expo-splash-screen`, `react-native`, `react-native-worklets`, `drizzle-kit`,
`tsx` — reached through `xmldom`, `js-yaml`, `postcss`, `brace-expansion`,
`browserslist`, `image-size` and `esbuild`. None is in the bundle (checked by
grep against the built file: zero occurrences of each) and none runs in a
deployed service. Several are explicitly about a *development server*.

## Decision

**Nothing is upgraded on this finding.** Not because the advisories are wrong,
but because none of them is reachable, and a broad `bun update` late in a change
set — touching the lockfile for every workspace — is a larger risk to a
deployment than the thing it would fix.

What is recorded instead is the **method**, so the next `bun audit` is triaged
in minutes rather than re-derived:

1. `grep` the built `entry-*.js` for the package name. Zero occurrences means it
   is not in any browser.
2. Find the importer in `apps/api/src`. If the only import is `await import()`
   inside a feature flag that production does not set, it is not in the process.
3. Check the installed version against the advisory range — `bun audit` names
   the workspace that pulls a package, not always the copy that is used, and
   `nanoid` here is two different versions with two different answers.

## Consequences

Re-run this before a release, not on a schedule. The three checks above are the
whole of it, and the answer changes only when a dependency moves between those
three surfaces — which is exactly the event worth noticing.

One thing to watch: `/docs` is public by design, and it is the reason the
`@scalar` chain is in the process at all. If that ever stops being wanted,
removing it takes the only in-range runtime advisory out with it.
