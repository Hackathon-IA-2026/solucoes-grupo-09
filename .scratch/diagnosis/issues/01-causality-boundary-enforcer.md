# 01 — The §26 boundary becomes a test, not a review

**What to build:** the product cannot ship a surface that claims to explain why
the grid curtailed. WattSteer says the **model raised or lowered its forecast**;
it never says a condition **caused** curtailment, and the phrase "Causal AI"
appears nowhere, marketing copy included.

Today that rule lives only in a spec paragraph, which means it survives exactly
as long as the next session that reads it. This ticket turns it into a
build-time check in the same shape as the repo-hygiene test that already fails
when the old product name returns, and into an allowlist that cannot rot.

Scope of the scan: the web app's source, the shared UI package, every message
catalogue in both locales, and the narration system prompt once it exists. The
banned lemma set, case-insensitive, both locales:

```
causal, causality, causal ai, root cause, caused by, causes the,
because the grid, why it happened, driver of the event,
causa, causal, causou, causado por, causa raiz, porque ocorreu
```

Exceptions are an allowlist module, one entry per permitted occurrence, each
carrying the string, its location and a reason. The only expected entries are
the disclaimers that *use* the word in order to deny the claim.

This ticket ships first because it needs no model, no artifact and no endpoint,
and because every later ticket that writes copy is checked by it.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] A planted banned lemma in a message catalogue fails the check
- [ ] Moving that string to the allowlist with a reason makes the check pass
- [ ] An allowlist entry whose string no longer appears anywhere fails the check
- [ ] Both locales are scanned; Portuguese lemmas trip it as reliably as English ones
- [ ] Domain proper nouns that merely contain a banned substring do not trip it
- [ ] The rule itself is written down once, in a place a later session will find, so the test's intent is citable
- [ ] It runs in the default test command with no network and no database
