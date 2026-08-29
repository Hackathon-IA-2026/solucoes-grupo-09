# 08 — There is one forecast per subsystem, and the split is two scalars

**What to build:** the Overview stops rendering a band per technology, because
no such model exists. One forecast per subsystem-day; the technology split is a
**scalar** split of the P50 and of the expectation, and no screen can draw it as
a band.

This is contract change 5 — the one with the most code behind it, and one that
no upstream spec named.

```ts
export interface SubsystemDayForecast {
  subsystem: SubsystemCode;
  targetDate: string;
  forecastOrigin: ForecastOrigin;
  thresholdMw: number;
  occurrenceProbability: number;      // day grain, from the path ensemble
  dailyEnergy: Band;                  // path ensemble; never Σ hours
  peakPower: Band;                    // path ensemble
  dayExpectedMwh: number;             // NOT the band's centre
  split: { windMwh: number; solarMwh: number };   // scalars, no band
  hours: CurtailmentHourForecast[];
}
```

and the hourly forecast gains its own expectation and its own scalar split.

Three things this makes structural rather than remembered:

- **The expectation is a sibling of the band, never its centre.** For a mixture
  it exceeds the P50 whenever the occurrence probability is below one half.
  Publishing it as a sibling is the forecaster's rule, and the field layout is
  what enforces it.
- **The day figures are path-ensemble quantiles and are never computed from the
  hours.** Quantiles do not add.
- **The split has no band.** The schema rejects a split object carrying a
  quantile.

**The technology selector on the Overview changes meaning**: it stops filtering
the forecast and starts selecting which scalar the split panel emphasises. That
is a real UI change and a smaller one than it sounds, because the fan chart was
never per-technology in any defensible sense.

**Blocked by:** 03. Cross-spec: the day-grain path-ensemble figures are
**forecaster**'s to produce; this ticket reshapes the client contract and the
fixtures, which can happen first.

**Status:** done

- [ ] The forecast shape carries no technology and is one object per subsystem-day
- [ ] The day band and the peak-power band are read from the day-grain figures, never reduced from the hours
- [ ] The expectation appears at both grains and is never inside a band object
- [ ] The split is two scalars at both grains and the schema rejects a quantile inside it
- [ ] The Overview's technology selector emphasises a scalar rather than filtering the forecast
- [ ] A test asserts the day band is not the componentwise sum of the hourly bands
- [ ] The fan chart renders from one subsystem forecast with no technology argument
