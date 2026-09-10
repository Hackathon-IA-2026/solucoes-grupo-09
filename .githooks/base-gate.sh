#!/bin/sh
#
# The merge gate: refuse to create a merge commit that would not contain a
# freshly-fetched `origin/main`.
#
# `scripts/preflight-base.ts --merge` decides the whole question; the only
# thing this file adds is that nobody has to remember to ask it. It is sourced
# by `pre-merge-commit` and by `pre-commit`, the two hooks git runs on the two
# paths that produce a merge commit — see those files.
#
# ## The contract changed once, and the reason is kept rather than deleted
#
# The first version asked whether the *incoming* branch contained
# `origin/main`. Tried against this repository's own history, that rule refused
# two of the first three merges it was pointed at — `Merge forecaster 27` and
# `Merge data-platform 20` — because `main` moved between cutting the branch
# and merging it. That is the ordinary shape of a topic-branch merge here, and
# a gate that fires on the ordinary case is a gate that gets switched off. It
# also refused its own merge, which is how it was found.
#
# It was wrong about the risk too. Git's three-way merge does not drop the work
# an old branch never saw. What a stale branch really costs is semantic — code
# written against an API that has since moved — and by merge time that is
# already paid. The check for that is `bun run preflight` when work *starts*,
# which still reads HEAD and still refuses.
#
# So this gate guards what a merge can still protect: the result is current. A
# stale incoming head is now printed as a note and allowed.
#
# ## Finding the heads takes two attempts, and that part is unchanged
#
#   * On the conflicted path, `git commit` finishes a merge that already wrote
#     `MERGE_HEAD`, so `MERGE_HEAD` resolves.
#   * On the clean path, `pre-merge-commit` runs *before* `MERGE_HEAD` exists.
#     Measured, not assumed. What git does provide is one `GITHEAD_<sha>`
#     variable per head being merged, so the shas come from the environment.
#
# Finding no head at all is a refusal: not knowing what is being merged is not
# a reason to allow it. So is a missing `bun` — a gate that waves the merge
# through whenever it could not run is the vacuity failure the guard itself was
# written against, one level up.

set -eu

root=$(git rev-parse --show-toplevel)

heads=$(git rev-parse --verify --quiet MERGE_HEAD || true)

if [ -z "$heads" ]; then
  # One per head, so an octopus merge is decided whole rather than partly.
  heads=$(env | sed -n 's/^GITHEAD_\([0-9a-f]\{40\}\)=.*/\1/p')
fi

if [ -z "$heads" ]; then
  echo "REFUSED: could not tell which commit is being merged." >&2
  echo "  Neither MERGE_HEAD nor a GITHEAD_* head was readable, so the base" >&2
  echo "  guard has nothing to check. This is a refusal, not a pass." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "REFUSED: bun is not on PATH, so the base guard could not run." >&2
  echo "  This repository is bun-only; install bun, or bypass deliberately" >&2
  echo "  with 'git merge --no-verify' if you have checked the base by hand." >&2
  exit 1
fi

# Quoting is deliberate: `$heads` is a newline-separated list and must word-split
# into one argument per head.
# shellcheck disable=SC2086
exec bun run "$root/scripts/preflight-base.ts" --merge $heads
