# Gateway routes

`docs/specs/api-surface.md` is the contract. Its **endpoint list is a table you
must add a row to** — `test/spec-claims.test.ts` enumerates the served `/v1`
paths in both directions and fails on a route with no row *and* on a row with no
route, and the two stated counts in the prose must agree with the table. Three
routes once shipped without rows; that is why the check exists.

## The order of a request handler

1. **Parse the axes.** `apps/api/src/api/params.ts` — `civilDayWindow`,
   `instant`, `targetDate`, `gateProfile`, `laneName`. A civil date is resolved
   through `civilDayWindow`, never by adding 24 hours to a UTC midnight: ONS's
   timestamps are Brasília local time and a UTC day is the wrong day by three
   hours every day of the year.
2. **Then reach for the database.** In that order, so a malformed request is a
   400 and not "the service is down". `/v1/grid/context` shipped with the two
   inverted and its own test caught it.
3. **Read**, through `contract/` and the canonical views.
4. **Apply the cache policy.**
5. **Encode the wire body** and return.

## The wire body is built field by field

Against the generated interface from `@wattsteer/core/api`, never by handing the
read's object to the encoder. The schema is `additionalProperties: false`, so a
field the read carries and the contract does not — an ingestion instant, a
window, a data version — is a contract violation you want the *compiler* to
catch rather than a validator at runtime.

`encodeWire("ShapeName", body)` does the snake_case translation from the
generated table. Do not hand-write the mapping: the rule-based one is lossy on
`last24hConstrainedOffMwh` → `last_24h_constrained_off_mwh`.

## A cache key is a provenance, never a duration

`applyCachePolicy(ctx, CACHE_POLICIES.x, [...])` and the third argument is the
provenance: an artifact id, a publication instant, a max data version, the
freshest ingestion instant. Never a clock and never a TTL —
`apps/api/test/cache-policy.test.ts` greps every `etagOf`/`applyCachePolicy`
call site for `Date.now`, `new Date(`, `TTL`, `_SEC`, `maxAge`, and it names the
route files it found, so a route that stops building a validator is a failure
rather than a silence. Add yours to that list.

Pick the policy by what moves the answer: `forecast` for a gated publication,
`now` for something that moves with ingestion, `observedSettled` for a closed
past range, `modelCard` for an artifact.

## Refusals are typed, and the code is the contract

`CodedError(code, message, { details })`, with the code from the closed enum in
`packages/core/src/errors.ts`. The status comes from the code, not from the call
site. `apps/ml` answers `{"error": {"code": …}}` and the gateway re-wraps it,
admitting the **code** into its own enum rather than forwarding the body.

Distinguish the absences. "No forecast was published for this day" and "no model
is promoted" are different sentences with different actions, and
`apps/api/src/api/forecast.ts` deliberately never answers `MODEL_UNAVAILABLE` —
it has no view of the artifact volume and says "see /v1/meta" instead.

An empty answer is **not** automatically a refusal. `/v1/grid/context` answers
200 with every field null, because "neither ONS series covers this day yet" is
the ordinary state of tomorrow, and a 503 there would turn a normal morning into
an error on a screen.

## Adding a route: the checklist

1. Schema in `packages/core/schema/*.json`, then
   `bun run --cwd packages/core generate:types`. Never hand-edit
   `types.generated.ts`.
2. The read in `apps/api/src/contract/`, exported from its `index.ts`.
3. The handler, in the order above.
4. A row in `docs/specs/api-surface.md`'s endpoint list, and both stated counts.
5. If it crosses into `apps/ml`: a reason in `ml-boundary.test.ts`'s `CROSSINGS`.
6. A test that does not need Postgres — the refusals, the shaping, the absence
   branches — plus the round trip in the database suite if it has one.
7. The client method in `packages/core/src/client.ts` and its row in
   `packages/core/test/client-wire-keys.test.ts`.
