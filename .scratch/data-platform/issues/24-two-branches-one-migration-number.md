# 24 — Two branches cut from one tip both generate `0046`, and nothing says so until the merge

**What to build:** a guard over the migration ledger — the directory, the
journal and the snapshot chain — so that a numbering collision, a journal that
disagrees with the files beside it, a missing or orphaned snapshot, and a
document naming a migration that no longer exists all fail a test instead of
being found by hand.

This one cost a manual renumber today, twice over, and it recurs every time two
branches are cut from the same tip.

Data-platform 22 and 23 were branched from one commit. Both ran `drizzle-kit
generate`, both were handed `0046`, and neither could see the other:
`0046_a_parse_that_landed.sql` (four columns on `ons_resource_version`, since
renamed to `0047_a_parse_that_landed.sql` and no longer at that number) and
`0046_the_plant_grain_is_a_source.sql` (two members on `ingestion_source`).
Different tables, neither wrong, and nothing in the two branches was in
conflict in the sense git understands — two *new* files with different names
merge cleanly. It surfaced hours later, at merge time, as an add/add conflict on
`meta/0046_snapshot.json`: the one file both branches had happened to write to
the same path. The repair was by hand — keep one, delete the other, regenerate
against the merged schema as `0047`, diff the DDL to prove nothing was lost,
rename to the house convention, and hand-repair `meta/_journal.json`.

Then the renumber broke a reference, and the second half of the cost was the
interesting one. `docs/specs/data-platform.md:395` named
`drizzle/0046_a_parse_that_landed.sql`, a file that no longer existed;
api-surface 27's path guard caught that, because its corpus is `docs/specs/`.
`.scratch/data-platform/issues/22-a-thrown-parse-is-never-retried.md` carried
the same stale name in its own `Status:` line and **nothing caught it**. It was
found by grepping afterwards, which is not a control.

Both halves are mechanical. Neither needed judgement to detect; both needed
somebody to remember to look.

**Blocked by:** None. Data-platform 22 and 23 are merged and the repair they
needed is the evidence.

**Status:** done — `test/migration-ledger.test.ts`

- [x] **Two migrations sharing a number fail a test, in the tree.** The
      filenames are grouped on their own numeric prefix; there is no roster of
      migrations anywhere in the file and nothing to keep in step. Replayed
      against the real directory, the 2026-09-10 collision fires five
      independent assertions — the duplicate check, the head-derivation
      (`max(number)` must equal `files.length - 1`), the journal-per-migration
      count, the snapshot count, and the journal's own file/entry pairing
- [x] **The journal is checked against the directory it describes, in four
      ways:** an entry whose `tag` has no `.sql` file, a `.sql` file with no
      entry, an `idx` that is not the entry's position *or* is not its tag's
      own number (drizzle assigns both from one counter, so they are two
      statements of one fact and either can rot alone), and entries out of
      order by `idx` or by `when`. This is the check written for the
      hand-repair: resolving a journal by hand is exactly the edit that
      silently goes wrong, and a wrong journal is not inert — `drizzle-kit
      migrate` walks *it*, not the directory, so an entry dropped in a merge is
      a migration that never runs and never complains
- [x] **A snapshot missing for a migration, or orphaned by one**, in both
      directions, derived from the migration numbers found. The orphan half is
      not hypothetical: `meta/0046_snapshot.json` is the file the merge actually
      conflicted on, and finishing that deletion was a manual step
- [x] **Gaps in the numbering**, with the expected sequence derived from the
      count of migrations found rather than from a stated head. `n` migrations
      occupy `0000`…`n-1`; nothing in the file says what `n` is
- [x] **Extended to named references, over the whole tree rather than
      `docs/specs/`.** Every `*.md` in the working tree is scanned for the
      `NNNN_lowercase_words` shape, in prose or in a path, with or without the
      `.sql`, and a name no migration answers to is a violation. 50 references
      across 20 documents today (203 markdown files scanned), 46 resolving and
      4 excused by prose that says the name is gone. A reference whose *number*
      exists but is held by a different migration is reported as such — the
      renumber defect's exact signature, and the difference between "this name
      is wrong" and "this name was renumbered out from under you"
- [x] **The guard can fail, by mutation.** Each proof plants its defect in a
      scratch copy of `drizzle/` — never in the real one, because
      `apps/api/README.md` forbids editing landed migrations for any reason and
      a guard that broke the rule it guards would deserve deleting. Planted: the
      2026-09-10 collision verbatim; a migration deleted out of the middle
      (`gap at 0020`); a journal entry dropped by a hand-repair (the missing
      entry *and* the seventeen following entries now one position off their
      own `idx`); a journal tag retyped (caught from both sides at once); the
      last two entries swapped (position and a `when` that runs backwards); the
      head snapshot deleted beside an orphan left behind; and 22's `Status:`
      line restored to the stale name it carried this morning
- [x] **The guard can fail, by starvation.** Every check returns `[]` over an
      empty ledger — which is exactly what clean looks like — so that is
      asserted, out loud, and then the non-emptiness assertions are run against
      the same empty ledger and asserted to *throw*. Same for an empty markdown
      corpus, for a tree walk that finds no `.md`, and for the polarity that
      matters: an empty ledger must make every named migration rotted, never
      resolved. This repository has shipped four guards that read green while
      governing nothing, and api-surface 29 found 27's own sentence splitter
      blind on its first run

## The argument for extending it past `docs/specs/`, since it was a judgement call

Against: the tickets are a working record, not a contract. They are written in
the past tense about a tree that has moved, they cite things that were true when
written, and a guard that reddens the suite because a six-month-old ticket names
a file somebody renamed is a guard people learn to route around. `docs/specs/`
is the corpus api-surface 27 chose deliberately, and the reason it gave — the
specs are what an agent reads to decide what to build — does not transfer to a
scratchpad.

For, and this is what decided it: **a migration name is not an ordinary file
path.** It is an identifier the repository assigns, never reuses, and — per the
README — never edits after it lands. A ticket's `Status:` line naming its
migration is the one durable link between "why this exists" and "what ran
against the database", and it is the link an agent follows when it wants to know
what a change actually did. When that link rots, the reader does not get an
error; they get `0046`, which now exists and is a *different migration on a
different table*. That is worse than a broken path — it is a plausible wrong
answer, and it is precisely what this morning's renumber created in two files.

The scope is narrow enough to be safe. Not all file references in tickets, which
would be 27's corpus problem with none of its care: only names of this exact
shape, which the repository mints and controls. And the escape hatch is the same
closed vocabulary of English 27 uses — a paragraph that says a migration was
`renamed`, `replaced`, `no longer` exists, is excused. Three markers are added
here and earn their place on one real case: api-surface 28 names
`0043_crazy_typhoid_mary.sql`, which `drizzle-snapshot.test.ts` generates into a
throwaway copy of `drizzle/` and never commits. That is a true sentence about a
file that correctly does not exist, and the alternative to a marker was a
hardcoded exception — the one thing this guard refuses to be. The cost is stated
in the file: a paragraph that uses one of those words *and* carries a rotted name
gets a free pass, which is why the census is asserted separately (resolved
references must outnumber excused ones four to one, so the exemption cannot
quietly become the rule).

One shape is excluded rather than excused: `meta/0046_snapshot.json` wears the
migration shape and is not a migration. It is named all over this repository's
prose, including this ticket, and counting it would have reddened documents that
are entirely correct. Snapshots are checked against the directory by the
snapshot check, from the files rather than from prose, which is the right place
for that claim. The guard caught this the first time it read this very ticket —
alongside a stale `0046_a_parse_that_landed.sql` in the paragraph above, which
is now marked as renamed, because it is.

## What this ticket does not do

- **No wrapper around `drizzle-kit generate`.** It was on the table and it was
  dropped on purpose. A helper that picks the next free number is bypassed by
  anyone who runs the plain command the README tells them to run, and — more to
  the point — it *cannot work*: the collision is between two branches that
  cannot see each other's files, so both wrappers would compute the same next
  number and both would be right. Nothing at generation time can detect this.
  Only something that reads the merged tree can, which is what the guard is
- **It checks bookkeeping, not DDL.** Two migrations that contradict each other
  semantically, a snapshot that is *stale* rather than absent, a migration whose
  SQL was never applied anywhere — none of that is visible from here.
  `apps/api/test/drizzle-snapshot.test.ts` covers head-snapshot drift by
  regenerating; this covers the shape of the ledger around it, which is the half
  that had no cover at all
- **It does not resolve the collision, only surface it.** The repair is still
  the manual sequence 22's merge went through, and it is still the right one.
  What changes is when it starts: at the first `bun run check` after the merge,
  named as a numbering collision, rather than as an add/add conflict on a
  snapshot file that says nothing about why
- **The markdown corpus is not the whole tree.** A migration named in a comment
  in a `.ts` file is unchecked. The names live in prose, and widening to source
  would have meant deciding what a name in a string literal means — worth doing
  if one ever rots there, not worth guessing at now
