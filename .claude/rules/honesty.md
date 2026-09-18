# Honesty

The product's one differentiator is that a reader can trust every figure on it.
These rules are not style; breaking one is a defect of the same class as a wrong
number, and several of them are enforced by tests that will fail you.

`docs/domain-model.md` §4, §9 and §10 are the authority. This is the operating
version.

## An absence is a claim

A figure the product does not have is rendered as a **stated absence with a
typed reason** — never a zero, a blank, a dash with nothing behind it, or a
skeleton that never resolves.

The wire shape is `null` beside a `*_unavailable_reason`. The schema makes the
pair required so that a null without a reason is unrepresentable, and
`packages/core/test/vocabulary-rules.test.ts` holds it.

- `avoidability` is `null` — never `0` — when the baseline is zero.
- `band` is `null` with `band_unavailable_reason: "no_joint_ensemble"` when no
  national row was published.
- `deviation_mwh` is `null` with `no_programme_published` / `day_not_settled` /
  `partial_overlap`, because a deviation over the hours that happen to overlap
  would be printed under a label that says "the day".

On screen, the absence is a sentence a reader can act on. "Nothing here"
is not one.

## No quantile adds

**Expectations add exactly. Measurements add exactly. Bands never do.**

The median of a sum is the sum of the medians only when the components move
together, and four subsystems' curtailment does not. Any code that appears to
add a P10/P50/P90 is either a bug or is computing something else.

- The national forecast figure is the **summed expectation** plus a count of
  subsystems per risk class, and the national *band* is read from the persisted
  joint row (`curtailment_forecast_national_day`), computed over the four day
  totals **on the same draw**. It is never assembled in the gateway.
- The national observed total *is* legitimate: `NationalNow.derived` is the
  field `sum_of_four`, stated on the wire so nobody mistakes it for ONS's `SIN`
  row — which WattSteer never uses, because it would double-count the four.

## Observed and forecast are two vocabularies

A settled megawatt-hour and a modelled risk class are not two renderings of one
fact, and the screens keep them apart in colour, in words and in type.

- The observed ramp's colours and the risk palette are **provably disjoint** —
  `apps/web/test/observed-overview.test.ts` checks it over the whole domain, not
  at four sample values.
- No observed label may say "previsão", "risco", "esperado" or a quantile. The
  same test holds a closed vocabulary per locale, and every label that heads a
  figure must say it is settled.
- A component that draws observed data may not import the forecast vocabulary.

When you add an observed panel, add its label to that test's `LABELS`. When you
add a forecast one, make sure nothing about it can render without a forecast.

## Say which model, and whether one is serving

Never state the deployment's condition from a constant. `/v1/meta` is the one
read that knows which lane is promoted and usable, and `useServing` is its
single copy in the web app.

Two defects of exactly this shape shipped in one week: a lede that said "nenhum
modelo está promovido" above a promoted lane, and Explicar asking for a
hard-coded lane's model card and reporting that lane's refusal as the
deployment's. Both are in the git log. Read the lane; do not assume it.

## The product forecasts *how much*, never *why*

The model predicts curtailed energy. The **reason** is ONS's, read from the
settled record, and the screens say so wherever a cause appears. There is a
causality guard in `test/` that fails on causal language reaching a user-facing
surface.

## Before you finish

| Mistake | Fix |
| --- | --- |
| `?? 0` on a figure that may be absent | `null` + a typed reason, rendered as words |
| A band summed, averaged or interpolated across subsystems | the persisted joint row, or a stated absence |
| An observed figure under a forecast label | the observed vocabulary, and the disjointness test updated |
| "No model is promoted" written as a constant | read `/v1/meta` through the one hook |
| An empty list standing in for "we could not measure" | say which of the two it is |
