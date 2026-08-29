# 05 — The second asset: a shiftable load that always gives the energy back

**What to build:** an operator can add a flexible industrial process — IDEA.md
§31's freezer — to the fleet, and see it move consumption into curtailment hours
and give every shifted MWh back inside its own shift window. "Shifted" never
quietly means "avoided".

The formulation is Zerrahn & Schill's **double-indexed** form, (D1)–(D4) of the
research. It needs no binaries and it conserves the load's daily energy *by
construction*, because every up-shift is compensated by down-shifts within `L`
hours. The double index is not decoration: the single-index formulation permits
"undue recovery", where a down-shift lands arbitrarily far from the up-shift it is
supposed to compensate, and the daily energy still balances.

(D5), the recovery-time constraint, is implemented but **off by default** — emitted
only when an asset supplies `recovery_time_hours`. It is integer-free.

**Shift losses (Zerrahn & Schill's eq. 7′) are not implemented.** A shiftable load
in v1 is lossless; adding `shift_efficiency` later is a coefficient on the left of
(D1) and nothing else.

`daily_energy_mwh` is a **validation input, not a constraint**, and this is the
resolution of IDEA.md §31's `required_daily_energy`. Adding a daily-energy equality
would be redundant against (D1) and would make an infeasible model far harder to
diagnose. What the daily energy buys is the one physical check the formulation
cannot make for itself — a load cannot be shed by more power than it draws. With no
baseline profile supplied the flat baseline is `daily_energy_mwh / 24`, which is
where ticket 04's `SHIFT_EXCEEDS_BASELINE` comes from.

The load enters the coupling sum (C1) as `up[l,t] − down[l,t]` and changes nothing
else: not the common fields, not the transport, not the result shape, not the
simulator, not the KPI definitions. That is the property that makes `EV`,
`DataCentre`, `Electrolyzer` and `HVAC` a new variant plus a new constraint block
later, and it is worth verifying here while there are two variants rather than
asserting it when there are five.

**Blocked by:** 01 (the coupling sum and the objective), 04 (the load's validation
rules).

**Status:** done

- [ ] A battery-and-load fleet solves to `OPTIMAL` and the load's contribution appears in `Δ[t]`
- [ ] Daily energy is conserved to 1e-9
- [ ] A down-shift never lands more than `L` hours from the up-shift it compensates — the "undue recovery" failure the single-index form permits
- [ ] No hour sheds more than the flat baseline `daily_energy_mwh / 24`
- [ ] With `recovery_time_hours` set, (D5) is emitted and binds; with it absent, no (D5) rows exist in the model
- [ ] The dispatch carries `load_shift_up_mw` and `load_shift_down_mw` per hour
- [ ] Adding the variant required no change to the common fields, the transport, the result shape, the simulator or the KPI definitions
