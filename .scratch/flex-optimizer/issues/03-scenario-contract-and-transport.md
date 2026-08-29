# 03 — A scenario is a URL: canonical encoding, one schema, two languages

**What to build:** a user can build a flexibility fleet, share the URL, and the
recipient sees exactly the same scenario — with no account, no persisted record
and no identity invented. A schema change makes an old link fail loudly rather
than parse into a different scenario.

`FlexibilityAsset` is a **sum type discriminated by `asset_type`**, per the domain
model — not one wide struct with mutually-exclusive nullable fields, which is what
stops a `Battery` arriving carrying a `max_shift_mw`. Common to every variant:
`asset_type`, `label`, `subsystem`, `max_power_mw`, `available_from`,
`available_to`. Availability is `"HH:MM"` in `America/Sao_Paulo` on `target_date`,
minutes must be `"00"`, half-open `[from, to)`, defaulting to the whole day.

```jsonc
{
  "v": 1,
  "subsystem": "NE",
  "target_date": "2026-08-29",
  "forecast_origin": "2026-08-28T12:00:00Z",   // optional; latest if omitted
  "assets": [ /* battery | shiftable_load */ ],
  "economic_assumptions": { "brl_per_mwh": 180 }
}
```

**Canonical form** is JCS-style: object keys sorted lexicographically, no
insignificant whitespace, numbers in the shortest round-tripping form, no trailing
zeros. **Transport** is base64url of the canonical UTF-8 bytes, capped at 4096
bytes, carried as `?s=`; the same bytes appear in the `POST` body. The URL is the
storage. `v` is mandatory and an unknown value is rejected — that is the
difference between a shareable URL and a time bomb.

The `Scenario` and `OptimizationResult` shapes live as **one JSON Schema in
`packages/core`**, and both the Elysia side and the ml service assert against it in
their own suites. The prototype's `optimize.ts` types and the ml service's models
drifting apart is the most likely way this engine breaks quietly, because both look
right in isolation.

`packages/core` also gains the single published `REFERENCE_FLEET` constant here.
Floor coverage in the Replay spec and `Δ recovered_floor_mwh` in the Forecaster
spec must be computed against the same battery or neither number means what it
says, and today three surfaces each carry their own copy. Note that the fleet the
Mitigate prototype defaults to is *invalid* under ticket 04's
`SHIFT_EXCEEDS_BASELINE` rule, so the constant is authored in its corrected form
and everything else moves to it.

**Blocked by:** None — can start immediately, in parallel with 01.

**Status:** done

- [ ] A scenario round-trips through canonical encoding → base64url → decode byte-identically
- [ ] The hash is stable under key reordering and under equivalent float spellings (`0.92` vs `0.920`)
- [ ] `v: 2` is rejected; a 5 KB blob is rejected
- [ ] `GET ?s=<blob>` and `POST` with the body decode to the identical canonical bytes
- [ ] A battery carrying `max_shift_mw` does not typecheck and does not parse
- [ ] The schema accepts `EV`, `DataCentre`, `Electrolyzer` and `HVAC` as future variants without any change to the common fields, the transport or the result shape; v1 implements none of them
- [ ] One JSON Schema in `packages/core`; the TypeScript and Python suites both assert against it, and a deliberate drift in either fails
- [ ] `REFERENCE_FLEET` is published once in `packages/core`, in a form that passes ticket 04's validation, and the Mitigate fixture and every aggregate read it rather than restating it
- [ ] `label` is capped at 64 characters and no scenario field ever reaches a query as anything but a bound parameter
