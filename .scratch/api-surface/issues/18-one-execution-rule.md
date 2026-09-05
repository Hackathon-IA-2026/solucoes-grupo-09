# 18 — There is exactly one implementation of the execution rule in this repository

**What to build:** the Mitigate screen calls the real solver, and the web app's
second copy of the execution rule is **deleted**.

There are two implementations today: the prototype's plan evaluator in the web
app, and the one the optimizer spec places in the modelling service. The replay
spec requires a structural test that exactly one exists. That test fails today,
and it should.

**Keeping them in parity is not an option**, because the prototype's copy is
known to be **wrong**: it clips absorption but not state of charge, so on a low
realisation it reports a battery filled with energy it never received. Maintaining
a known-broken second copy in the name of parity is worse than either fixing it
or deleting it, and deleting it is what the specs require.

**So the deletion and the wiring are one change.** Mitigate must call the
optimizer route before the fixtures come out, because deleting the evaluator is
what leaves the screen with nothing to compute against.

The structural test that counts implementations is what keeps them deleted, and
it runs over the whole repository including the web app, in the default test run.

**Blocked by:** 17.

**Status:** done

- [ ] The Mitigate screen calls the optimizer route and renders its result
- [ ] The web app's plan evaluator and dispatch planner are deleted, not ported
- [ ] A structural test asserts exactly one implementation of the execution rule exists in the repository, and it passes
- [ ] The test runs in the default test command
- [ ] The screen renders a null avoidability as an absence with its "undefined, not zero" explanation, never as a zero
- [ ] Every result the screen shows carries the threshold and the forecast origin it was optimised against
