# 27 — Every checkable claim in the nine specs is verified against the tree

**What to build:** a sweep confirming the specs say true things, and a mechanism
so the checkable half cannot silently rot again.

This is the documentation analogue of api-surface 25, and it rests on the same
kind of evidence: a long list of claims that were **false when found**, each
discovered by accident while someone worked on something else.

* "eleven hours of operator notice" in five places — `gate_at` says **ten**
* the drizzle snapshots described 33 tables while the schema had 38
* one caching row count claimed three different numbers in three artefacts
* "21 columns" was 22 names over 21 rows
* a 90-day calibration table had three 91-day rows
* `observed_constrained_off_same_hour_exceedance_7d` was called unemitted in
  **five** places after migration `0036` made it the 112th attribute
* "there is no national band" survived in three places after forecaster 08 and 22
* `/v1/backtest` was "not served" in four places after replay 08 served it
* two tables were said to be absent from `schema.ts` that migration `0034` created
* an archive writer was called unbuilt while its column is `not null`
* a comment vouched for a 0.62 shrink factor as "the same one `grid.ts` uses"
  after `grid.ts` had moved to a drawn ensemble

None of these broke a test. Every one of them would mislead a reader, and several
misled an *agent* into building the wrong thing before the record was corrected.

**The work.** Go through `docs/specs/*.md` and verify the claims a machine can
check: counts (columns, rows, routes, attributes, tables, migrations, fixtures),
named files and symbols, numeric constants that also live in code or SQL, and
claims of the form "does not exist / is not built / is not served / today there
is no". Report each as **true**, **false and fixed**, or **not checkable**.

**Then leave behind a guard for the mechanical subset.** Counts and file
references are the two classes that rot silently and are cheaply derivable —
`cache-policy.test.ts` already parses the spec's own caching table and derives its
count rather than restating it, and `spec-examples.test.ts` binds fenced examples
by fence ordinal. Extend that idea to whichever claims can carry it. **Do not
invent a guard that needs a human to keep a list in step** — that is the failure
this ticket exists to end.

Be honest about the ceiling: prose claims about intent, judgement or the future
are not checkable, and a sweep that pretends otherwise is worse than one that
scopes itself. Say what you did not check and why.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Every checkable claim across the nine specs is reported true, fixed, or
      out of scope, with the check used
- [ ] No false claim is left standing; corrections record what happened rather
      than deleting the history of what was found
- [ ] Counts that can be derived are derived, and a guard fails when one drifts
- [ ] The guard's inputs are proven non-empty — an empty parse must not pass
      (this repo has been bitten by that four times)
- [ ] What was not checkable is listed, not hidden
