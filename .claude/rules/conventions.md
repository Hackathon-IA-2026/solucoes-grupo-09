# Conventions

## Comments carry the argument, not the code

This repository's file headers are its best documentation, and they are written
for the reader who is about to change the thing. A comment earns its place by
saying **why this shape and not the obvious one**, ideally with the measurement
or the incident behind it.

- Do not narrate what the next line does.
- Do not add a block comment to every function because the file has some.
- Never delete an existing commented-out block or explanatory comment because it
  looks stale — it is usually a recorded decision.
- A comment that *describes the fix* while the code below carries the bug is
  worse than no comment. That happened to the `ml` Dockerfile's cache-mount id
  and cost every deploy of that service.

## Biome

`bunx biome check` — every group on, with disabled rules listed and justified in
`docs/lint-policy.md`. `noExcessiveCognitiveComplexity` is **deliberately off**
repository-wide; do not "fix" complexity by splitting a function whose branches
are one decision.

The baseline is **2 errors** (both `noCommentText` in `apps/web/src/app/app/
replay.tsx`). Compare against it. `bunx biome check --write` fixes formatting;
run it before you commit, because the formatter reflows ternaries and a
source-level test asserting exact spelling will break.

A suppression carries its reason on the line above, in prose:
`// biome-ignore lint/correctness/useExhaustiveDependencies: <why>`.

## Commits

**English, always**, whatever language the conversation is in. The message is
the record of *why* — `CONTEXT.md` names commit messages as one of the three
places architectural reasoning lives, and `git log -S` over a symbol is often
faster than searching the code.

Write what changed, what it was before, and what evidence you have. State the
measurement where there is one. If a test caught you, say so — several messages
in this log do, and they are the most useful ones.

End with what was verified, in numbers: suites run and counts.

Before pushing, `git fetch` and confirm `origin/main` is an ancestor. The
standing instruction is that `main` must be up to date before a push.

## Naming

Domain nouns come from `docs/domain-model.md` and nowhere else. The wire is
`snake_case`, the TypeScript is `camelCase`, and the translation table is
**generated** from the schema — never hand-written, because the rule-based
version is lossy on `last_24h_*`.

Files are kebab-case. A `.tsx` exports components only (ADR-0002).

## Dependencies

Adding one is a decision with a reason. Two were dropped and the ADR excusing
them corrected, because nothing imported them. Prefer the platform: this app
ships one chunk (ADR-0007) and a dependency that duplicates a token, a
formatter or a date helper is a regression.

## Claims

Verify before you assert. "Typecheck clean" has been claimed in this repository
without running lint, and a 32-failure suite has been reported as green from a
truncated tail. If you did not run it, say you did not.

When you are corrected, fix it and move on — the correction belongs in one
sentence, not in a retrospective.
