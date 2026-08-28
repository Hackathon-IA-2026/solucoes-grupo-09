/**
 * Every string the landing page renders, in one module.
 *
 * i18n is decided but not built (`docs/specs/i18n.md`), so this is not a
 * translation catalogue — it is the shape a catalogue can be lifted out of
 * without touching a component. Two rules make that possible:
 *
 * 1. **No prose is interpolated inside JSX.** Where a sentence needs one
 *    highlighted fragment, it is stored as `{ lead, accent }` and the
 *    component concatenates two `<Text>` runs. A translator gets two whole
 *    clauses, not a sentence split around a variable.
 * 2. **Numbers never live here.** They come from `fixtures.ts` and are
 *    formatted at the edge, so `Intl` can take over per locale later.
 *
 * Known awkward spots for the PT-BR pass, flagged now rather than discovered
 * later:
 *
 * - `hero.headline` — the EN pun on tense ("happened" / "coming") does not
 *   survive literal translation. PT-BR should be authored, not translated;
 *   §46 of IDEA.md already contains a better Portuguese original.
 * - `band.rangeLabel` — "P10–P90" is a notation, not a phrase. It must stay
 *   verbatim in both locales; only the surrounding gloss translates.
 * - ONS proper nouns (`constrained-off`, `conjunto`, the reason codes, the
 *   subsystem display names) are untranslated by naming rule 2 of
 *   `docs/domain-model.md`, in EN copy as well as PT.
 * - `provenance.odbl` is a licence notice whose wording is constrained by
 *   ODbL §4.3; it needs a legal check per locale, not a translation.
 */

export const copy = {
  nav: {
    home: "WattSteer — home",
    links: [
      { label: "The forecast", target: "forecast" },
      { label: "How it works", target: "engines" },
      { label: "The product", target: "showcase" },
      { label: "Data", target: "provenance" },
    ],
    cta: "Open the live grid",
  },

  hero: {
    eyebrow: "Day-ahead curtailment forecast · Brazilian grid",
    headline: {
      lead: "Today we can tell that curtailment happened.",
      accent: "WattSteer tells you it is coming.",
    },
    sub: "Brazil is adding wind and solar far faster than it is making the grid flexible, so there are hours when the clean energy is there and it has to be cut. WattSteer forecasts those hours a day ahead from ONS open data — as a range, not a guess — explains the grid conditions behind them, and sizes the storage and flexible demand that could absorb them.",
    primaryCta: "Open the live grid",
    secondaryCta: "How the forecast is built",
  },

  readout: {
    title: "Tomorrow on the Brazilian grid",
    nationalLabel: "Forecast constrained-off energy, all four subsystems",
    nationalGrainNote:
      "A national figure is the sum of the four subsystems. ONS publishes a SIN row; WattSteer never uses it, because it double-counts against the subsystem rows it sits beside.",
    sampleBadge: "Sample data",
    sampleNote:
      "Illustrative fixture. The live feed arrives with the forecasting service; nothing on this page is a real forecast yet.",
    subsystemsTitle: "By subsystem",
    // Spelled out rather than "P(curtailment)": the notation reads as a
    // formula to a non-technical visitor, and it translates badly.
    columnProbability: "Chance of curtailment",
    profileTitle: "Hour by hour",
    profileSub: "Forecast constrained-off energy per hour, national",
    profileCaption:
      "The shaded band is P10–P90; the line is P50. An hour counts as curtailed above the 5 MW subsystem threshold, which is stamped on every figure WattSteer publishes.",
    additivityNote:
      "Subsystem bands do not sum to the national band, and the hourly bands do not sum to the daily one. Quantiles are not additive — only the P50 medians are shown adding up, and even that is a convention.",
    originLabel: "Forecast origin",
  },

  band: {
    rangeLabel: "P10–P90",
    medianLabel: "P50",
    observedLabel: "Observed",
    observedNote: "A measured value. No band, because there is no forecast.",
    explainerTitle: "Every number here has a width",
    explainerBody:
      "A curtailment forecast that says 4,180 MWh and nothing else is a number pretending to be a fact. WattSteer publishes P10, P50 and P90 together and draws the distance between them, so the width of the uncertainty is as visible as the middle of it. Where a figure genuinely has no band — a measured historical actual — it is labelled observed, so the absence means something.",
  },

  engines: {
    title: "Four engines, not one model",
    sub: "Forecasting alone is half a product. The value is in what happens after the number.",
    items: [
      {
        name: "Forecaster",
        question: "Will it happen, how much, where, when?",
        body: "A hurdle model — an occurrence classifier plus a magnitude regression — over ONS balanço, load, interchange and capacity-weighted weather. Day-ahead, all 24 hours, as P10/P50/P90.",
      },
      {
        name: "Diagnosis",
        question: "Which grid conditions is the risk associated with?",
        body: "SHAP attribution over the model's own features, arbitrated by domain rules. It explains why the model raised its forecast — deliberately not why the event physically occurred.",
      },
      {
        name: "Flex Optimizer",
        question: "What would absorb it, and at what size?",
        body: "A MILP over battery state of charge and shiftable load that returns an hour-by-hour dispatch, the recoverable energy, and the share of curtailment that turns out to be avoidable.",
      },
      {
        name: "Replay",
        question: "How much could have been recovered?",
        body: "Re-run a real historical day on the information that was available the evening before, then reveal what actually happened and score the difference.",
      },
    ],
  },

  showcase: {
    badge: "Sample data · the real components",
    title: {
      lead: "The forecast is where it",
      accent: "starts.",
    },
    sub: "These are the product's own panels, rendered over a deterministic fixture. Same components, same units, same bands as the live screens.",
    explain: {
      panelTitle: "Diagnosis",
      panelSub: "NORDESTE · tomorrow",
      heading: "Which conditions the risk is associated with",
      note: "SHAP contribution to the model's forecast, normalised to 100%. These are the model's drivers, not a causal claim about the grid.",
    },
    mitigate: {
      panelTitle: "Flex Optimizer",
      panelSub: "NORDESTE · tomorrow",
      heading: "What flexibility would absorb it",
      baselineLabel: "No action",
      note: "Asset parameters are scenario inputs, not an inventory — ONS publishes no flexibility-asset registry, so this is a what-if, not a plan.",
      recoveredLabel: "Energy recovered",
      avoidedLabel: "Curtailment avoided",
      scenarioLabel: "Economic scenario",
    },
    replay: {
      panelTitle: "Replay",
      panelSub: "NORDESTE · a real day",
      heading: "How much could have been recovered",
      actualLabel: "Actually curtailed",
      optimizedLabel: "With WattSteer",
      recoveredLabel: "Recovered",
      reductionLabel: "Curtailment reduction",
      vintageNote:
        "This window predates WattSteer's ingestion, so the past shown here is ONS's current restatement of it, not what was knowable on the day. Labelled revision-optimistic, and it can never be repaired: ONS rewrites history in place.",
    },
  },

  provenance: {
    title: "Everything here comes from public data",
    sub: "No accounts, no login, nothing behind a wall. WattSteer reads openly published data and shows its working.",
    sources: [
      {
        name: "ONS Dados Abertos",
        body: "Constrained-off for wind and solar, the subsystem energy balance, verified load, interchange and DESSEM. The curtailment label itself and every grid quantity behind it.",
      },
      {
        name: "ANEEL SIGA",
        body: "Plant coordinates, municipality and ownership, used to place the fleet on the map and weight weather by installed capacity. Capacity and commissioning dates come from ONS, not from here.",
      },
      {
        name: "Open-Meteo",
        body: "Day-ahead wind and irradiance at cluster centroids, from a pinned model run, aggregated by time-varying installed capacity.",
      },
    ],
    honesty: {
      title: "What WattSteer will not claim",
      items: [
        {
          label: "No carbon figure",
          body: "Renewable energy that stops being curtailed does not map to a fixed CO₂ saving without knowing which generation it displaced. WattSteer reports recovered energy and says nothing about carbon.",
        },
        {
          label: "R$ only as a labelled scenario",
          body: "Money appears exactly once, next to the R$/MWh it assumed. Curtailment compensation and pricing are regulatory questions this product does not answer.",
        },
        {
          label: "Reasons only at the grain ONS reports them",
          body: "A restriction reason is a property of a reporting entity — a conjunto for most wind, a plant only where the plant reports for itself. WattSteer never allocates a reason down to a plant and presents it as an observation.",
        },
        {
          label: "Data vintage is on screen",
          body: "Every forecast names the run that produced it, and every backtest says whether its window was genuinely knowable at the time or is ONS's later restatement of it.",
        },
      ],
    },
    odbl: "Plant registry data is derived from ANEEL SIGA, © ANEEL, made available under the Open Database License (ODbL) v1.0. WattSteer's derived plant table is a Derivative Database and is offered under the same licence.",
    disclaimer:
      "WattSteer is not affiliated with ONS or ANEEL. Forecasts are modelled estimates, not operating instructions, trading signals or advice.",
  },

  footerCta: {
    headline: {
      lead: "Don't just predict wasted energy.",
      accent: "Prevent it.",
    },
    sub: "Day-ahead curtailment risk for the Brazilian grid, from open data.",
    button: "Open the live grid",
  },
} as const;
