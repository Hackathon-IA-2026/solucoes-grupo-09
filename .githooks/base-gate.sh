#!/bin/sh
#
# The merge gate: refuse to create a merge commit whose incoming branch does not
# already contain a freshly-fetched `origin/main`.
#
# `scripts/preflight-base.ts` has existed since 898c6b1 and decides the whole
# question. The only thing this file adds is that nobody has to remember it. It
# is sourced by `pre-merge-commit` and by `pre-commit`, which are the two hooks
# git runs on the two paths that produce a merge commit — see those files.
#
# The *incoming* branch is the ref under question, not `HEAD`. The hazard is a
# ticket cut behind the tip merging a regression over work it never saw, so the
# ref that decides it is the one coming in. Reading `HEAD` here would also
# refuse the harmless case — a current branch merged into a local `main` that
# has drifted — and a gate that fires on the harmless case is a gate that gets
# switched off.
#
# Finding that ref takes two attempts, and this is the part worth reading:
#
#   * On the conflicted path, `git commit` finishes a merge that already wrote
#     `MERGE_HEAD`, so `MERGE_HEAD` resolves.
#   * On the clean path, `pre-merge-commit` runs *before* `MERGE_HEAD` is
#     written. Measured, not assumed: `git rev-parse MERGE_HEAD` in this hook
#     prints nothing and exits non-zero, and the guard's own fail-closed
#     `unreadable-ref` verdict then refused every merge, healthy ones included.
#     A gate that refuses everything gets deleted within the hour. What git does
#     provide at that moment is one `GITHEAD_<sha>=<name>` variable per head
#     being merged, so the shas come from the environment instead.
#
# If neither attempt finds a head, that is a refusal too. Not knowing what is
# being merged is not a reason to allow it.
#
# It also fails closed when `bun` is not on PATH. A gate that waves the merge
# through whenever it could not run is the vacuity failure the guard itself was
# written against, one level up.

set -eu

root=$(git rev-parse --show-toplevel)

heads=$(git rev-parse --verify --quiet MERGE_HEAD || true)

if [ -z "$heads" ]; then
  # One per head, so an octopus merge is checked head by head rather than
  # partly checked.
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

for head in $heads; do
  echo "base guard: checking the commit being merged ($(echo "$head" | cut -c1-7))"
  bun run "$root/scripts/preflight-base.ts" "$head" || exit 1
done
