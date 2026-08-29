# 04 — Stop the next hardcoded English string

**What to build:** a check that fails when user-visible copy is written inline
instead of going through the dictionaries.

Every string on the landing page already lives in `src/i18n/`, and the `Copy`
type makes a *missing* translation a compile error. What nothing catches is a
new component shipping with English text baked into JSX — which is exactly how a
bilingual site quietly becomes monolingual again, one screen at a time.

The standard tool (`eslint-plugin-i18next`) is not in this toolchain, so this is
a repo-level check in the shape of `test/repo-hygiene.test.ts` — which already
demonstrates the pattern by forbidding a token repo-wide.

Scope it honestly: `apps/web/src/app/**` and `apps/web/src/components/**`, with
an allowlist for the domain terms that stay untranslated in both locales
(constrained-off, conjunto, ONS, ANEEL, DESSEM, SIGA, BESS, SOC, the reason
codes, `P10–P90`), test IDs, and accessibility identifiers that are not copy.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] A new inline English string in a component fails the check
- [ ] Domain terms that stay untranslated do not trip it
- [ ] Test IDs, route names and other non-copy identifiers do not trip it
- [ ] It runs in the default `bun run test`
- [ ] The existing tree passes, or every exception is listed with a reason
