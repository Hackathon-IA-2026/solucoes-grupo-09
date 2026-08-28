# Flex-optimizer: MILP formulation and solver choice

**Question** (ticket [003](../../.wayfinder/tickets/003-solver-research.md)). Is OR-Tools the right solver for the flex-optimizer, and what is the correct formulation for a BESS plus shiftable industrial load over a 24-hour day-ahead horizon?

**Research date: 2026-08-28.** Every solve time and every solver-availability claim below was measured on this date against **OR-Tools 9.15.6755** (the current PyPI wheel), CPython 3.9.6, on an **Apple M5 / 10 cores / macOS 26.5**. The benchmark scripts are reproduced inline so the numbers can be re-run.

---

## The short answer

1. **OR-Tools is the right library**, but through its **linear-solver wrapper (`ortools.linear_solver.pywraplp`)**, not CP-SAT. CP-SAT is an integer solver; the SOC balance with a fractional round-trip efficiency does not survive the trip to integers (measured failure below).
2. **Use SCIP as the MILP backend, HiGHS as the fallback.** Both ship in the PyPI wheel and both are permissively licensed. CBC also ships and is fast here, but it is the one backend that *crashed the process* during this research.
3. **The charge/discharge mutual exclusion does *not* relax safely under a curtailment-absorption objective.** This is the load-bearing finding and it contradicts the usual "with efficiency losses you don't need the binaries" folklore. It relaxes safely only once a battery-throughput (degradation) cost exceeding a computable threshold is present. Both the theory and the measurement are below.
4. **Solve time is a non-issue at WattSteer's size.** 24 periods with a handful of assets is a **3 ms MILP**. Even 10 batteries + 10 flexible loads over 24 periods solves in **34 ms**. Run it synchronously inside the HTTP request, with a time limit and a queue fallback that will essentially never fire.
5. **The shiftable load needs no binaries at all** — there is a published, fully linear formulation (Zerrahn & Schill 2015) that does exactly what IDEA.md §31 asks for.

---

## 1. Which solvers actually exist in the OR-Tools Python wheel

The set of backends OR-Tools *can* wrap and the set it *ships* are different. The canonical list of accepted `solver_id` strings is in the header of the linear solver ([`ortools/linear_solver/linear_solver.h`, `MPSolver::CreateSolver` docstring](https://github.com/google/or-tools/blob/stable/ortools/linear_solver/linear_solver.h)):

> ```
>  * solver_id is case insensitive, and the following names are supported:
>  *   - CLP_LINEAR_PROGRAMMING or CLP
>  *   - CBC_MIXED_INTEGER_PROGRAMMING or CBC
>  *   - GLOP_LINEAR_PROGRAMMING or GLOP
>  *   - BOP_INTEGER_PROGRAMMING or BOP
>  *   - SAT_INTEGER_PROGRAMMING or SAT or CP_SAT
>  *   - SCIP_MIXED_INTEGER_PROGRAMMING or SCIP
>  *   - GUROBI_… / CPLEX_… / XPRESS_… / GLPK_…
> ```

Note that **`HIGHS` is missing from that docstring but is nevertheless supported** — the `OptimizationProblemType` enum in the same header carries `HIGHS_LINEAR_PROGRAMMING = 15` and `HIGHS_MIXED_INTEGER_PROGRAMMING = 16`, and [`linear_solver.cc`](https://github.com/google/or-tools/blob/stable/ortools/linear_solver/linear_solver.cc) registers the parse strings `"highs_lp"` and `"highs"`. The docstring is simply stale. `CreateSolver("HIGHS")` works.

The same header marks the intended defaults in comments:

> `GLOP_LINEAR_PROGRAMMING = 2,  // Recommended default value. Made in Google.`
> `// Recommended default value for MIP problems.` → `SCIP_MIXED_INTEGER_PROGRAMMING = 3`
> `// Recommended default value for pure integral problems problems.` → `SAT_INTEGER_PROGRAMMING = 14`
> `// Commercial software (need license).` → `GUROBI_…`, `CPLEX_…`, `XPRESS_…`, `COPT_…`

**Measured availability** in the stock `pip install ortools` wheel (9.15.6755), by calling `CreateSolver` on each id and testing for `None`:

| solver id | available in the wheel |
|---|---|
| `GLOP` (LP, Google) | yes |
| `CLP` (LP, COIN-OR) | yes |
| `PDLP` (LP, first-order, Google) | yes |
| `HIGHS_LP` | yes |
| `SCIP` (MILP) | yes |
| `CBC` (MILP, COIN-OR) | yes |
| `HIGHS` (MILP) | yes |
| `SAT` / `CP_SAT` (MILP via CP-SAT) | yes |
| `BOP` | yes |
| `GUROBI` | **no** — `NOT_FOUND: Could not find the Gurobi shared library` |
| `GLPK` | **no** — `Support for GLPK not linked in` |

So the practical choice set for WattSteer is **{GLOP, CLP, PDLP, HiGHS} for LP and {SCIP, CBC, HiGHS, CP-SAT} for MILP**, with no license to procure and no extra system packages to install. That alone answers most of the "is OR-Tools right" question: it removes the Pyomo + solver-installation problem that IDEA.md §30 was hedging against.

---

## 2. The formulation

### 2.1 Sets and parameters

| symbol | meaning |
|---|---|
| `t ∈ T = {1…24}` | hourly periods; `Δt = 1 h`, so MW and MWh are numerically interchangeable |
| `b ∈ B` | batteries |
| `a ∈ A` | shiftable loads |
| `curt[t] ≥ 0` | forecast curtailment available to absorb in hour `t` (MW) — the forecaster's output |
| `P̄ch_b, P̄dis_b` | charge / discharge power limits (MW) |
| `P̄_b` | inverter limit on `charge + discharge` (MW) — IDEA.md §29's `charge + discharge <= power_limit` |
| `S̲_b, S̄_b` | SOC bounds (MWh), e.g. 5 % and 95 % of `energy_capacity_mwh` |
| `S⁰_b` | initial SOC (MWh) |
| `ηc_b, ηd_b` | charge and discharge efficiencies; round-trip `RTE = ηc·ηd` |
| `C̄up_a, C̄do_a` | max hourly up- and down-shift of the flexible load (MW) — IDEA.md §31 `flexible_power` |
| `L_a` | maximum shift time in hours — IDEA.md §31 `maximum_shift` |
| `c_curt` | value of a recovered MWh |
| `c_deg_b` | battery degradation cost per MWh of throughput |

### 2.2 Decision variables

```
ch[b,t]    ≥ 0          charge power, MW
dis[b,t]   ≥ 0          discharge power, MW
soc[b,t]   ∈ [S̲_b, S̄_b] state of charge at the end of hour t, MWh
u[b,t]     ∈ {0,1}      1 = discharging mode, 0 = charging mode
up[a,t]    ≥ 0          upward load shift in hour t, MW
do[a,t,t'] ≥ 0          downward shift in hour t' compensating the up-shift of hour t,
                        defined only for |t − t'| ≤ L_a
absorb[t]  ≥ 0          curtailment absorbed in hour t, MWh (defined only where curt[t] > 0)
```

### 2.3 BESS constraints (IDEA.md §29, made precise)

```
soc[b,t] = soc[b,t−1] + ηc_b·ch[b,t]·Δt − dis[b,t]·Δt / ηd_b      ∀b, t        (B1)
soc[b,0] = S⁰_b                                                                (B2)
S̲_b ≤ soc[b,t] ≤ S̄_b                                              ∀b, t        (B3)
0 ≤ ch[b,t]  ≤ P̄ch_b                                              ∀b, t        (B4)
0 ≤ dis[b,t] ≤ P̄dis_b                                             ∀b, t        (B5)
ch[b,t] + dis[b,t] ≤ P̄_b                                          ∀b, t        (B6)

dis[b,t] ≤ P̄dis_b · u[b,t]                                        ∀b, t        (B7)
ch[b,t]  ≤ P̄ch_b · (1 − u[b,t])                                   ∀b, t        (B8)
```

(B1) is IDEA.md §29's SOC recursion, with one correction: IDEA.md writes a single `efficiency`; the loss must be split into a charge efficiency and a discharge efficiency, because they enter the balance asymmetrically (`×ηc` on the way in, `÷ηd` on the way out). A 92 % round-trip battery is `ηc = ηd = √0.92 = 0.959`.

(B7)–(B8) are the **single-binary** mutual-exclusion formulation. Chen & Baldick call this formulation novel in the storage context: *"Adding one binary variable u_t for each battery as in the following problem (UCED_BIN) can ensure mutual exclusivity of charging and discharging modes under any prices. To the best of the authors' knowledge, this single binary variable formulation is novel."* ([Chen & Baldick, *Battery Storage Formulation and Impact on Day Ahead Security Constrained Unit Commitment*, MISO / UT Austin, optimization-online 2021](https://optimization-online.org/wp-content/uploads/2021/07/8505.pdf), §II.B eqs. 15–17.BIN). It is one binary per battery per period — **24 binaries per battery per day**. Section 4 settles when you can drop them.

**Optional tightening.** The same paper gives valid inequalities that are strictly tighter than (B3) *when mutual exclusivity holds*:

```
soc[b,t−1] + ηc_b·ch[b,t]·Δt  ≤ S̄_b                                            (B3a)
soc[b,t−1] − dis[b,t]·Δt/ηd_b ≥ S̲_b                                            (B3b)
```

> "with mutually exclusive charging and discharging, (7) and (8) can be tightened to: `s_{t−1} + α·p_t ≤ s̄` … `s_{t−1} − β·g_t ≥ s̲` … (22) and (23) are also valid inequalities for any storage device with mutually exclusive modes. As observed in [4], (22) and (23) are tighter than (7) and (8)." (ibid., §III.A)

Their Theorem 3 additionally shows this tightening *by itself* guarantees mutual exclusivity in the **last** period and in any period after which the upper-SOC constraint never binds. At WattSteer's size the tightening is not needed for speed; it is worth knowing it exists if the horizon ever grows.

### 2.4 Shiftable industrial load (IDEA.md §31) — no binaries required

IDEA.md §31 asks for a freezer with `flexible_power = 20 MW`, `maximum_shift = 3 h`, `required_daily_energy = 100 MWh`. The published formulation that matches this exactly, and is *fully linear*, is Zerrahn & Schill's alternative DSM model ([A. Zerrahn and W.-P. Schill, "On the representation of demand-side management in power system models", *Energy* 84 (2015) 840–845; author postprint](https://d-nb.info/1154859959/34), eqs. 7–11):

```
up[a,t] = Σ_{t' = t−L_a}^{t+L_a}  do[a,t,t']                       ∀a, t        (D1)  = their (7)
up[a,t] ≤ C̄up_a                                                   ∀a, t        (D2)  = their (8)
Σ_{t = t'−L_a}^{t'+L_a} do[a,t,t'] ≤ C̄do_a                        ∀a, t'       (D3)  = their (9)
up[a,t'] + Σ_{t = t'−L_a}^{t'+L_a} do[a,t,t'] ≤ max(C̄up_a, C̄do_a) ∀a, t'       (D4)  = their (10)
```

What each one buys you, in the authors' words:

- (D1) — *"Equation (7) ensures that every upward load shift is compensated by according downward shifts in due time, which may take place either before the upward load shift, after it, or both."* This **is** IDEA.md's `required_daily_energy`: the load's daily energy is conserved by construction, because every MWh consumed early is given back within `L_a` hours. You do not need a separate daily-energy equality, and you should not add one — it would be redundant and would make the model harder to diagnose when infeasible.
- The double time index `do[a,t,t']` is the point of this formulation. It **tags each down-shift to the up-shift it compensates**, which is what enforces `maximum_shift` honestly. The naive single-index model (Göransson et al.) lets a unit shift up and down at full capacity in the same hour and thereby *"effectively circumvents the delay time restriction"* — the authors call this **undue recovery** and show it *"may ultimately result in a serious overestimation of longer-term load shifts"*.
- (D4) is the load-side analogue of the battery's mutual-exclusion problem, and the reason the load needs **no binaries**: *"(6) ensures that each granular DSM unit can only be shifted once, either up or down, in each period."* It permits partial simultaneity up to `max(C̄up, C̄do)` in aggregate, which is physically correct for a fleet of many small units, and it is a plain linear inequality.

If a real freezer cannot cycle every three hours, add their recovery-time constraint (their eq. 11), which the authors explicitly flag as integer-free:

```
Σ_{t' = t}^{t+R−1} up[a,t'] ≤ C̄up_a · L_a                          ∀a, t        (D5)
```

> *"An additional equation (11) enforces a recovery time R by demanding that the cumulative upward load shift over the whole recovery time does not exceed the maximum upward energy of one DSM cycle. This formulation effectively prevents excessive DSM utilization without requiring, for example, integer variables."*

Losses in the shifting process (a freezer that warms and must be over-cooled to catch up) go in as an efficiency `η_a` on the left of (D1), their eq. (7').

### 2.5 Coupling and objective

Define the **net increase in flexible demand** in hour `t`:

```
Δ[t] = Σ_b ( ch[b,t] − dis[b,t] ) + Σ_a ( up[a,t] − Σ_{t'} do[a,t',t] )        (C1)
```

Then, **splitting on the sign of the parameter `curt[t]`** (this is a build-time split, not a decision — it introduces no binaries):

```
for t with curt[t] > 0:
    Δ[t] ≤ curt[t]                                                             (C2)
    0 ≤ absorb[t] ≤ curt[t]                                                    (C3)
    absorb[t] ≤ Δ[t]                                                           (C4)

for t with curt[t] = 0:
    Δ[t] ≤ 0                                                                   (C5)
```

```
minimise   Σ_t c_curt·( curt[t] − absorb[t] )                                  (OBJ)
         + Σ_b Σ_t c_deg_b·( ch[b,t] + dis[b,t] )·Δt
```

Three notes, each of which is a trap someone will otherwise fall into:

- **(C4) must net the discharge.** IDEA.md §28's `minimize Σ curtailment_remaining[t]` is under-specified: if `curtailment_remaining[t]` is read as `curt[t] − charge[t]`, so that discharging in an oversupply hour is free, the model can charge at full power in *every* curtailment hour while discharging to keep SOC in range, and will report absorbing more energy than the battery can hold. The absorbed quantity has to be the **net** flexible demand increase, which is what the grid actually sees.
- **(C2)/(C5) stop the optimizer importing from the grid.** Without them, "absorbing curtailment" and "buying cheap grid energy" are indistinguishable to the model.
- **The sign split matters.** Writing (C4) unconditionally — `absorb[t] ≤ Δ[t]` with `absorb[t] ≥ 0` at every hour — silently implies `Δ[t] ≥ 0` for all `t`, i.e. **the battery can never net-discharge**. I hit this bug while building the benchmark; the model stayed feasible and returned a plausible-looking dispatch in which the battery simply never discharged. It is worth a unit test.

The realistic objective of IDEA.md §28 adds an energy term `Σ_t c_energy[t]·(Δ[t] − absorb[t])`. Section 4 shows this term is not decoration: a strictly positive energy price is exactly the condition under which the binaries become droppable.

---

## 3. CP-SAT or the linear solver?

**The linear solver.** CP-SAT is disqualified by variable type, not by speed.

Google's own CP-SAT documentation is unambiguous: *"To increase computational speed, the CP-SAT solver works over the integers"*, and *"All constraints in CP-SAT must be defined using integers"* ([Solving a CP Problem](https://developers.google.com/optimization/cp/cp_solver)). OR-Tools' own header repeats the caveat for the MPSolver route: `SAT_INTEGER_PROGRAMMING` *"requires only integer and Boolean variables. If you pass it mixed integer problems, it will scale coefficients to integer values, and solver continuous variables as integral variables."*

Both routes fail on this model, and they fail in different and instructive ways.

**Route A — `CreateSolver("SAT")` on the MILP above.** It reports the model **infeasible**, at every size tested:

```
E linear_solver.cc:1891] No solution exists. MPSolverInterface::result_status_ = MPSOLVER_INFEASIBLE
     MILP SAT       status=2 optimal=False
```

The other three MILP backends prove the identical model optimal in milliseconds. The scaling of `ηc = 0.959` and `1/ηd = 1.0428` in the SOC balance to integer coefficients is what breaks it.

**Route B — a hand-written native CP-SAT model.** Scale everything to integer 0.1 MW / 0.1 MWh units and write the SOC balance with exact integer coefficients:

```python
m.Add(1000*soc[b][t] == 1000*prev + 959*ch[b][t] - 1043*di[b][t])
```

This solves — CP-SAT returns `OPTIMAL` in 3–43 ms — but it returns the **wrong dispatch**. Measured, on the IDEA.md §27 profile (330 MWh of curtailment, one 100 MW / 250 MWh battery):

| model | status | curtailment remaining | time |
|---|---|---|---|
| MILP (SCIP, continuous power) | OPTIMAL | **95.4 MWh** | 3.2 ms |
| native CP-SAT, SOC as integer equality | OPTIMAL | **230.0 MWh** | 3–25 ms |
| native CP-SAT, SOC equality relaxed to ±1 unit | OPTIMAL | 94.8 MWh | 20–192 ms |

The cause is that over the integers, `1000·soc[t] = 1000·soc[t−1] + 959·ch − 1043·dis` is not merely a balance — it is a **divisibility constraint**: `959·ch − 1043·dis` must be a multiple of 1000. Most physically sensible `(ch, dis)` pairs are eliminated, and CP-SAT dutifully proves optimality over the mutilated feasible set. The failure is silent: the status is `OPTIMAL`, the numbers look like MWh, and the answer is worse by a factor of two.

Relaxing the equality to a ±1-unit band confirms the diagnosis — CP-SAT then lands within 0.6 MWh of the MILP — but it does so by letting the SOC balance leak up to 0.1 MWh per battery per hour, which is a physics violation traded for a modelling convenience, and it is an order of magnitude slower and far less predictable than the MILP that needed no such trade — four runs of the identical single-battery model took 20, 36, 47 and 192 ms, against SCIP's stable 3.1 ms.

CP-SAT is the wrong tool here for a structural reason: **the physics of this problem is continuous, and the only genuinely discrete thing in it is the charge/discharge mode.** That is one binary per period — a rounding error's worth of combinatorics for a MILP branch-and-bound, and no reason at all to move the whole model into the integers. CP-SAT would earn its place if the asset set later grew discrete structure that MILP handles badly — indivisible production batches, shift patterns, min-up/min-down runs on the industrial load, sequencing.

---

## 4. Does the mutual exclusion actually need binaries?

This is the question the ticket flags, and it decides LP versus MILP. **The answer is that under WattSteer's objective it does need them — unless a battery degradation cost above a specific, computable threshold is present.** The comfortable intuition ("efficiency losses make simultaneous charge and discharge wasteful, so the LP won't do it") is true only when the implied price of energy is positive, and a curtailment-absorption objective is precisely the regime where it is not.

### 4.1 What the literature says

The exactness of the relaxation is a *price-dependent* property, established in a small, tight line of papers.

**Chen & Baldick** (MISO / UT Austin), Theorem 1, for a battery bidding `C^p_t` to charge and offering `C^g_t` to discharge, with SOC coefficients `β > α > 0` and `α/β = RTE`:

> **Theorem 1.** The necessary condition to clear a battery with simultaneous charging and discharging MW under the convex form is to have the energy clearing price `λ_{t1}` for some interval `t1` be less than or equal to `(β·C^p_{t1} − α·C^g_{t1}) / (β − α)`.

and the corollary that matters:

> "a sufficient condition for using the convex relaxation formulation is for the LMP to be higher than `(β C^p − α C^g)/(β − α)`. For batteries bidding and offering to arbitrage energy across different intervals with `C^p_t = C^g_t = 0`, **the sufficient condition is for the LMP to be positive.** … however, **negative prices increasingly occur with renewable integration and transmission congestion**. Moreover, renewables and congestion are important drivers of battery installation. That is, even if zero and negative prices are relatively rare, they can be expected to at least occasionally be present with storage and so this issue must be tackled."

Their Theorem 2 shows the same threshold governs the *fractional* case: relaxing `u_t` to `[0,1]` does not help either, and they show by example that the constraint set with continuous `u_t` *"does not specify the convex hull for individual batteries even for T = 1."*

**Duan, Jiang, Fang, Wen & Liu**, ["Improved Sufficient Conditions for Exact Convex Relaxation of Storage-Concerned ED", arXiv:1603.07875](https://arxiv.org/abs/1603.07875), sharpen the earlier condition of Li, Guo, Sun & Wang (*IEEE Trans. Power Syst.* 31(2), 2016) to

> **Cond. 1:** ∀i, ∀t,  `LMP_i(t) > ( f'_i(p^c_i(t)) − ηc_i·ηd_i·g'_i(p^d_i(t)) ) / ( 1 − ηc_i·ηd_i )`

with a second, weaker condition covering the buses and hours where Cond. 1 fails, provided the storage there never hits its upper SOC bound: *"Cond. 2: ∀i, t at which the dual solution of RP violates Cond. 1, `s_i(τ) < S̄_i, ∀τ ≥ t`."* Their numerical validation is explicit about where it breaks: at `LMP = −3` with Cond. 1 and Cond. 2 both violated, the relaxed solution has `max|p^c·p^d| = 0.0012` — genuine simultaneous charge/discharge — and *"after we enlarge the energy capacity of storages from 2 MWh to 10 MWh, the exactness of RP is recovered."*

The two results agree on the mechanism: **simultaneous charge/discharge appears when energy is worth ≤ 0 at the margin and the upper SOC bound binds.** Curtailment is, by definition, the condition where energy at the margin is worth nothing — the grid is throwing it away. And a battery sized to absorb a curtailment event will, by construction, hit its upper SOC bound. WattSteer's optimizer sits squarely in the failure regime of both papers.

### 4.2 What actually happens, measured

I built the exact model of §2 and solved it twice — once as an LP with (B7)–(B8) omitted, once as a MILP with them — sweeping the degradation cost `c_deg` with `c_curt = 1` (so `c_deg` reads as a fraction of the value of a recovered MWh). One 100 MW / 250 MWh battery, `ηc = ηd = 0.959` (RTE = 0.9197), SOC 20 % initial, 5–95 % bounds, on IDEA.md §27's curtailment profile:

```
   c_deg    LP obj    MILP obj      gap    LP hours with simultaneous ch+dis
  0.0000   80.0932    95.3806   15.2874     5
  0.0050   83.2730    96.7335   13.4605     5
  0.0100   86.4528    98.0864   11.6336     5
  0.0200   92.8124   100.7922    7.9798     5
  0.0300   99.1720   103.4981    4.3260     5
  0.0380  104.2597   105.6627    1.4030     5
  0.0400  105.5317   106.2039    0.6722     5
  0.0415  106.4856   106.6098    0.1241     5
  0.0418  106.6764   106.6909    0.0145     5
  0.0420  106.7450   106.7450    0.0000     0    ← relaxation becomes exact
  0.0436  107.1780   107.1780    0.0000     0
  0.0500  108.9097   108.9097    0.0000     0
  0.1000  122.4388   122.4388    0.0000     0
```

At `c_deg = 0` the LP claims **15.3 MWh** more curtailment recovered than is physically achievable — a **16 %** overstatement of the headline product metric — and it does so by charging and discharging simultaneously in five of the six curtailment hours:

```
c_deg = 0   (LP relaxation, no binaries)
  ch : [0,0,0,0,0,0,0,0,0,0, 52.1, 57.9, 100.0, 95.0, 65.0, 55.0, 0,0,0,0,0,0,0,0]
  dis: [36,0,0,0,0,0,0,0,0,0, 47.9, 42.1,   0.0,  5.0, 35.0, 45.0, 100,100,15.8, 0,0,0,0,0]
  simultaneous: hours 10, 11, 13, 14, 15

c_deg = 0.05  (LP relaxation, no binaries — clean)
  ch : [0,0,0,0,0,0,0,0,0,0, 0.0, 4.6, 100.0, 90.0, 30.0, 10.0, 0,0,0,0,0,0,0,0]
  dis: [36,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0,0,0]
  simultaneous: NONE
```

The mechanism is exactly the one the papers describe, and it is worth naming because it is easy to miss on inspection: the battery is **venting**. Its SOC ceiling binds, so it pairs charging with discharging to burn stored energy — `ηc·x − x/ηd < 0` — creating headroom to "absorb" more in the same or a later hour. The energy it discharges goes nowhere the objective can see, so the venting is free.

### 4.3 The threshold, in closed form

The sweep crosses over between `c_deg = 0.0418` and `c_deg = 0.0420`. That is not a coincidence. Pairing `x` MW of charge with `x` MW of discharge for one hour costs `2·c_deg·x` in throughput and frees `x·(1/ηd − ηc)` MWh of headroom, which buys `y = x·(1 − RTE)/RTE` MWh of extra absorption at a further throughput cost of `c_deg·y`. Venting therefore pays iff

```
     k
c_deg  <  ───────  ·  c_curt        where   k = (1 − RTE) / RTE ,   RTE = ηc·ηd
          2 + k
```

For RTE = 0.9197 this gives `k = 0.087334` and a threshold of **0.041840** — inside the measured `(0.0418, 0.0420)` bracket. For a 90 % round-trip battery the threshold is ≈ 0.053·`c_curt`; for 95 %, ≈ 0.026·`c_curt`.

**Read the threshold as a sanity check, not as a licence.** It says: as long as you charge the battery a degradation cost of more than about 4 % of the value of a recovered MWh, the LP relaxation of this specific model is exact. That is a plausible number — but `c_deg` is one of the three quantities the map lists under *"Optimizer objective weights … none of which have obvious Brazilian values"*. Making numerical correctness depend on an unpinned parameter is not a trade worth making to save 3 ms.

### 4.4 Recommendation on this point

**Ship the binaries.** (B7)–(B8), one per battery per period.

- The MILP costs **3.15 ms** versus the LP's **0.25 ms** at the real problem size — 2.9 ms to be unconditionally right.
- Correctness stops depending on an objective weight nobody has pinned down yet, and stays right if a later ticket sets `c_deg = 0` while the weights are still being argued about.
- It stays right under the *simple* objective of IDEA.md §28 as well as the realistic one. The simple objective is exactly the `c_curt = 1, c_deg = 0, c_energy = 0` corner where the relaxation is worst.
- The headline product metrics — MWh recovered and Avoidability Score (§33) — are computed *from* this dispatch. An LP that overstates recovery by 16 % overstates the product's central claim by 16 %, in a direction that flatters it. Given the map's standing preference that there be *"nothing on screen you can't defend to an engineer"*, that is not an acceptable class of error.
- Keep the LP as a **cross-check in tests**, not as the production path: assert `LP_objective ≤ MILP_objective` and assert the gap is zero at the configured weights. If the gap is ever non-zero in production, the objective weights have drifted into the pathological regime and you want to know.

---

## 5. Solve times at realistic size

Full model of §2 — batteries with binaries, loads with Zerrahn & Schill, `c_deg = 0.05`, `c_curt = 1`. Median of 5 solves; time is `MPSolver::Solve()` only, excluding model construction.

| case | vars | binaries | cons | GLOP (LP) | CLP (LP) | HiGHS (LP) | PDLP (LP) | **SCIP** | CBC | HiGHS (MILP) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **1 BESS + 1 load, T=24** | 282 | 24 | 198 | 0.25 ms | 0.27 ms | 0.91 ms | 2.69 ms | **3.15 ms** | 3.09 ms | 7.65 ms |
| 3 BESS + 3 loads, T=24 | 834 | 72 | 534 | 0.70 ms | 1.03 ms | 2.51 ms | 21.5 ms | **6.83 ms** | 7.50 ms | 20.9 ms |
| 10 BESS + 10 loads, T=24 | 2766 | 240 | 1710 | 1.98 ms | 4.92 ms | 6.25 ms | 61.6 ms | **33.7 ms** | 26.2 ms | 72.8 ms |
| 5 BESS + 5 loads, T=96 (15-min) | 5724 | 480 | 3480 | 4.63 ms | 9.02 ms | 14.9 ms | 304 ms | **63.2 ms** | 57.3 ms | 136 ms |

For reference, the native CP-SAT model of §3 (integer 0.1 MW units, single BESS, T=24) took 3–25 ms and returned the wrong answer.

**Conclusions:**

- **Run it synchronously in the HTTP request.** A single-digit-millisecond solve does not justify a job queue, a polling endpoint, or a "your scenario is being computed" screen. Mitigate is a what-if tool; the user changes a slider and expects the chart to move.
- **Even 40× the expected asset count stays under 100 ms.** The problem does not have a scaling cliff in the range WattSteer will ever hit. Growth is roughly linear in `|B|·|T|`.
- **PDLP is the wrong LP backend at this size** and gets worse as the model grows (0.25 ms → 304 ms while GLOP goes 0.25 → 4.6 ms). This matches OR-Tools' own advice: *"PDLP is designed for the largest problems, where simplex and barrier methods hit memory limits or are too slow"* ([Advanced LP solving](https://developers.google.com/optimization/lp/lp_advanced)). Do not reach for it.
- **Model construction, not solving, will dominate the request.** Building the model in Python via `pywraplp` costs more than `Solve()` at these sizes. If the endpoint is ever slow, profile the builder first.
- **Set a time limit anyway** — `solver.SetTimeLimit(milliseconds)` — and treat a non-`OPTIMAL` status as an error rather than rendering the incumbent. `Solve()` returns `pywraplp.Solver.OPTIMAL` / `FEASIBLE` / `INFEASIBLE` / `UNBOUNDED` / `ABNORMAL` / `NOT_SOLVED`; a `FEASIBLE` result from a MILP means the gap was not closed and the Avoidability Score would be a lower bound, not a number. Related knobs: `SetNumThreads(n)`, `SetSolverSpecificParametersAsString(...)` for the MIP gap, `WallTime()`, `Iterations()`, `nodes()` ([pywraplp Solver reference](https://or-tools.github.io/docs/python/classortools_1_1linear__solver_1_1pywraplp_1_1Solver.html)).
- **One operational caveat, found the hard way.** `CBC` aborted the whole Python process — `Check failed: collection->insert(...).second duplicate key` in `MPSolver::LookupVariableOrNull` — when two variables were given the same name. SCIP and HiGHS solved the same model without complaint. In a FastAPI service this is a hard crash of the worker, not an exception. Either give every variable a unique name (which you should do anyway for debuggability) or do not use CBC.
- **Second caveat.** `MPVariable::solution_value()` segfaults after its `MPSolver` has been garbage-collected. Extract the solution into plain Python objects before the solver goes out of scope; do not return variable handles from a helper.

---

## 6. Licensing for eventual commercial use

WattSteer is public and read-only in v1, but the map says the repo should be able to become a startup. Positions, from each project's own licence file:

| component | licence | source | commercial position |
|---|---|---|---|
| **OR-Tools** (incl. GLOP, PDLP, BOP, CP-SAT) | **Apache 2.0** | ["The OR-Tools software suite is licensed under the terms of the Apache License 2.0"](https://github.com/google/or-tools/blob/stable/README.md); [`LICENSE`](https://github.com/google/or-tools/blob/stable/LICENSE) | Unrestricted. Permissive, patent grant included, no source-disclosure obligation. |
| **SCIP** | **Apache 2.0** | [`scipopt/scip/LICENSE`](https://github.com/scipopt/scip/blob/master/LICENSE); the [CHANGELOG](https://github.com/scipopt/scip/blob/master/CHANGELOG) records *"Changed license to Apache 2.0"* under `@section RN803 SCIP 8.0.3` | Unrestricted **for SCIP ≥ 8.0.3**. This is the licence change that makes SCIP usable commercially at all — earlier releases were under the ZIB Academic License, which forbade it. Anything you read predating late 2022 saying "SCIP can't be used commercially" is out of date. |
| **HiGHS** | **MIT** | [`ERGO-Code/HiGHS/LICENSE.txt`](https://github.com/ERGO-Code/HiGHS/blob/master/LICENSE.txt) — *"MIT License … Permission is hereby granted, free of charge …"*; the solver banner reads `Running HiGHS 1.12.0 … under MIT licence terms` | Unrestricted. The most permissive of the three. |
| **CBC / CLP** (COIN-OR) | **EPL 2.0** | [`coin-or/Cbc/LICENSE`](https://github.com/coin-or/Cbc/blob/master/LICENSE), [`coin-or/Clp/LICENSE`](https://github.com/coin-or/Clp/blob/master/LICENSE) | Usable commercially, but EPL 2.0 is a **weak copyleft**: modifications to CBC/CLP source itself must be made available. Merely calling it through OR-Tools imposes no obligation on WattSteer's own code. Still a step up in obligation from Apache/MIT for zero benefit here. |
| **GLPK** | GPL | — | Not in the wheel; do not link it. GPL would be the only genuinely hazardous choice for a closed commercial product. |
| Gurobi / CPLEX / Xpress / COPT | commercial | header comment: `// Commercial software (need license).` | Not shipped in the wheel and not needed. Nothing in §5 suggests a commercial solver would ever be worth the licence. |

**Position: SCIP primary, HiGHS fallback, both permissive.** The one licensing point worth writing down for a future reader is that **SCIP's licence is version-dependent**: pin `ortools >= 9.7` (which ships SCIP ≥ 8.0.3) and record the SCIP version alongside the OR-Tools version, so the Apache-2.0 claim stays checkable. Avoid CBC — not for licence risk, but because EPL adds obligation while CBC adds the process-abort failure mode from §5.

---

## 7. Options for handling forecast uncertainty

The forecaster emits a **P10 / P50 / P90 profile per hour** for all 24 hours (charting-session decision). The optimizer has to turn a band into a dispatch. This section lays out the options and their cost; **it deliberately does not choose** — that belongs to the optimizer spec ticket (011).

The structural fact underlying all of them: `curt[t]` appears in the model only in **(C2)–(C5)**, as a right-hand side. Nothing in the BESS or DSM blocks depends on it. So the choice below changes the size and shape of the coupling constraints and nothing else — all four options reuse §2 verbatim.

### Option A — deterministic on P50

Solve §2 once with `curt[t] = P50[t]`.

- **Cost:** one solve. Size and time exactly as measured in §5.
- **What you get:** the dispatch that is optimal if the median forecast comes true.
- **What you give up:** no notion of downside. The failure mode is asymmetric and unflattering — if realised curtailment comes in below P50, the battery has committed to charging from energy that was never curtailed, i.e. it imports from the grid, and the reported "MWh recovered" is fiction. (C2) prevents this *ex ante* against the forecast, not *ex post* against reality.
- **Reportability:** a single number, no band. Simple to explain, and simple to be wrong about.

### Option B — deterministic on P10 (conservative point forecast)

Same as A with `curt[t] = P10[t]`.

- **Cost:** identical — one solve, same size.
- **What you get:** a dispatch that is feasible against a pessimistic realisation, so the claimed recovery is a floor rather than a median.
- **What you give up:** systematically under-uses the assets. On a fleet sized for the P50 event, the battery finishes the day part-empty.
- Worth noting because it is nearly free and gives a defensible *lower bound* on avoided curtailment, which is the direction of error the map's honesty preference favours. It is not robust optimisation — it is a different point forecast.

### Option C — robust, budget-of-uncertainty (Bertsimas & Sim)

Model `curt[t]` as living in an interval `[P10[t], P90[t]]` and require the dispatch to be feasible for any realisation in which at most `Γ` of the 24 hours deviate adversarially from nominal. `Γ = 0` reduces to A; `Γ = 24` is the fully adversarial box.

- **Primary source:** D. Bertsimas and M. Sim, ["The Price of Robustness", *Operations Research* 52(1), 2004, 35–53](https://pubsonline.informs.org/doi/10.1287/opre.1030.0065). The property that makes it attractive here: *"the new robust formulation is also a linear optimization problem"* — the robust counterpart of a linear constraint with interval uncertainty is itself linear, adding one dual variable per uncertain constraint plus one per uncertain coefficient.
- **Cost:** roughly `+2·|T|` continuous variables and `+|T|` constraints against a ~280-variable model. **Still a single MILP, still milliseconds.** The binaries do not multiply.
- **What you get:** `Γ` is a dial the product can expose and defend — "this plan holds unless more than Γ hours come in below forecast". Constraint-violation probability bounds come with the method.
- **What you give up:** `Γ` has to be chosen, and it is not observable from the forecaster's output. Choosing it honestly needs backtest evidence, which the Replay engine (§34) could supply but does not yet.
- **Related storage-specific prior art:** R. Jabr, S. Karaki, J. Korbane, "Robust multi-period OPF with storage and renewables", *IEEE Trans. Power Syst.* 2015 — cited by Duan et al. as reference [1]. **I did not read this paper**; see open questions.

### Option D — scenario-based / two-stage stochastic

Sample `S` curtailment scenarios consistent with the P10/P50/P90 band, with probabilities `π_s`. Charge/discharge decisions for hour 1 (or for the whole day, if the plan is a commitment) are **first-stage** and shared; `absorb[s,t]` and the SOC trajectory become **second-stage**, per scenario.

```
minimise  Σ_s π_s · Σ_t c_curt·( curt[s,t] − absorb[s,t] )  +  Σ_b Σ_t c_deg_b·( ch[b,t] + dis[b,t] )
```

- **Cost:** the model grows by roughly a factor of `S` in the scenario-dependent blocks. The **binaries need not multiply** if charge/discharge mode is a first-stage commitment (which is the physically right reading of a day-ahead plan): 24 binaries total, `S`×24 continuous SOC and absorb variables. From §5's scaling, `S = 20` sits somewhere near the "10 BESS + 10 loads" row — **tens of milliseconds**, still comfortably synchronous.
- **What you get:** an expectation-optimal plan, and — for free — the *distribution* of outcomes, which is the natural input to an honest P10/P50/P90 band on the Avoidability Score rather than a single number. This is the option that fits the map's insistence on showing uncertainty.
- **What you give up:** you must generate scenarios that are **temporally coherent**. Independently sampling each hour from its own marginal is wrong and will understate risk badly — curtailment events are strongly autocorrelated within a day. Getting this right needs either scenario paths from the forecaster (a change to ticket 009's output contract) or a copula/block-bootstrap over historical residuals.
- Also available in this family: **CVaR** in place of expectation (same model, different objective, still LP-representable), and **chance constraints**, which are *not* LP-representable in general and would be the one option that changes the solver conversation.

### Cross-cutting

- **Options A–D all keep the model a MILP of the shape in §2** and all stay within the synchronous-HTTP budget. Uncertainty handling is not a solver decision. It should not be argued as one.
- **Whatever is chosen has to be the same in Replay (§34) as in serving.** A backtest that replays a P50-optimised dispatch and a live path that runs a robust dispatch produce non-comparable "MWh recovered" numbers, which would quietly break the product's central proof.
- The choice interacts with the **bitemporal** decision: a robust or scenario plan built at D-1 must be scored against the vintage of forecast available at D-1, not against the revised one.

---

## 8. Recommendation, assembled

| decision | recommendation |
|---|---|
| Library | **OR-Tools `pywraplp`** (the linear-solver wrapper). Not Pyomo — no external solver install, and no CP-SAT. |
| MILP backend | **SCIP** (`CreateSolver("SCIP")`), with **HiGHS** as a configurable fallback. Not CBC (process-abort failure mode, EPL). |
| Model class | **MILP**, one binary per battery per period, ~24 per battery per day. |
| BESS | (B1)–(B8) of §2.3. Split efficiency into `ηc`, `ηd`. Keep (B3a)/(B3b) in reserve. |
| Shiftable load | Zerrahn & Schill (D1)–(D4), fully linear, **no binaries**. Add (D5) only if a real asset needs a recovery time. |
| Objective | `c_curt` on unabsorbed curtailment plus `c_deg` on battery throughput; discharge **must** be netted into the absorbed quantity (C4). |
| Execution | **Synchronous inside the HTTP request.** `SetTimeLimit(2000)`; treat anything but `OPTIMAL` as an error. |
| Licensing | Apache 2.0 (OR-Tools, SCIP ≥ 8.0.3) and MIT (HiGHS). Pin `ortools` and record the SCIP version. |
| Uncertainty | **Not decided here** — §7 lays out P50 / P10 / robust-Γ / scenario-based with costs. All four fit the same model and the same latency budget. Ticket 011. |

---

## 9. Open questions / could not confirm

- **`c_deg`, `c_curt` and `c_energy` in Brazilian units.** The map already lists this as unspecified. §4.3 gives the ratio at which the LP relaxation becomes exact, but not the absolute values. Nothing here resolves it, and the recommendation to keep the binaries is partly a way of not depending on it.
- **I could not read Li, Guo, Sun & Wang (2016) directly** — the IEEE Xplore PDF is paywalled. Their conditions are quoted here **second-hand**, via Duan et al.'s restatement and Chen & Baldick's citation. Both restatements agree, so I am reasonably confident, but the primary text is unverified.
- **I did not read Jabr, Karaki & Korbane (2015)** on robust multi-period OPF with storage. It is named in §7C as relevant prior art on the strength of Duan et al.'s citation only. If robust optimisation is chosen in ticket 011, read it first.
- **Paulus & Borggrefe (2011)** and the Zhang & Grossmann industrial-DSM reviews are named in Zerrahn & Schill's related work but I did not obtain their formulations. Zerrahn & Schill's own equations are quoted from their author postprint, which I did read in full; the earlier papers are cited only for provenance.
- **The threshold formula of §4.3 is derived and empirically confirmed for this specific model**, on one curtailment profile, one battery, `ηc = ηd`. I have not proved it holds for `ηc ≠ ηd`, for multiple batteries with different efficiencies, or when the flexible loads are present and the SOC ceiling is reached by a different route. Treat it as a diagnostic, not a theorem.
- **Whether the ONS curtailment forecast will actually produce hours where `curt[t] = 0` interleaved with large events** — the venting pathology of §4.2 needs zero- or low-curtailment hours adjacent to a binding SOC ceiling. The IDEA.md §27 profile has them; whether real subsystem-level profiles do is a question for ticket 001's data.
- **Model-build time in Python was not separately profiled.** §5 states it likely dominates `Solve()`; that is an inference from the magnitudes, not a measurement.
- **The `HIGHS` solver id is undocumented in the `CreateSolver` docstring** but present in the enum and the parse table, and it works. I could not find a Google documentation page listing HiGHS as a supported MPSolver backend; the evidence is the source and the live test.
- **CBC's duplicate-name abort was not reduced to a minimal reproduction** and is not filed upstream. It reproduced reliably in this benchmark on OR-Tools 9.15.6755 / macOS arm64.

---

## Appendix — reproducing the measurements

```
python -m venv venv && ./venv/bin/pip install ortools    # 9.15.6755 at time of writing
```

Availability probe:

```python
from ortools.linear_solver import pywraplp
for sid in ["GLOP","CLP","PDLP","HIGHS_LP","SCIP","CBC","HIGHS","SAT","BOP","GUROBI","GLPK"]:
    print(sid, pywraplp.Solver.CreateSolver(sid) is not None)
```

The full benchmark builds §2's model with `n_bess` batteries and `n_load` shiftable loads over `T` periods, on `curt = [0]*10 + [20,70,110,90,30,10] + [0]*8` (IDEA.md §27), `P̄ch = P̄dis = P̄ = 100 MW`, `S⁰ = 50 MWh`, `[S̲, S̄] = [12.5, 237.5] MWh`, `ηc = ηd = 0.959`, `C̄up = C̄do = 20 MW`, `L = 3`, and toggles (B7)–(B8) to switch between LP and MILP. Section 4's sweep is the same model solved by `GLOP` and by `SCIP` at a range of `c_deg`, comparing objectives and counting hours where `ch[t] > 0 ∧ dis[t] > 0`.
