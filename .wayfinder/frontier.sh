#!/usr/bin/env bash
# Open, unblocked, unclaimed tickets — the edge of the known.
cd "$(dirname "$0")/tickets" || exit 1
closed=$(grep -l '^status: closed' *.md 2>/dev/null | sed 's/^\([0-9]*\)-.*/\1/' | tr '\n' ' ')
for f in *.md; do
  grep -q '^status: open' "$f" || continue
  grep -qE '^assignee: *$' "$f" || continue
  deps=$(grep -m1 '^blocked_by:' "$f" | grep -oE '[0-9]{3}')
  ready=1
  for d in $deps; do case " $closed " in *" $d "*) ;; *) ready=0 ;; esac; done
  [ $ready -eq 1 ] && printf '%s  %s\n' "$(grep -m1 '^type:' "$f" | sed 's/type: wayfinder://')" "$(grep -m1 '^title:' "$f" | cut -d' ' -f2-)"
done
exit 0
