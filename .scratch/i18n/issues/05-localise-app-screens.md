# 05 — Localise the four product screens

**What to build:** the `/app` screens speak both languages.

The landing page is fully localised; the four product screens are not — every
string in them is hardcoded English, including the ones that carry the honesty
the product is built on: the vintage badges, the in-sample replay warning, the
risk-class names, the "quantiles do not add" notes. A Portuguese-speaking grid
operator currently reads the marketing in Portuguese and the product in English.

This is the largest copy surface left. It also raises a question the landing
page never had to answer: the screens render values from fixtures (and later the
API), so number, date and unit formatting has to be locale-aware — decimal
comma, `pt-BR` grouping, R$ currency, and timestamps in `America/Sao_Paulo`
regardless of the viewer's timezone, because a grid hour is a Brazilian hour.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Every user-visible string in `app/app/**` and `components/app/**` comes from the dictionaries
- [ ] Chart axis labels, legends and accessibility labels are localised
- [ ] Numbers use `pt-BR` grouping and a decimal comma in Portuguese
- [ ] Currency is always BRL; timestamps are always `America/Sao_Paulo`
- [ ] Domain terms stay untranslated in both locales, per the allowlist
- [ ] The guard from ticket 04 passes over these directories
