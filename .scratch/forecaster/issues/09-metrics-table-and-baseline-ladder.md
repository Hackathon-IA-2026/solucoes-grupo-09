# 09 — The metrics table and the baseline ladder, on identical folds

**What to build:** for every rung of the ladder, every run and every fold, one
populated metrics table — so that "the model adds value" is a measured delta
against the baseline a domain expert would use by hand, and not a chart.

Five rungs, all evaluated on identical folds, identical rows, the same
threshold and **the same composition arithmetic** — a rung that cannot naturally
produce a quantile still produces one, by the same mixture inversion, because
the ladder compares models and not model families' conventions:

| # | Rung | Why it is on the ladder |
|---|---|---|
| 0 | Prevalence | gives PR-AUC its floor |
| 1 | Same-hour 7-day (mandatory) | the baseline a domain expert would actually use, and the cold-start bar for the gate |
| 2 | Logistic + linear quantile regression | the interpretable rung |
| 3 | Random forest / quantile forest | separates "non-linear" from "needs boosting" |
| 4 | LightGBM | the served model |

Rung 1 is computed **from the same feature function as the model**, so the
baseline and the model cannot disagree about what "the last seven days" means.
Rungs 2 and 3 cannot take NULLs, so they get training-median imputation **plus
an explicit null-indicator column**, and the table marks them — a ladder that
quietly gave the weak rungs a different vector would be measuring the imputation.

The gate's metric is **`qloss_mwh`**, the mean pinball loss of the composed
hourly distribution averaged over the three served quantiles. It is the one
number because it scores the *composed* prediction — a candidate that improves
the classifier while degrading the magnitude model passes PR-AUC or MAE and
makes the product worse — because it is proper for the thing shipped, because it
is denominated in the product's own units, and because it needs no operating
point that could be chosen to make the gate pass. Recall stays in the table with
a guardrail; it is not the gate because it is trivially maximised by predicting
curtailment always.

Everything else in the table: prevalence; PR-AUC per subsystem; Brier, ECE, MCE,
top-bin gap; F1/precision/recall at the fixed calibrated 0.5 and, reported but
never used, at the best threshold; MAE and sMAPE on positives; the three pinball
components; coverage per subsystem and local hour; mean interval width, because
a wide interval covers by cheating; P50 unbiasedness; crossing rate; the two
conformal corrections; day-total and peak coverage; the ticket-011 block; and
`vintage_fidelity`, which is never averaged across values.

The revision premium is published: the first fold to exist in both forms —
scored once against the labels as ingested at the time and once against the
latest vintage — yields the measured size of the caveat every earlier number
carries.

**Blocked by:** 03, 05, 06.

**Status:** done

- [ ] All five rungs run on the shared fold calendar and produce a full metrics
      row each, per fold and per subsystem where the grain says so
- [ ] Every rung's band comes from the composition function, including the
      prevalence and 7-day rungs
- [ ] Rung 1 is computed from the feature function, not a separate query
- [ ] Rungs 2 and 3 are imputed with an explicit null indicator and the table
      marks them; nothing on the LightGBM path is imputed
- [ ] `qloss_mwh` is implemented on the composed distribution and is the only
      metric the gate will read
- [ ] Every metric carries the `VintageFidelity` of the fold that produced it,
      and no aggregation averages across differing values
- [ ] `revision_premium_qloss` is published for the first fold that exists in
      both vintages
