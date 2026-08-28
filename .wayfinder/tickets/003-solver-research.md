---
id: "003"
title: MILP formulation and OR-Tools fit for BESS + shiftable load
type: wayfinder:research
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Is OR-Tools the right solver for the flex-optimizer problem, and what is the
correct formulation?

Establish:

- how to express the BESS dispatch problem from IDEA.md §28–29 — SOC dynamics,
  round-trip efficiency, power limits, the charge/discharge mutual exclusion —
  as an LP or MILP, and whether the mutual exclusion genuinely needs binaries
  or relaxes safely
- how to express a shiftable industrial load (§31): flexible power, maximum
  shift hours, required daily energy
- whether OR-Tools' CP-SAT or its linear solver interface (with CBC/SCIP/HiGHS)
  is the right backend for a 24-period horizon with a handful of assets
- solve time at realistic size, and whether it is fast enough to run
  synchronously inside an HTTP request or must be queued
- the licensing position of each backend for eventual commercial use
- how the optimizer consumes an uncertain forecast: does it optimise against
  P50, or against the P10–P90 band (robust / scenario-based)? Name the options
  and their cost; the choice itself is a decision for the optimizer spec ticket.

Record findings as a Markdown file in the repo and link it from this ticket.

## Resolution

**OR-Tools is right, but via `pywraplp` (linear solver) with **SCIP** as the MILP
backend — not CP-SAT.** CP-SAT is integer-only; the SOC balance with a fractional
round-trip efficiency turns into a divisibility constraint and returns a silently
wrong dispatch (measured: 230 MWh remaining vs the MILP's 95).

**The charge/discharge mutual exclusion does NOT relax safely here.** Exactness of
the LP relaxation is price-dependent, and a curtailment-absorption objective is
exactly the zero/negative-price regime where it fails (Chen & Baldick Thm 1; Duan
et al. Cond. 1). Measured: with no degradation cost the LP overstates recovered
energy by 16 %, charging and discharging simultaneously in 5 of 6 curtailment
hours. It becomes exact only once `c_deg > c_curt·k/(2+k)`, `k = (1−RTE)/RTE`
(≈ 0.042·c_curt at RTE 0.92) — a weight nobody has pinned yet. **Ship the binaries**
(one per battery per period); the MILP costs 3.15 ms against the LP's 0.25 ms.

The shiftable load needs **no binaries** — Zerrahn & Schill (2015) eqs. 7–11 give a
fully linear model whose down-shift double-index enforces `maximum_shift` honestly
and conserves daily energy by construction.

**Solve time is a non-issue: 3 ms at real size, 34 ms at 10 BESS + 10 loads.**
Run it synchronously in the HTTP request with a time limit; no queue.
**Licensing is clean** — OR-Tools and SCIP ≥ 8.0.3 are Apache 2.0, HiGHS is MIT.
Avoid CBC (EPL, plus it aborts the process on duplicate variable names).

Forecast uncertainty options (P50 / conservative P10 / robust budget-Γ /
scenario-based) are laid out with their costs but **deliberately not chosen** —
all four fit the same model and the same latency budget. That choice is ticket 011.

Full findings, with the actual formulation, primary-source quotes and every
measurement: [`docs/research/optimizer-formulation.md`](../../docs/research/optimizer-formulation.md)
