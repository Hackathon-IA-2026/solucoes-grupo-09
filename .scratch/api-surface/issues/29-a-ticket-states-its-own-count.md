# 29 — A ticket's stated count of open boxes is derived from its own boxes

**What to build:** the same guard api-surface 27 left over `docs/specs/*.md`,
pointed at the corpus 27 did not cover — the tickets themselves — plus the sweep
that finds what is wrong there today.

27 is the model and its central rule is the one that matters here: **do not
invent a guard that needs a human to keep a list in step.** Its nine derivations
are bound to the specs' prose by regex, and a spec sentence written next year is
checked the day it is written. Nothing was bound to `.scratch`, and the tickets
have the same disease with a sharper cost, because a ticket is what the *next
agent* reads to decide what to build. A ticket that misstates its own remaining
work sends an agent to build the wrong thing, which is exactly what 27
documented happening with the specs.

The evidence is this repository's own history, three reproductions of one defect:

* In `10-forecast-publication.md` the status line said `done (**two boxes
  open** …)` while a grep at the time returned **six**. Found and corrected on
  2026-09-09, and the correction note explains why: the count had been written
  against the acceptance list at the top, and the two sections the ticket added
  afterwards carry two boxes each.
* In one wave on 2026-09-10, two agents each closed a *different* box on that
  same ticket and each status line said, truthfully, "three boxes open" on its
  own branch, neither able to see the other. Both numbers were stale the moment
  they merged and the true count was **one**, because a third agent in the same
  wave had closed a third box from another lane. See `f7afa42`.
* The same file's "What is still open" heading had outlived two revisions of its
  own count, and was on its third when this ticket found it.

**The work.** Derive the count from the file's own `- [ ]` lines and bind it to
whatever the file says about it, by pattern and never by line number or
registry — a ticket written today must be covered today. Then sweep every
ticket and fix the ones that are wrong, reporting each as true, false and fixed,
or not checkable, with the check used. Survey the real shapes first: statuses in
this repository are prose and not an enum, and the claims that are not
machine-checkable must be **named** as out of scope rather than silently
skipped.

The one thing this must not do: **an unticked box is not a signal of open work
here.** Most `done` tickets leave every box unticked as written. Only a count a
ticket states *in prose* may be compared against its boxes.

**Blocked by:** None. (api-surface 27 is the model, and is done.)

**Status:** done

- [x] A ticket's stated count of open/remaining boxes is derived from its own
      `- [ ]` lines and a guard fails when the two disagree
- [x] The claim is bound to the prose by pattern — no line numbers, no registry;
      a ticket is covered the day it is written
- [x] Every ticket is swept and reported true, false and fixed, or not
      checkable, with the check used
- [x] No false count is left standing; the corrections record what happened
      rather than deleting the history of what was found
- [x] The guard is proven to fail on drift **and** on empty input — an empty
      parse does not pass
- [x] What is not machine-checkable is named, including the status shapes that
      state no quantity
- [x] The guard does not fire on a `done` ticket whose boxes are all unticked,
      and that is asserted over the 92 tickets in that state

## What landed

`test/ticket-claims.ts` + `test/ticket-claims.test.ts` — in the root hygiene
suite (`bun run test:hygiene`, 24 tests), which walks `test/` and therefore
picked them up with no wiring.

**130 tickets swept. 688 unticked checkboxes and 267 ticked ones across them.
Eleven prose statements about a ticket's own open-box count were found and
bound, in two of those files; five were live claims and six were the tickets
quoting their own wrong numbers back. Three live statements were wrong; all
three are fixed. The other 128 tickets state no count about their own boxes,
which is why this guard fires on two files rather than on ninety-seven. This
document is the 131st file in that corpus and is governed by the same guard from
the moment it is written — eighteen bound statements across three files now,
seven live and eleven quotations, and none of them drifted.**

### Why it lives beside `spec-claims.ts` rather than inside it

27's nine derivations all have the same subject — the *tree* — and their corpus
is the nine specs. This derivation's subject is the document itself: the number
being derived is a property of the very file the sentence is in, and the corpus
is 130 files under `.scratch` rather than nine under `docs/specs`. Those are
different enough to be different modules, and the module boundary is where the
reuse happens rather than being in the way of it: `ticket-claims.ts` imports
`ROOT`, `numberOf` and — the important one — `sentencesOf` from
`spec-claims.ts`, so there is exactly **one** sentence splitter and one numeral
vocabulary in this repository, and 27's hard-won per-sentence exemption scope
governs both corpora. Two small changes went the other way, into
`spec-claims.ts`: `sentencesOf` is exported and takes an extra marker
vocabulary, and it splits sentences correctly at trailing Markdown emphasis
(below).

### How the count is derived, and how it is bound

**Derived:** `- [ ]` lines in the file, counted. That is the whole derivation,
and it is the only quantity any binder is compared against. `- [x]` lines are
counted too, for the record, and **nothing is bound to them** — see the
out-of-scope list.

**Bound:** by seven patterns over the prose, surveyed from the corpus before
they were designed rather than guessed at. The defect has been written in more
than one shape, which is why there is more than one binder:

| Binder | The shape it binds | Found in |
|---|---|---|
| `N boxes open` | `**Status:** done (**one box open** …)`, "three boxes remain" | the status line, and the correction notes |
| `N open boxes` | "The two open boxes" | mid-ticket prose |
| a grep for `- [ ]` returns `N` | "A grep for `- [ ]` in this file returns one" | the count's own provenance note |
| `N unticked` | "a grep found **six** unticked" | reconciliation notes |
| `N boxes`, under a still-open heading | `**Two boxes, and neither is a judgement call.**` | the section lead |
| its other `N` boxes | "the only thing standing between this ticket and its other four boxes" | `forecaster/18` |
| the count is now `N` | "The count was four and is now one" | the status paragraph |

Two properties make this maintenance-free, and they are the two 27 insisted on:

- **The corpus is discovered by shape.** A ticket is a `.md` file under a lane's
  `issues/` directory that carries a `**Status:**` line. That is the entire
  registry: the five `00-README.md` files fall out because they have no status
  line, a lane added next month is walked without an edit, and a ticket written
  mid-wave is bound the moment it exists. This was tested against the real case
  rather than argued: `data-platform 21` was written on another branch *while
  this ticket was being built*, and running the binders over it needed no change
  here — it states no count, so it is correctly reported as clean rather than as
  covered-by-luck.
- **The claim is found by pattern, not by position.** Two binders are scoped to
  a section, and the scope is the *heading's own words*
  (`/what\s+(?:is|remains|was)\s+(?:still\s+)?(?:open|left)|still\s+open/i`),
  not a line number or an index.

Numerals are spelled into every pattern rather than captured as `[\w-]+` and
filtered afterwards. `[\w-]+` was tried first and bound "The count above is a
count **of** unticked boxes" — a sentence stating no quantity — as a claim with
no number, and a claim with no number is a hole a real drift can hide in.

### The hardest document in the corpus was this one, and it changed the design

A ticket *about* box counts quotes other tickets' counts on every third line, so
the first run of the finished guard over the finished write-up returned **23
violations against this file** — every one of them a specimen, a table cell or a
count belonging to another ticket. That is a real result and not an
inconvenience: a binder that cannot tell a specimen from an assertion would fail
on the next reconciliation note anybody writes. Three things came out of it, all
of them narrowing what counts as a claim rather than widening what is excused:

- **A specimen is not an assertion.** Fenced code blocks and indented
  transcripts are removed before the prose is split — a shell command, or a
  probe's output quoting a status line's parenthetical back, asserts nothing.
- **A table cell is not a sentence.** The splitter quite reasonably makes an
  entire Markdown table one "sentence", so the binder table above — seven rows,
  each quoting an example of what it binds — read as a dozen simultaneous claims
  about this file. Table rows are removed too, and that is named in the
  out-of-scope list below: none of the three real defects was in a table, and a
  count that governs anything is stated in prose.
- **A sentence that names another ticket is about that ticket.** This is the
  mechanical form of an out-of-scope class that would otherwise have been a
  hand-waving paragraph — `api-surface/09`'s "the last three boxes were ticked
  on arrival", which is about *product-fixes 01*. The lane names in the pattern
  are read from the `.scratch` directory listing, so a new lane needs no edit.

The eight that survived those three were genuine reported speech, and they were
fixed the way this guard asks any correction to be fixed: **in the clause that
carries the number.** Two words were added to the marker vocabulary for it —
"sentence said" and "paragraph said" — and the rest was rewording. This document
therefore states two counts about itself that are live claims, both of them
zero, and both derived: the guard governs the ticket that wrote it.

### The three wrong counts, all in `api-surface/issues/10`

**1. "It is now three", when it was one.** A whole paragraph, written in the
2026-09-10 wave, recording a re-grepped count of three: the null-headline box
had just closed, "leaving the end-to-end run against a real promoted artifact,
the frozen background sample (forecaster 30), and the un-alerted missed
publication". It was true on the branch that wrote it. Two of those three landed
in the same wave from other lanes, so it was **stale before it merged** — the
exact failure this ticket exists to end, preserved in the file that has now
suffered it three times. The paragraph is kept and now announces itself as a
quotation of what the previous revision read, with the reasons intact and the
arithmetic of how three became one stated.

**2. "Two boxes, and neither is a judgement call", when it was one.** The lead
sentence of "What is still open, and why", and the count that had outlived two
revisions of itself by its own admission — a parenthetical apologising for the
staleness sat directly beneath it, which is the tell that a human note is no
substitute for a derivation. Now `**One box, and it is not a judgement call.**`,
which is what the section's own body says: item 1 is open, item 2 is struck
through and marked **Closed.**, and the sub-box below it was closed by the route
landing.

**3. The re-grep note that did not announce itself.** Its words, as this
section quotes them, were "a grep found six unticked". This one is the most interesting of the three, because the *number* is
right and the *sentence* was wrong. It is a faithful record of the 2026-09-09
reconciliation, but a colon ends the clause that carries the retrospective
marker, so the number sat in a sentence of its own that read as a live claim.
Reworded to "a grep **at the time** found six unticked" — four words, and the
sentence now says which count it is. That is the standing rule this guard
imposes on the prose, and it is a good one: **a correction must be
retrospective in the clause that carries the number**, not merely somewhere in
the paragraph. 27 proved paragraph scope was too generous in the other
direction; this is the same boundary seen from the other side.

Three of that file's statements were **true when found**, and they are why the
fix is three sentences and not six. Its status line said `done (**one box open**
…)`. Its provenance sentence said "A grep for `- [ ]` in this file returns one".
Its status paragraph said "The count was four and is now one". The person who
corrected that file on 2026-09-09 got all three right and had no way to make
them *stay* right.

### A latent bug in 27's own splitter, found by pointing it at a second corpus

`sentencesOf` split on `/(?<=[.;:!?])\s+/`, which never fires when a bolded
sentence ends `call.**` — the character before the space is an asterisk. So
`**Two boxes, and neither is a judgement call.**` and the parenthetical that
follows it were **one** sentence, and the parenthetical's "This heading has
outlived two revisions of its own count" silently exempted the false count in
front of it. The guard reported that claim green on its first run.

This is 27's paragraph-scope bug in miniature — an exemption drifting one clause
too wide — and it was found the same way: by asserting the polarity rather than
the cleanliness. The splitter now ends a sentence at its punctuation *plus any
closing emphasis or quotation that trails it*, in `spec-claims.ts` where the one
splitter lives, and the spec suite is unchanged at **32 pass** over it. Both
corpora are governed by the fix.

### Proving the guard fails, and that it cannot pass empty

Measured in-process against the real ticket, one mutation at a time, in
`describe("the guard fails on drift")`:

| Mutation | Result |
|---|---|
| status line `(**one box open**` → `(**three boxes open**` | fails — states 3, derived 1 |
| the still-open lead → `**Two boxes, and neither is one.**` | fails — the section-scoped binder |
| "returns one" → "returns five" in the provenance note | fails — states 5 |
| **one box ticked and no prose touched** — the wave's actual defect | **3 fails**, every one of them `derived 0, stated 1` |
| one `- [ ]` appended below the prose that counts them | **3 fails**, every one `derived 2` |

The fourth row is the one worth naming: it is precisely what the three agents
did on three branches in one wave, and it is the case no human-maintained number
can survive.

`describe("the guard is not vacuous: an empty parse does not pass")` holds the
other polarity, in five ways:

- an **empty corpus** yields no claims, so `driftedBoxClaims` is empty and
  *looks* green — the assertion that must go red is the non-emptiness one above
  it, and the test asserts that it throws;
- a corpus of **prose with no boxes at all** fails the same floor;
- **every binder broken at once** — all seven patterns replaced with one that
  matches nothing — yields zero claims and fails the floor. The binders are a
  parameter of `boxCountClaims` for exactly this, so the broken state is
  executed rather than described;
- a **marker vocabulary broad enough to excuse every claim** leaves zero live
  claims, and the floor catches that too. This is 27's own lesson turned on this
  guard: exemption growing until nothing is governed must fail, not pass;
- and the exempt half is **measured rather than bounded**: 6 of the 11 bound
  statements are quotations. That is a majority, and unlike the specs' 135 path
  references it is the honest state of one file that narrates three revisions of
  its own count, so it is reported rather than capped. The floor on *live*
  claims is what keeps the exemption from growing.

### Not firing on the 92 `done` tickets whose boxes are all unticked

This is the failure mode that would have got the guard deleted on the day it
landed, so it is asserted from three directions, all by shape and none by name:

- the population is derived — `**Status:**` begins "done", `- [x]` count is
  zero, `- [ ]` count is not — and there are **92** of them. The suite asserts
  that population is at least 80, so that the test below can never go vacuous;
- **not one of those 92 yields a claim**, let alone a violation;
- and the shape is asserted directly: a synthetic ticket whose status is `done`,
  carrying three boxes with none of them ticked and no prose count, yields
  **zero** claims. `done` is never read
  as "zero boxes open". `forecaster/28` is `done`, merged, with all five boxes
  `- [ ]`, and it is found by that shape rather than by its name.

The `**Status:**` line is the authority on whether a ticket is finished, and
nothing here reads a box's state as a verdict on the ticket.

### The sweep, and what is not checkable — with the check used

Statuses were surveyed first, as the ticket required
(`grep -H -m1 '^\*\*Status:\*\*' <lane>/issues/*.md`). What actually exists in
130 tickets is: `done` (bare), `done — <clause>`, `done (<clause>)`,
`done (machinery); <clause>`, `done for <half>; <clause>` and exactly one
`landed (first half; the three card fields are not this ticket)`. No
`ready-for-agent` and no `not started` survive in the tree — every ticket in
this snapshot is closed or partly closed in prose — so the enum-shaped statuses
the brief anticipated are named here as **absent** rather than handled
speculatively.

| Class | Count | Verdict | Check |
|---|---|---|---|
| Tickets stating a count of their own open boxes | 2 files, 11 statements — 3 files and 18 once this ticket exists | 5 live / 6 quotations | the binders |
| — live and **true** when found | 3 | true | status line, provenance grep, and "is now one" in `api-surface/10`; plus `forecaster/18`'s "its other four boxes" against its 4 open boxes |
| — live and **false**, now fixed | 3 | false and fixed | the three above |
| Tickets stating no count about their own boxes | 128 | not checkable — nothing claimed | no prose count; `- [ ]` and `**Status:**` both read, neither compared |
| `data-platform 21`, written mid-wave on another branch | 1 | not checkable — nothing claimed | run through the binders from `git show`: 2 open, 5 ticked, no count stated, zero claims |

**What is out of scope, and why — named, not skipped:**

- **A bare `**Status:** done` is not a claim of zero.** Reading it as one would
  fire on 92 tickets that are legitimately done with their boxes unticked. This
  is the ceiling of the whole guard and it is where it belongs: the prose says
  what is left, and only when it says so can it be checked.
- **Deltas — how many boxes a pass *moved*, *closed* or *ticked*.** "Four of
  those six are now closed" and `forecaster/18`'s "Why exactly one box moved"
  are true of a *history*, not of a file: `api-surface/10` has fifteen `- [x]`
  lines and no sentence claiming fifteen. A delta is not derivable from the
  file's current state, so nothing is bound to `- [x]`. This is the honest half:
  it is also the shape a future defect could hide in.
- **Counts of another file's boxes.** `api-surface/09` says "the last three
  boxes were ticked on arrival" about *product-fixes 01*'s checklist. Verified
  by hand — `product-fixes/01` has five boxes and all five are `- [x]`, so the
  sentence is **true** — but the referent is not the file the sentence is in, and
  a self-count binder that claimed it would be guessing. This class is enforced
  mechanically rather than trusted: a sentence naming a lane and a number, or a
  `NN-slug.md` filename, is not read as a self-count.
- **Counts inside code fences, transcripts and table cells.** A specimen is not
  an assertion and a table cell is not a sentence; both are removed before the
  prose is split. Stated plainly as the cost: a count stated *only* in a table
  is not governed. None of the three real defects was in a table, and the shape
  that matters — the status line — is prose by construction.
- **"Boxes" that are not checkboxes.** `replay/10` argues that "three boxes
  would imply three facts" about *headline tiles on a screen*. Every binder
  requires an openness word beside the count or a still-open heading around it,
  which is what keeps that sentence out; the three shapes above are held out by
  a test that feeds them all in as decoys and asserts zero claims.
- **Whether an open box is genuinely open work.** Not derivable from any file
  and not attempted. `api-surface/10`'s one remaining box needs a promoted
  artifact that does not exist in this repository; no guard can tell that from a
  box that nobody has got to yet.
- **Prose about intent, judgement and dependency.** Most of every ticket, and
  rightly so.

### One thing this ticket names rather than closes

The three reproductions all happened in the same place — the status line and the
sections beneath it of one long ticket. A ticket that never states a count can
never state a wrong one, and 128 of 130 take that option. So this guard makes
the *stated* count honest; it does not make tickets state one. Whether a status
line should be required to carry its count is a policy question about how this
repository writes tickets, not a fact about the tree, and it is left open
deliberately: a guard that demanded a count in 130 files would be a guard that
130 files were edited to satisfy, which is the human-maintained list this ticket
was written to avoid.

A grep for `- [ ]` in this file returns zero, and every box above is ticked
against work that was actually run.

### Commands

```
bun run check          # exit 0
bun run typecheck      # clean
bun run lint           # 530 files, clean
bun run test:hygiene   #  169 pass, 0 fail (24 of them this ticket's)
bun run test           #  169 + 471 + 1256 + 189 pass, 0 fail, 549 skip (gated)
```

No database was used or needed. `fc18-pg` on port 5434 was not touched.
