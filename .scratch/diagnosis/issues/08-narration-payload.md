# 08 — The renderer's entire world, assembled and closed

**What to build:** the one JSON document a narration is ever allowed to see, and
the canonical form of it that everything downstream is keyed on.

The rule the whole renderer design rests on is **"the renderer may not
compute"**, and that rule is only enforceable if nothing the copy could want
requires computing. So every derived figure is pre-computed into this document
as a number. `top_two_share` is the worked example: it looks redundant and is
not — the prototype's own fixture narration adds two shares together, and a
narration that performs correct arithmetic is indistinguishable from one that
hallucinated a plausible number.

The document, with the fields that encode decisions rather than data:

```jsonc
{
  "schema_version": "diagnosis.narration.v1",
  "prompt_version": "…", "locale": "pt-BR",
  "subsystem": "NE", "subsystem_display_name": "NORDESTE",  // ONS's proper noun, untranslated
  "target_date": "…", "threshold_mw": 5,
  "forecast_origin": { "run_label": "…", "gate_profile": "gate_late", "published_at": "…" },
  "vintage_fidelity": "point_in_time",
  "risk": { "day_occurrence_probability": …, "risk_class": "high", "hours_p50_nonzero": … },
  "magnitude": { "day_expected_mwh": …, "baseline_expected_mwh": …,
                 "day_energy_p10_mwh": …, "day_energy_p50_mwh": …, "day_energy_p90_mwh": …,
                 "peak_power_p50_mw": …, "peak_hour_local": 13 },
  "attribution": {
    "target": "expected_mwh_day",
    "total_attributed_mwh": …, "sum_abs_attributed_mwh": …, "stderr_mwh": …,
    "top_two_share": …,                       // pre-computed: the renderer may not add
    "groups": [ { "code": "net_surplus", "label_code": "driver.net_surplus",
                  "phi_mwh": …, "share": …, "direction": "raises",
                  "headline_feature": "…", "observed": 1.42, "typical": 0.96,
                  "unit": "ratio", "hour_disagreement": 1.1, "demoted": false } ]
  },
  "rule_flags": [ { "code": "stale_inputs", "severity": "annotate", "facts": { … } } ],
  "observed_reasons_latest": { "date": "…", "top_reason": "ENE", "top_reason_share": 0.62 }
}
```

`risk_class` and every driver label are **codes**, not translated strings; the
client translates them. `observed` and `typical` are **numbers with a unit
code**, never preformatted strings like `"310 MW left"` — a preformatted value in
the payload is a translated string by another name.

**The canonical form.** `canonical()` sorts keys and rounds every float to its
field's display precision **before** hashing, so a 1e-12 jitter in a recomputed
contribution does not miss the cache. That canonical form is what the cache key,
the numeric whitelist and the snapshot test all read, so it is built once here
and never re-derived.

**Blocked by:** 06, 07.

**Status:** done

- [ ] The payload is assembled from the persisted attribution row, the forecast row and the fired rules — nothing is recomputed at request time
- [ ] Every figure the copy could want is present as a number, `top_two_share` included
- [ ] `observed` and `typical` are numbers with a unit code; no preformatted string appears anywhere in the document
- [ ] Every label and class is a code; the only prose in the document is the untranslated ONS display name
- [ ] The canonical form sorts keys and rounds each float to its field's display precision before hashing
- [ ] A snapshot test on the canonical payload fails on an accidental field addition, because such an addition would silently invalidate every cached narration
- [ ] The document is closed: a field that is not in the schema is a validation failure, not a passthrough
