# 02 — One error envelope, one closed set of codes

**What to build:** every failure this API can produce arrives in the same shape,
carrying a stable identifier the client can translate. Today there are three
shapes on one surface — the typed envelope, the framework's native validation
body, and a bare `{ error: "Not found" }` string — and the one most likely to
need machine-readable detail is the one that escapes the envelope.

```jsonc
{ "error": {
    "code": "SHIFT_EXCEEDS_BASELINE",
    "message": "max_shift_mw (70) exceeds daily_energy_mwh / 24 (50).",
    "details": { "field": "assets[1].max_shift_mw", "limit": 50 },
    "request_id": "1f2c…"
} }
```

- **`code` is a stable identifier from a closed enum**, published in the shared
  package. Never translated, never reworded, never removed without a version
  bump. The client renders a translation key built from the code.
- **`message` is English developer prose and is never shown to a user.** It is
  for logs and for the docs page. A client that renders it has a bug, and the
  copy checks should look for it.
- **`details` is optional and typed per code**, carrying the field path for a
  validation failure and the limit that was exceeded.
- **`request_id` echoes the request id the gateway already assigns**, so a
  user-reported failure is one grep.

Four concrete corrections: the error status union needs **404, 413, 422 and 429**
as well as what it has; the error type needs a `code`; the handler must stop
returning early on validation failures and keeping the framework's native body,
mapping it into the envelope with its field path preserved; and the not-found
path must stop returning the old string shape.

The code table is the union of the optimizer's eighteen validation codes,
Replay's five refusals, and the ones this surface adds:
`SUBSYSTEM_UNKNOWN` (422), `TARGET_DATE_OUT_OF_RANGE` (422),
`DATE_RANGE_TOO_LARGE` (422), `GATE_PROFILE_UNKNOWN` (422),
`LOCALE_UNSUPPORTED` (422), `FORECAST_NOT_YET_PUBLISHED` (404),
`FORECAST_UNAVAILABLE` (404), `MODEL_UNAVAILABLE` (503),
`DIAGNOSIS_UNAVAILABLE` (404), `OPTIMIZER_UNAVAILABLE` (502),
`DATA_UNAVAILABLE` (503), `RATE_LIMITED` (429), `PAYLOAD_TOO_LARGE` (413).

**This ticket adds user-facing copy** — one translation key per code, in both
locales, Portuguese first. The hardcoded-string guard applies: no error sentence
is ever written inline in a screen.

This is a breaking change to every route that ships today, which is why it goes
early: the surface has no consumers yet, and this is the cheapest moment it will
ever be.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Every error response, including validation failures and not-found, uses the one envelope
- [ ] The code enum is closed, published in the shared package, and importable by both the gateway and the web app
- [ ] The framework's native validation body never reaches a client; its field path survives in `details`
- [ ] A 429 keeps `Retry-After` and uses the envelope
- [ ] Every 5xx logs server-side and leaks no internal detail to the client
- [ ] One test per code asserting the envelope, the status, and that the code is a member of the closed enum
- [ ] Each code has a translation key in both locales and the hardcoded-string guard passes
- [ ] The developer `message` is asserted never to be rendered by any screen
