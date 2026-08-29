# 11 — Both feature sets build, and the dictionary says what each column is

**What to build:** `dessem_free_v1` and `dessem_augmented_v1` both build over
their full windows from the same function under different arguments, and every
column in them is described in a dictionary an analyst can read — its class, its
source, its grain and which set it belongs to.

| | `dessem_free_v1` | `dessem_augmented_v1` |
|---|---|---|
| Window | 2024-04-01 → now (~880 days) | 2025-05-23 → now (~460 days) |
| Rows | ≈ 84,500 | ≈ 44,200 |
| Gates | `gate_early` and `gate_late` | `gate_late` only |
| Residual load | reconstructed from the day-ahead programme and the pinned run | from the balance directly |

Row grain is (`Subsystem`, `valid_time`) — hourly, UTC, start-labelled. The
label atom is (`Subsystem`, `Technology`, `valid_time`), but the feature row
carries both technologies' labels as columns rather than duplicating sixty-odd
shared context columns per technology.

The dictionary is not documentation for its own sake. It is where three things
that are otherwise invisible get stated: that a capacity column is **day grain**
and must not be read as an hourly signal; that a capacity-factor proxy is a
proxy; and that every column has a **class** — from the balance, from the pinned
run, from the day-ahead programme, a lagged level, deterministic, or dropped
with a named replacement. *Unclassified is not an option — an unclassified
feature is a leak waiting to be written.*

The features present **only** in the augmented set are enumerated explicitly, so
that "what does DESSEM buy" has a written answer before any model is trained.
Everything else the balance contributes has an analogue in the DESSEM-free set.

The A/B this sets up **needs three trainings, not two**, or the comparison
confounds feature content with window length: the DESSEM-free set over its full
window, the DESSEM-free set over the common window, and the augmented set over
the common window. All three are evaluated on the same held-out period at the
same gate with the same threshold. Running them is the forecaster's; making all
three expressible from one function under different arguments is this ticket's.

Feature selection, importance, model choice and the threshold sweep are all out
of scope. Everything here is *available*; which columns survive is an empirical
question with no answer before a model exists.

**Blocked by:** 03, 04, 05, 06, 07, 08, 09, 10 — every feature block. This is
the ticket that closes the spec.

**Status:** done

- [ ] Both feature sets build over their full windows from the same function under different arguments, and the row counts match the arithmetic above
- [ ] The row grain is (`Subsystem`, `valid_time`); both technologies' labels are columns on the shared row
- [ ] A feature dictionary lists every column with its class, source, grain and set membership, and no column is unclassified
- [ ] Day-grain columns are marked as such
- [ ] Proxy columns are named as proxies
- [ ] The columns present only in the augmented set are enumerated explicitly, with the four that would justify the trade called out
- [ ] Dropped features are listed with the named replacement for each
- [ ] All three A/B configurations are expressible as arguments to the one function; none needs a second code path
- [ ] **Seam 3** fixture tests over a hand-built series cover the cases where an off-by-one is invisible: window frames ending at the cutoff versus including the current row, a lag that does not clear the cutoff, the cyclical encodings, circular wind-direction averaging, the power curve at its three break points, and the clearness index at night
- [ ] Seams 1 and 2 pass over both sets, at both applicable gates
- [ ] The full-window build completes within a documented time and call budget
