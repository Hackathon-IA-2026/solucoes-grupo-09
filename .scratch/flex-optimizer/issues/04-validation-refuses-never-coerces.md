# 04 — A nonsensical scenario is refused, never quietly corrected

**What to build:** an invalid fleet comes back with a specific, typed reason before
any model is built — and never as a plausible plan for a battery the user did not
describe.

Validation runs in the **Elysia gateway, before the request reaches the solver**,
because model construction (not solving) dominates the request and a rejected
scenario should never build one. It is re-asserted in the ml service, which trusts
nothing it did not validate itself. **Nothing is coerced.** A clamped input
produces a plan for an asset the user did not describe, which is the same class of
error the data-platform spec already ruled out.

| Code | Rule |
|---|---|
| `SCENARIO_VERSION_UNSUPPORTED` | `v` is not `1` |
| `SCENARIO_TOO_LARGE` | encoded blob > 4096 bytes, or > 20 assets |
| `ASSET_TYPE_UNKNOWN` | `asset_type` ∉ {`battery`, `shiftable_load`} |
| `SUBSYSTEM_MISMATCH` | an asset's `subsystem` ≠ the scenario's |
| `FIELD_NOT_ON_VARIANT` | a field belonging to the other variant is present |
| `MAGNITUDE_OUT_OF_RANGE` | `max_power_mw` ∉ (0, 10 000]; `energy_capacity_mwh` ∉ (0, 100 000]; `daily_energy_mwh` ∉ (0, 100 000] |
| `RTE_OUT_OF_RANGE` | `round_trip_efficiency` ∉ [0.50, 1.00) |
| `EFFICIENCY_PAIR_INCOMPLETE` | exactly one of `charge_efficiency` / `discharge_efficiency` given, or either given alongside `round_trip_efficiency` |
| `SOC_BOUNDS_INVALID` | not `0 ≤ min_state_of_charge < max_state_of_charge ≤ 1` |
| `SOC_INITIAL_OUT_OF_BOUNDS` | `initial_state_of_charge` outside `[min, max]` — an error, never a clamp |
| `POWER_LIMIT_INCONSISTENT` | `max_charge_mw` or `max_discharge_mw` > `max_power_mw` |
| `SHIFT_EXCEEDS_CONNECTION` | `max_shift_mw` > `max_power_mw` |
| `SHIFT_EXCEEDS_BASELINE` | `max_shift_mw` > `daily_energy_mwh / 24` |
| `SHIFT_WINDOW_OUT_OF_RANGE` | `shift_window_hours` ∉ [1, 8] |
| `RECOVERY_TIME_OUT_OF_RANGE` | `recovery_time_hours` present and ∉ [1, 24] |
| `AVAILABILITY_INVALID` | not `"HH:00"`, or `to ≤ from` |
| `TARGET_DATE_OUT_OF_RANGE` | before the data window opens (2024-04) or after tomorrow |
| `FORECAST_UNAVAILABLE` | no forecast exists for that subsystem/date/origin |
| `ECONOMIC_ASSUMPTION_OUT_OF_RANGE` | `brl_per_mwh` ∉ (0, 10 000] |

The magnitude caps exist because the endpoint is public and unauthenticated. They
are an order of magnitude above any real Brazilian BESS; their job is to bound the
solver, not to model the market. Every code is bilingual at the UI layer: **the API
returns codes, never translated strings.**

**Blocked by:** 03 — the sum type and the canonical decode are what these rules run
against. `FORECAST_UNAVAILABLE` needs 07 to be exercised end to end; the code and
its shape are defined here.

**Status:** done

- [ ] One test case per code, each asserting rejection rather than coercion
- [ ] An out-of-bounds `initial_state_of_charge` is a `422`, not a clamp
- [ ] One half of an efficiency pair is a `422`; `round_trip_efficiency` alongside either half is a `422`
- [ ] The prototype's 70 MW-shift / 1200 MWh-per-day load is a `422` under `SHIFT_EXCEEDS_BASELINE`, and the fixture moves rather than the rule
- [ ] A scenario rejected at the gateway never reaches the ml service, and the same blob is independently rejected by the ml service when posted directly
- [ ] Responses carry codes; no translated string crosses the API boundary
- [ ] A mixed-subsystem scenario is rejected, never summed
