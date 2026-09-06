/**
 * The site's copy, per locale.
 *
 * Structured rather than a flat key table: the shape *is* the contract, so
 * `Copy` is derived from the English dictionary and TypeScript refuses any
 * locale that omits a string or invents one. A flat `t("hero.sub")` catalogue
 * cannot do that — a missing key is a runtime fallback, silently.
 *
 * Two rules make a locale liftable without touching a component:
 *
 * 1. **No prose is interpolated inside JSX.** Where a sentence needs one
 *    highlighted fragment it is stored as `{ lead, accent }` and the component
 *    concatenates two `<Text>` runs, so a translator gets whole clauses.
 * 2. **Numbers never live here.** They come from fixtures and are formatted at
 *    the edge, so `Intl` handles them per locale.
 *
 * Portuguese is **authored, not translated**, wherever a literal rendering
 * would be worse than the original — the hero's tense pun in particular, where
 * IDEA.md §46 already contains a stronger Portuguese sentence than any
 * translation of the English one would be.
 *
 * Untranslated in both locales, by naming rule 2 of `docs/domain-model.md`:
 * ONS proper nouns (`constrained-off`, `conjunto`, the reason codes, the
 * subsystem display names), the quantile notation `P10–P90`, and the
 * institution names ONS, ANEEL, DESSEM, SIGA.
 */

import type { DriverCode, NarrationClauseKey } from "@wattsteer/core/api";

export const en = {
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

  /**
   * The gate page and the footer.
   *
   * `gate.tagline` is the one string the site renders in *both* locales at
   * once: the gate is bilingual by construction, because a chooser that picks
   * a language to address the reader in has already made the choice for them.
   * It reads `pt.gate.tagline` and `en.gate.tagline` side by side rather than
   * hardcoding two sentences.
   */
  gate: {
    tagline: "Curtailment intelligence for the Brazilian grid.",
  },

  footer: {
    tagline: "Renewable curtailment intelligence.",
    rights: "© WattSteer {year}. All rights reserved.",
  },

  notFound: {
    metaTitle: "Page not found — WattSteer",
    title: "Page not found",
    body: "The page you're looking for doesn't exist.",
    back: "Back to WattSteer",
  },

  /**
   * One sentence per error code, and one per "no forecast" state.
   *
   * The API answers every failure with `{ error: { code, message, … } }`. The
   * `code` is a member of a closed enum published in `@wattsteer/core/errors`;
   * the `message` beside it is **English developer prose for logs and `/docs`
   * and is never rendered**. What a reader sees is `t("error." + code)` — this
   * table — which is why the table has to be exhaustive: a code with no key is
   * a screen with no sentence, and `apps/web/test/error-copy.test.ts` fails the
   * build rather than let one ship.
   *
   * `noForecast` is the other half of the same contract. "Not published yet",
   * "no promoted artifact", "stale" and "the gateway is down" are four
   * different sentences, and the whole point of the error contract is that a
   * screen must not collapse them into one spinner. Three of the four have a
   * code; the fourth — stale — is a `200`, because a forecast from this
   * morning is a real forecast, so it has a sentence here and no code anywhere.
   */
  error: {
    // The gateway's own
    BAD_INPUT: "Something in that request wasn't right.",
    REQUEST_INVALID: "That request didn't match what this endpoint accepts.",
    ROUTE_NOT_FOUND: "That address doesn't exist on this API.",
    INTERNAL: "Something went wrong on our side. It has been logged.",
    UPSTREAM_UNAVAILABLE: "A data source we depend on didn't answer.",
    SERVICE_BUSY: "WattSteer is at capacity right now. Try again shortly.",
    PAYLOAD_TOO_LARGE: "That request was larger than this endpoint accepts.",

    // The four "no forecast" states, and the publication failure beside them
    FORECAST_NOT_YET_PUBLISHED:
      "That day's forecast hasn't been published yet — its gate hasn't passed.",
    FORECAST_UNAVAILABLE:
      "The gate passed but no forecast was written for that day. This is a publication failure on our side, not an empty result.",
    MODEL_UNAVAILABLE:
      "No promoted model is serving right now, so no forecast is offered. The observed panels are unaffected.",
    DATA_UNAVAILABLE: "We couldn't reach our database. Try again shortly.",
    DIAGNOSIS_UNAVAILABLE:
      "That day has a forecast but no explanation was computed for it.",

    // What this surface refuses
    SUBSYSTEM_UNKNOWN: "That isn't one of the four subsystems.",
    TARGET_DATE_OUT_OF_RANGE:
      "That date is outside the window WattSteer covers — nothing before the data opens, and nothing past tomorrow.",
    DATE_RANGE_TOO_LARGE: "That date range is longer than a single request may ask for.",
    GATE_PROFILE_UNKNOWN: "That isn't one of the publication gates.",
    LOCALE_UNSUPPORTED: "WattSteer answers in Portuguese and English only.",
    RATE_LIMITED: "Too many requests. Wait a moment and try again.",

    // The modelling service
    OPTIMIZER_NOT_CONFIGURED:
      "The optimizer isn't configured in this deployment, so scenarios can't be solved here.",
    OPTIMIZER_UNAVAILABLE: "The optimizer couldn't be reached.",
    OPTIMIZER_TIMEOUT: "The optimizer didn't answer in time.",
    OPTIMIZER_NOT_READY: "The optimizer is starting up and can't solve yet.",
    UPSTREAM_REJECTED: "The optimizer refused that request.",
    UPSTREAM_FAILED: "The optimizer failed on that request.",

    // The solve
    SOLVER_GAP_UNCLOSED:
      "The solver ran out of time before it could prove the answer optimal, so no dispatch is offered.",
    SOLVER_TIMEOUT: "The solver gave up waiting on that scenario.",
    SOLVER_BUG: "That scenario broke the solver. It has been logged.",

    // The scenario's validation table
    SCENARIO_VERSION_UNSUPPORTED: "That scenario was written for another version.",
    SCENARIO_TOO_LARGE: "That scenario is larger than the published limit.",
    ASSET_TYPE_UNKNOWN: "That isn't an asset type the optimizer knows.",
    SUBSYSTEM_MISMATCH: "Every asset in a scenario has to sit in the same subsystem.",
    FIELD_NOT_ON_VARIANT: "That field doesn't belong to this kind of asset.",
    MAGNITUDE_OUT_OF_RANGE: "That value is outside the range the optimizer accepts.",
    RTE_OUT_OF_RANGE: "A round-trip efficiency has to sit between 0 and 1.",
    EFFICIENCY_PAIR_INCOMPLETE:
      "Charge and discharge efficiency are given together or not at all.",
    SOC_BOUNDS_INVALID: "The minimum state of charge has to sit below the maximum.",
    SOC_INITIAL_OUT_OF_BOUNDS:
      "The starting state of charge sits outside its own bounds.",
    POWER_LIMIT_INCONSISTENT: "Those power limits contradict each other.",
    SHIFT_EXCEEDS_CONNECTION: "That shift is larger than the connection can carry.",
    SHIFT_EXCEEDS_BASELINE: "That shift is larger than the load it would move.",
    SHIFT_WINDOW_OUT_OF_RANGE: "That shifting window doesn't fit inside a day.",
    RECOVERY_TIME_OUT_OF_RANGE: "That recovery time is outside the accepted range.",
    AVAILABILITY_INVALID: "Availability has to be given for every hour, between 0 and 1.",
    ECONOMIC_ASSUMPTION_OUT_OF_RANGE:
      "That economic assumption is outside the range the optimizer accepts.",

    // Replay's five refusals
    REPLAY_DATE_BEFORE_HOLDOUT_WINDOW:
      "That day was inside the model's training window, so replaying it would flatter the score. Only observed data is shown for it.",
    REPLAY_DATE_OUT_OF_RANGE: "That day can't be replayed — it isn't settled yet.",
    REPLAY_FORECAST_UNAVAILABLE: "No held-out forecast exists for that day.",
    REPLAY_OBSERVATION_INCOMPLETE:
      "ONS hasn't settled every hour of that day yet, so it can't be scored.",
    REPLAY_INTEGRITY_VIOLATION:
      "We couldn't prove that day was held out of training, so nothing is shown for it. It has been logged.",
  },

  noForecast: {
    notYetPublished:
      "Tomorrow's view publishes at {gate}. What's below is today's forecast.",
    noPromotedArtifact:
      "No model is promoted for serving, so nothing is forecast. What was observed is unaffected, and the Time Machine still works.",
    stale: "Published {age} — before the most recent gate.",
    unavailable: "The forecast service is unreachable right now. Try again shortly.",
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
    nationalLabel: "Expected constrained-off energy, all four subsystems",
    nationalGrainNote:
      "The national figure is the sum of the four subsystems' expected energy, and that sum is exact — expectations add however the subsystems happen to move together. ONS publishes a SIN row; WattSteer never uses it, because it double-counts against the subsystem rows it sits beside.",
    riskCounts: "Subsystems by risk: high {high} · elevated {elevated} · low {low}",
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
      "Nothing in this column sums to the figure beside it. Bands are not additive, and neither are medians: the P50 of a sum is the sum of the P50s only if the four subsystems move together, and they do not. The expected value is the one quantity that adds exactly, which is why the national figure is one.",
    originLabel: "Forecast origin",
    originValue: "{producer} · {run} · published {published} · weather run {weatherRun}",
  },

  band: {
    rangeLabel: "P10–P90",
    medianLabel: "P50",
    observedLabel: "Observed",
    observedNote: "A measured value. No band, because there is no forecast.",
    expectedLabel: "Expected value",
    figureExpected:
      "{label}: expected value {value} {unit}, published without a forecast band",
    /** Keyed by `BandUnavailableReason` — a null band always states its reason. */
    noBand: {
      no_joint_ensemble:
        "No band: the forecaster draws its 500-path ensemble one subsystem at a time, so there is no joint distribution to read a national P10–P90 off. Adding the four subsystems' quantiles would invent one. The expected value needs no such assumption.",
    },
    explainerTitle: "Every number here has a width",
    explainerConfident: "A confident forecast",
    explainerUncertain: "A wide-open one",
    explainerSame:
      "Same median — {value} MWh — and a single-number card would print them identically.",
    railObserved: "{label}: {value} {unit}, observed",
    railBand:
      "{label}: median {p50} {unit}, 10th to 90th percentile {p10} to {p90} {unit}",
    hourFigure: "{hour} — median {p50} {unit}, P10 to P90 {p10} to {p90} {unit}",
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
      drivers: {
        renewable_load_ratio: "Renewable / load ratio",
        ne_se_export_utilisation: "Export stress, NE → SE",
        residual_load: "Low residual load",
        solar_ramp_1h: "Solar ramp",
        is_weekend: "Weekend",
        other: "Other features",
      },
      note: "SHAP contribution to the model's forecast, normalised to 100%. These are the model's drivers, not a causal claim about the grid.",
    },
    mitigate: {
      panelTitle: "Flex Optimizer",
      panelSub: "NORDESTE · tomorrow",
      heading: "What flexibility would absorb it",
      baselineLabel: "No action",
      note: "Asset parameters are scenario inputs, not an inventory — ONS publishes no flexibility-asset registry, so this is a what-if, not a plan.",
      stepBattery: "+ Battery",
      stepLoad: "+ Flexible load",
      detailBattery: "{power} MW / {energy} MWh, round-trip {efficiency}",
      detailLoad: "{shift} MW shiftable, {window} h window",
      recoveredLabel: "Energy recovered",
      avoidedLabel: "Curtailment avoided",
      medianToMedian: "median to median",
      scenarioLabel: "Economic scenario",
      economicNote: "{value} at an assumed {rate}/MWh",
    },
    replay: {
      panelTitle: "Replay",
      panelSub: "NORDESTE · a real day",
      heading: "How much could have been recovered",
      actualLabel: "Actually curtailed",
      optimizedLabel: "With WattSteer",
      recoveredLabel: "Recovered",
      reductionLabel: "Curtailment reduction",
      vintageBadge: "revision-optimistic",
      medianToObserved: "median to observed",
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
    /**
     * ODbL §4.6, on a public surface.
     *
     * §4.3's notice above says the data is available under ODbL; §4.6 obliges
     * an actual *offer* of a machine-readable copy, free of charge, over the
     * internet. A notice that names the licence without saying where the file
     * is discharges half the clause, so the endpoint is named here in body
     * text rather than left to a developer to find in the API docs.
     */
    registryAccess:
      "The registry itself is downloadable, as ODbL §4.6 requires: GET /v1/plants returns every plant WattSteer holds — code, name, subsystem, technology, municipality, coordinates and installed capacity at a date — as JSON or CSV, free of charge and without an account.",
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

  /**
   * Head metadata. Locale-prefixed routes only pay off if what a crawler
   * indexes is *also* in that locale, so the title and description are copy
   * like everything else rather than a constant in the route file.
   */
  meta: {
    home: {
      title: "WattSteer — renewable curtailment intelligence for the Brazilian grid",
      description:
        "Day-ahead curtailment risk for all four Brazilian subsystems, forecast as a P10–P90 range from ONS open data — with the grid conditions behind it and the storage and flexible demand that could absorb it.",
    },
    privacy: {
      title: "Privacy Policy — WattSteer",
      description:
        "WattSteer has no accounts and no personal data. This policy describes how little we handle.",
    },
    terms: {
      title: "Terms of Service — WattSteer",
      description:
        "WattSteer is a public, read-only analysis of openly published Brazilian grid data. These terms govern your use of it.",
    },
  },

  legal: {
    homeLink: "WattSteer — home",
    privacyLink: "Privacy",
    termsLink: "Terms",

    privacy: {
      badge: "Privacy Policy",
      updated: "Last updated: August 28, 2026",
      title: "Privacy Policy",
      intro:
        "WattSteer has no accounts and no personal data. This policy describes how little we handle.",
      summary: {
        title: "The short version",
        body: "WattSteer has no user accounts, no login, and no personal data to collect. It analyses openly published electricity system data — none of which describes individuals.",
        cardTitle: "What this means",
        cardItems: [
          "No signup, no account, no profile",
          "No advertising or cross-site tracking cookies",
          "No selling or sharing of data about you",
          "Nothing you type is stored against an identity",
        ],
      },
      processing: {
        title: "What passes through WattSteer",
        body: "The data WattSteer works with is published openly by grid and regulatory bodies and describes power plants, load, generation and weather — not people.",
        scenarios:
          "If you explore a what-if scenario, the parameters you enter are used to compute the result you asked for. They are not attached to an identity.",
      },
      logs: {
        title: "Server logs",
        body: "Like any web service, our infrastructure records ordinary request logs — IP address, timestamp, path, user agent — for security, abuse prevention and debugging. These are retained briefly and are not used to build a profile of you.",
      },
      cookies: {
        title: "Cookies and storage",
        body: "WattSteer sets no advertising or cross-site tracking cookies. Any browser storage is limited to remembering your own display preferences — your chosen language, for one — on your own device, and never reaches our servers.",
      },
      contact: {
        title: "Contact",
        body: "Questions about this policy can be sent to the address published on our repository.",
      },
    },

    terms: {
      badge: "Terms of Service",
      updated: "Last updated: August 28, 2026",
      title: "Terms of Service",
      intro:
        "WattSteer is a public, read-only analysis of openly published grid data. These terms govern your use of it.",
      overview: {
        title: "Overview",
        body: "These Terms of Service govern your use of WattSteer, a public, read-only site that analyses openly published Brazilian electricity system data to estimate renewable curtailment and the flexibility that could absorb it. By using WattSteer you agree to these Terms.",
        cardTitle: "Core principles",
        cardItems: [
          "Free to use — no account or signup required",
          "We work only with publicly published open data",
          "Forecasts and scenarios are estimates, not operational instructions",
          "Transparency about what the service does and does not do",
        ],
      },
      service: {
        title: "The service",
        body: "WattSteer publishes day-ahead estimates of renewable curtailment by subsystem, an explanation of the grid conditions associated with that estimate, and what-if scenarios showing how much of the estimated curtailment a given amount of storage or flexible demand could absorb.",
        sources:
          "Source data is published by ONS (Operador Nacional do Sistema Elétrico), ANEEL and third-party weather providers. WattSteer is not affiliated with, endorsed by, or operated on behalf of any of them.",
      },
      reliance: {
        title: "No operational reliance",
        body: "Everything WattSteer publishes is a modelled estimate carrying uncertainty, and may be wrong. It is not a grid operating instruction, not a trading signal, and not investment, engineering or regulatory advice.",
        yours:
          "Do not use WattSteer as an input to real-time system operation, dispatch or settlement. Decisions with physical or financial consequences remain yours, and should rest on the authoritative sources.",
      },
      availability: {
        title: "Availability and changes",
        body: "The service is provided as-is, without warranty of availability or accuracy. Upstream sources revise their published history, sometimes years after the fact, so figures shown here can change. We may modify or discontinue any part of the service at any time.",
      },
      attribution: {
        title: "Data attribution and licensing",
        body: "Source datasets remain the property of their publishers and are used under their respective open licences. Where a licence requires attribution or share-alike treatment of derived data, WattSteer complies with it; those notices appear alongside the data they cover. The plant registry derived from ANEEL SIGA is offered under the Open Database License (ODbL) v1.0 and is downloadable in machine-readable form at GET /v1/plants.",
      },
    },
  },

  /**
   * The four `/app` product screens.
   *
   * The largest copy surface in the product, and the one where getting it
   * wrong costs the most: these screens carry the honesty the whole thing is
   * built on — the vintage badges, the replay provenance statement, the
   * risk-class names, the "quantiles do not add" notes — and a caveat a reader cannot read
   * is a caveat that is not there. A Portuguese-speaking grid operator must not
   * get the marketing in Portuguese and the product in English.
   *
   * Three conventions, all of them load-bearing:
   *
   * 1. **`{placeholder}` is always a value, never prose.** Filled by `fill()`
   *    with something a formatter produced (a number, a date, a percentage) or
   *    something the domain owns (an ONS display name, a reason code). Prose is
   *    never interpolated, so a translator always sees a whole clause and can
   *    move the value to wherever the sentence needs it.
   * 2. **Units and notation are not translated.** `MW`, `MWh`, `GW`, `P10`,
   *    `P50`, `P90`, `R$`, `BRT` and the ONS vocabulary read the same in both
   *    locales, so they are appended by the components rather than stored here.
   * 3. **Codes are keys, labels are copy.** Risk classes, mitigation steps,
   *    driver codes, reason codes and vintage fidelities arrive from the
   *    fixtures (and later the API) as codes; their words live here.
   */
  app: {
    shell: {
      backToLanding: "WattSteer — back to the landing page",
      prototypeBadge: "PROTOTYPE · FIXTURE DATA",
      screens: {
        overview: "Grid Overview",
        explain: "Explain",
        mitigate: "Mitigate",
        replay: "Time Machine",
      },
      selection: {
        subsystem: "Subsystem",
        technology: "Technology",
        run: "D−1 run",
        targetDay: "Target day",
      },
    },

    /** `Technology` is an enum in the API; these are its words. */
    technology: { WIND: "Wind", SOLAR: "Solar" },

    /** Stamped on every forecast surface — see `components/app/honesty.tsx`. */
    stamp: {
      published: "{producer} · {run} · published {when} BRT",
      // A second artifact, and therefore a second clause. Appended rather than
      // folded into `published`, because an origin that is not a WattSteer
      // forecast has no weather run and must not print an empty one.
      weatherRun: " · weather run {run}",
      threshold: " · threshold {mw} MW",
      optimisedAgainst: "Optimised against the forecast published {when} BRT",
    },

    /** `VintageFidelity`, product-visible by decision rather than by accident. */
    vintage: {
      point_in_time: "POINT-IN-TIME",
      revision_optimistic: "REVISION-OPTIMISTIC",
    },

    /** The band figure and its strip — `components/charts/band-figure.tsx`. */
    band: {
      medianMarked: "P50 marked",
      strip: "P10 {p10}, P50 {p50}, P90 {p90}",
    },

    /** `RiskClass` — three wide bins, named. See `charts/risk-class.tsx`. */
    risk: {
      low: "Low",
      elevated: "Elevated",
      high: "High",
      caveat:
        "Risk is P(at least one hour above the threshold), binned. The bins are wide because the classifier is not calibrated finely enough to justify narrower ones — see the reliability curve on Explain.",
    },

    /** The 24-hour fan chart. */
    fan: {
      figure: "Day-ahead curtailment profile, P10 to P90 band around the median",
      thresholdMark: "threshold {mw} MW",
      medianLegend: "P50 forecast",
      bandLegend: "P10–P90 band",
      observedDefault: "Observed",
      hint: "Tap an hour to read its interval",
      hourLabel: "Hour",
      exceedance: "P(above threshold)",
      expected: "Expected E[Y]",
      splitReadout: "{wind} wind · {solar} solar",
      hourFigure: "Hour {hour}: P50 {p50} MWh, P10 to P90 {p10} to {p90}",
    },

    /** The dispatch and state-of-charge chart. */
    dispatch: {
      figure:
        "Hourly dispatch: curtailment offered, what each asset is scheduled to do, and the battery's state of charge",
      offered: "Curtailment offered (MWh)",
      batteryCharge: "Battery charging (MW)",
      loadShiftUp: "Load shifted into the hour (MW)",
      soc: "Battery SOC (MWh, right axis)",
      discharge: "Discharge (below the line)",
      loadShiftDown: "Load shifted out of the hour (below the line)",
    },

    /** Driver attribution — SHAP shares, at subsystem grain. */
    drivers: {
      /**
       * The eight driver groups the API ranks, keyed by `DriverCode`.
       *
       * These are the players in the Shapley game
       * (`apps/ml/src/wattsteer_ml/diagnosis/driver_groups.yaml`), and the
       * words for them live here rather than travelling as `label_code`'s
       * gloss: an English label moving through the data layer is how a
       * bilingual product goes monolingual again. `other` is deliberately
       * absent — it is the client's merged remainder and never a group.
       */
      groups: {
        renewable_resource: "Renewable resource",
        demand_level: "Demand level",
        net_surplus: "Net surplus",
        export_stress: "Export stress",
        ramp_shape: "Intraday ramp and shape",
        calendar_season: "Calendar and season",
        recent_history: "Recent history",
        data_conditions: "Pipeline conditions and residual",
      } satisfies Record<DriverCode, string>,
      /**
       * The merged remainder, named apart from the eight.
       *
       * `other` is not a group. It is what the client's display rule collapses
       * everything below the cut into, and listing it inside `groups` would
       * put a ninth entry in a dictionary the type says has eight.
       */
      merged: "Everything else",
      mergedNote:
        "{count} groups below the cut, merged into one bar. Their contributions are summed with their signs.",
      /** The non-numeric readings a headline feature can report. */
      terms: {
        weekend: "weekend",
        weekday: "weekday",
        importing: "importing",
        balanced: "balanced",
      },
      direction: { raises: "raises", lowers: "lowers", mixed: "acts in both directions" },
      /**
       * The signed contribution, beside the share.
       *
       * The sign is written by the formatter, always and for both signs: a
       * bare "128 MWh" under a downward arrow is two claims about direction
       * and only one of them is checkable.
       */
      contribution: "{phi} MWh",
      /**
       * The reading pair, named for the feature it came from.
       *
       * `{feature}` is a feature name from the model's artifact
       * (`proxy_renewable_load_ratio`), untranslated in both locales for the
       * same reason the ONS identifiers are: it is the name of a column, not a
       * word we chose. Without it the two numbers read as though the whole
       * group had one value, which no group ever has.
       */
      reading: "{feature}: observed {observed} · typical {typical}",
      hourDisagreement:
        "Acted in both directions during the day — its hours disagree by {value}.",
      demoted: "A rule put this group below the fold. Its contribution is unchanged.",
      figure: "{driver}: {share} of the attributed movement, {direction} risk",
      /**
       * The merged row's accessible label, written separately.
       *
       * "mixed risk" would be a claim neither half of a cancelled remainder
       * supports, so the sentence changes rather than the placeholder.
       */
      figureMixed:
        "{driver}: {share} of the attributed movement, acting in both directions",
      note: "Shares are of the attributed movement for this subsystem-day — each group's contribution against the size of all of them — not of the curtailment itself. A driver that raises risk is not a cause of any individual curtailed MWh.",
      /**
       * The one sentence the screen was missing.
       *
       * The bars decompose the expected MWh and nothing else on this screen.
       * The occurrence probability beside them is a day-level quantity read
       * from the path ensemble — not a per-hour model output, and not
       * something a Shapley game is played over at all — and the band's edges
       * are not decomposed either. Adjacent panels, related quantities,
       * different questions.
       */
      scopeNote:
        "These bars explain the expected MWh for the day. They do not explain the P10, the P90, the width of the band, or the risk of the day containing any curtailment at all — that probability comes from the path ensemble, which is a different model output.",
    },

    /**
     * The deterministic narration, one clause per sentence.
     *
     * The Explain panel's paragraph has two possible authors. When a language
     * model wrote it, it arrives as prose generated in this locale and none of
     * these strings is used. When a rule withheld it — or the model was down,
     * or the daily cap was reached — the server sends an ordered list of these
     * keys with the values their placeholders take, and
     * `apps/web/src/i18n/narration.ts` assembles the paragraph here. The
     * template is not a lesser sentence: it states the same facts, at the same
     * precision, with no hedging the model would not have used.
     *
     * Four rules, each of which the shape of these strings enforces:
     *
     * 1. **Every placeholder is a value.** A number, a date, a wall-clock hour
     *    or a driver group's label from `drivers.groups` above. Never another
     *    sentence, so a whole clause is always what a translator sees.
     * 2. **Units are appended by the formatter**, not written here: `{share}`
     *    already carries its `%` and `{phi_mwh}` its `MWh`, in this locale's
     *    own notation.
     * 3. **A placeholder is named for the payload field it quotes.** Reading
     *    `{day_expected_mwh}` tells you which number of the closed document
     *    this sentence restates, and there is exactly one of it.
     * 4. **The model raised or lowered a forecast; nothing here says a
     *    condition did anything to the grid.** `docs/domain-model.md` §10, and
     *    the build-time boundary scan reads this file.
     */
    narration: {
      risk_low:
        "For {subsystem_display_name} on {target_date}, the model reads the risk of curtailment above {threshold_mw} as low: {day_occurrence_probability} for at least one hour, with {hours_p50_nonzero} hours whose P50 is above zero.",
      risk_elevated:
        "For {subsystem_display_name} on {target_date}, the model reads the risk of curtailment above {threshold_mw} as elevated: {day_occurrence_probability} for at least one hour, with {hours_p50_nonzero} hours whose P50 is above zero.",
      risk_high:
        "For {subsystem_display_name} on {target_date}, the model reads the risk of curtailment above {threshold_mw} as high: {day_occurrence_probability} for at least one hour, with {hours_p50_nonzero} hours whose P50 is above zero.",
      magnitude:
        "It expects {day_expected_mwh} over the whole day against a typical {baseline_expected_mwh}, a difference of {total_attributed_mwh} that the eight driver groups divide between them.",
      peak: "The largest hour is {peak_hour_local}, at a median {peak_power_p50_mw}.",
      driver_raises:
        "{code} raises the model's forecast: {phi_mwh}, {share} of the attributed movement, reading {observed} against a typical {typical}.",
      driver_lowers:
        "{code} lowers the model's forecast: {phi_mwh}, {share} of the attributed movement, reading {observed} against a typical {typical}.",
      top_two_share:
        "Those two groups together account for {top_two_share} of the attributed movement.",
      hour_disagreement:
        "{code} acted in both directions during the day: its hours disagree by {hour_disagreement}.",
      flag_nothing_to_explain:
        "A rule withheld the ranking. The day's occurrence probability of {day_occurrence_probability} sits below the lowest risk bin edge of {lowest_risk_bin_edge}, and {hours_p50_nonzero} hours carry a P50 above zero.",
      flag_attribution_is_noise:
        "A rule withheld the ranking. The attributed movement of {sum_abs_attributed_mwh} does not clear its own background-sampling error of {attribution_stderr_mwh}.",
      flag_stale_inputs_run_age:
        "A rule flagged the inputs: the weather run behind this forecast was {weather_run_age_hours} old at the gate.",
      flag_stale_inputs_coverage:
        "A rule flagged the inputs: only {weather_centroid_coverage} of the weather centroids were available.",
      flag_stale_inputs_headline:
        "A rule flagged the inputs: these groups had no headline reading at serve time — {null_headline_features}.",
      flag_unmodelled_outage_regime:
        "A rule flagged the regime: on {date}, the most recent settled day, reason {top_reason} took {top_reason_share} of the constrained-off energy, and no ingested dataset carries transmission availability for the model to read.",
    } satisfies Record<NarrationClauseKey, string>,

    /** The reliability (calibration) diagram. */
    reliability: {
      figure: "Reliability diagram: forecast probability against observed frequency",
      axis: "forecast probability (%)",
      note: "Dots below the dashed identity line are over-confident forecasts: of the hours called 85%, 77% actually cleared the threshold. Dot area is the number of hours in the bin.",
    },

    overview: {
      metaTitle: "Grid Overview — WattSteer",
      title: "Grid Overview",
      lede: "Day-ahead curtailment risk for {date}, by subsystem. Every figure is a P10/P50/P90 interval, not a point.",
      rowFigure: "{subsystem}: open Explain",
      rowEnergy: "Expected curtailed energy",
      rowPeak: "peak {low}–{high} MW",
      profileSubtitle: "24-hour profile, P10–P90",
      dailyEnergy: "Curtailed energy, whole day",
      dailyEnergyNote:
        "A day total is a joint forecast read from the path ensemble. It is neither the sum of the hourly P90s nor the sum of the hourly P50s — no quantile adds, medians included.",
      peakPower: "Peak hourly power",
      peakPowerNote:
        "The largest hour within a drawn day, over the same ensemble. Threshold in force: {mw} MW at subsystem grain.",
      grainNote:
        "Forecast grain is the subsystem. Observed curtailment is published per reporting entity — a conjunto for most of it — and restriction reasons exist only there; see Explain.",
    },

    split: {
      title: "Wind and solar",
      subtitle: "Two scalars, no band",
      expected: "Expected curtailed energy, whole day",
      expectedNote:
        "E[Y], published beside the band rather than inside it. It is not the middle of the interval: with mass sitting on “no curtailment at all”, the expectation runs above the median, and on a quiet day the median is flatly zero while the expectation is not.",
      note: "The forecaster has one head per subsystem, so wind and solar are a division of that expectation and nothing more. There is no wind band and no solar band to draw, which is why picking a technology above emphasises one of these two numbers instead of filtering the forecast.",
      emphasised: "shown",
    },

    explain: {
      metaTitle: "Explain — WattSteer",
      title: "Why {subsystem}?",
      lede: "What the model is reading on {date}, and how much of it to believe.",
      riskTitle: "Curtailment risk",
      riskSubtitle: "P(any hour above threshold)",
      magnitude: "Expected magnitude, whole day",
      magnitudeNote: "Conditional on the day clearing the threshold at all.",
      peakPower: "Peak hourly power",
      narrationTitle: "Narration",
      narrationSubtitle: "Generated in the requested locale",
      /**
       * No `{technology}`.
       *
       * The paragraph used to open "{subsystem} {technology} curtailment",
       * which described one of two explanations of a prediction the model only
       * makes once. There is one attribution per subsystem-day.
       */
      narration:
        "The model puts {subsystem} curtailment above the {mw} MW threshold for most of the day. The largest single contribution is {top}, whose headline feature {feature} reads {observed} against a typical {typical}, followed by {second}. Those two together account for {share} of the attributed movement. The band is wide in the shoulder hours because the occurrence classifier is near an even chance there — read the P10 as “it may not clear the threshold at all”, not as a small number.",
      /**
       * Two footnotes, because there are two authors.
       *
       * The panel used to assert unconditionally that a language model wrote
       * the paragraph. That is false whenever a rule withheld the model's
       * narration, whenever the model is down and whenever the daily cap is
       * reached — and the response says which happened, so the footnote can
       * simply be true.
       */
      narrationNoteModel:
        "Written by a language model from the attribution table below. It restates the numbers; it does not add any.",
      narrationNoteTemplate:
        "Assembled from the attribution table below by a fixed template, with no language model involved. It restates the numbers; it does not add any.",
      /**
       * The withheld state, which is a successful answer and not an error.
       *
       * A `withhold` rule suppresses the *generated* paragraph and nothing
       * else: the response is a 200 whose ranking is untouched, and
       * `withheld_by` names the rules. So the panel says which rule spoke and
       * then keeps showing every driver group — an empty state here would
       * discard numbers the server deliberately kept.
       */
      narrationWithheld:
        "A domain rule withheld the generated narration for this day: {codes}. The attribution below is unchanged — all eight driver groups, each with its own number.",
      /**
       * The footnote's own label for where the paragraph came from.
       *
       * `narration.source` is the only field that says whether a language model
       * or the fixed template wrote what is on screen, and it is the same field
       * whether a rule withheld the model's paragraph, the model was
       * unreachable, or the day's global call budget was spent. Two short
       * labels rather than one sentence, so the footnote can name the source
       * beside the longer note without repeating it.
       */
      narrationSourceModel: "Source: language model",
      narrationSourceTemplate: "Source: fixed template",
      driversTitle: "Driver attribution",
      driversSubtitle: "SHAP, at subsystem grain",
      reliabilityTitle: "Reliability",
      reliabilitySubtitle: "Forecast vs observed frequency",
      reliabilityNote:
        "{hours} hours from {from} to {to}. The whole window predates ingestion go-live, so it is scored against ONS's current restatement of the past, not against what was knowable at the time.",
      reasonsTitle: "Observed restriction reasons",
      reasonsSubtitle: "Settled by ONS for {date}",
      grainConjunto: "reason observed at conjunto grain",
      grainPlant:
        "reason observed at plant grain — this plant is its own reporting entity",
      reasonLegend:
        "Reason codes: REL external (grid) unavailability · CNF reliability requirement · ENE energetic (oversupply) · PAR access-opinion restriction. Origin: LOC local, SIS systemic. A conjunto's reason is never allocated down to its member plants — that would be an allocation presented as an observation, and WattSteer does not compute one.",
      next: "Next:",
      nextMitigate: "What could absorb it →",
    },

    mitigate: {
      metaTitle: "Mitigate — WattSteer",
      title: "What can we do?",
      lede: "{subsystem}, {date}. Storage and flexible demand sized against the day-ahead forecast.",
      // --- flex-optimizer 08: the posture, stated rather than offered -------
      //
      // The basis toggle used to sit here. `docs/specs/flex-optimizer.md` calls
      // it "the right question asked in the wrong place": the screen was
      // refusing to hide a modelling choice, but the choice was a defect in the
      // framing rather than a preference. What replaces it is the execution
      // rule, without which "planned against P50" gets read as "assumes P50
      // comes true".
      postureTitle: "One plan, one promise",
      postureSubtitle: "Planned against the median · promised on the low edge",
      postureRule:
        "On the day, each asset charges the scheduled amount or the amount actually being curtailed, whichever is smaller — and discharges the scheduled amount or what its state of charge permits, whichever is smaller. The assets absorb what is actually curtailed and never more.",
      postureWhy:
        "So planning against the median is not the same as assuming the median comes true. If the day comes in small the assets simply absorb less, the figure below falls, and nothing is imported from the grid. That is why the plan can be optimistic while the number quoted stays conservative — and why you are not asked to pick a quantile in order to get an answer.",
      floorTitle: "The floor",
      floorLabel: "Energy recovered on the low edge",
      floorSentence:
        "This plan recovers {floor} MWh if every hour lands at the low edge of its forecast band. That is the number to quote to someone else.",
      floorMedian: "On the median realisation",
      floorHigh: "On the high realisation",
      floorBesideNote:
        "Shown beside the floor and not in front of it: a conservative promise should not hide the upside, and the upside is not the promise.",
      notJointTitle: "What the floor does not say",
      notJointBody:
        "An hour-wise P10 profile is not a 90 % confidence statement about the day. The plan is feasible against each hour's own low edge; the joint probability that all 24 hours land at or above theirs is neither 90 %, nor computed, nor claimed. Quantiles do not add.",
      deliveredTitle: "Recovered is not delivered",
      deliveredSubtitle: "On the planning envelope",
      storedLabel: "Still stored when the horizon ends",
      lossLabel: "Lost to the round trip",
      deliveredNote:
        "Absorbed energy is metered at the grid boundary: it is renewable energy that would have been spilled and instead flowed into an asset. What the asset later delivers is smaller by the round-trip loss, with some of it still inside the battery at midnight — there is no terminal state-of-charge target, because requiring one would penalise absorption on the day being planned in order to serve a day this horizon does not cover.",
      refusalTitle: "This scenario was refused",
      refusalNote:
        "The same table the gateway applies before it builds a model, running here on the link you arrived with. Nothing was corrected: a repaired input produces a plan for a fleet you did not describe, and nothing on the screen would say so.",
      refusalReset: "Start again from the reference fleet",
      shareNote:
        "The address bar is the scenario. Copy the link and the recipient sees this fleet, this day and this assumed price — there is no account, nothing is saved, and the back button and a bookmark work the way they look like they should.",
      steps: {
        no_action: "No action",
        battery: "+ Battery",
        battery_and_load: "+ Flexible load",
      },
      reveal: "Reveal",
      hidden: "Hidden — reveal it in order to see what the step recovers.",
      remaining: "MWh remaining",
      baselineStep: "The day as forecast, with nothing dispatched.",
      stepRecovered: "{recovered} MWh recovered on the P50 realisation",
      avoided: "Curtailment avoided",
      realisationLow: "On the low realisation",
      realisationMedian: "On the median realisation",
      realisationHigh: "On the high realisation",
      avoidedNote:
        "The share falls as the event grows: a fixed fleet covers less of a bigger day, so the high realisation sits below the median. The low realisation sits below both for a different reason — a plan cannot absorb energy that was never curtailed, so on a small day the assets simply do less. Three shares, not an interval, and the track spans them with the median marked.",
      avoidedUndefined:
        "Undefined, not zero. A day with nothing above the threshold has nothing to divide by, and a zero here would read as nothing could be avoided rather than there was nothing to avoid.",
      economicTitle: "Economic scenario (labelled)",
      economicRate: "Assumed value",
      economicNote:
        "At an assumed {rate}/MWh, on the median realisation. This is a scenario, not a settlement value, and it is the only place R$ appears. No carbon claim is derivable from any of this and none is made.",
      economicOnlyMoney:
        "Move it and only this figure moves. The optimizer is denominated in energy, never in money, so nothing it recommends is a function of a price WattSteer invented.",
      solvingTitle: "Solving",
      solvingNote:
        "The Flex Optimizer is building and solving the MILP for this fleet. It answers inside the request — there is no job to poll for — so this should be gone before you finish reading it.",
      economicNoPlan:
        "No plan, no figure. Nothing was dispatched in this step, so there is nothing to price.",
      dispatchTitle: "Dispatch",
      dispatchSubtitle: "{step} · the scheduled plan, on the planning envelope",
      dispatchScheduled:
        "This is what the assets are scheduled to do against the median forecast, with the battery's state of charge drawn alongside it. On the day the execution rule above clips both legs, so the realised trajectory is this one or lower — never higher.",
      batteryTitle: "Battery",
      loadTitle: "Flexible load",
      assetSubtitle: "Scenario input, not an inventory",
      reset: "Reset to {power} MW / {energy} MWh + {shift} MW",
      footnote:
        "ONS publishes no flexibility-asset registry, so every parameter above is your assumption. Mitigate is a what-if tool, not an inventory — the scenario is encoded in the URL rather than saved, so a link is the whole of sharing it.",
    },

    /** The asset parameter steppers on Mitigate. */
    assets: {
      decrease: "Decrease {label}",
      increase: "Increase {label}",
      batteryPower: "Power (MW)",
      batteryEnergy: "Energy (MWh)",
      roundTrip: "Round-trip efficiency",
      initialSoc: "Initial state of charge",
      batteryNote:
        "{hours}-hour duration. Efficiency splits into a charge and a discharge leg (√RTE each); the loss enters the state-of-charge balance asymmetrically.",
      loadConnection: "Connection limit (MW)",
      loadShift: "Shiftable power (MW)",
      loadWindow: "Shift window (h)",
      loadDailyEnergy: "Daily energy (MWh)",
      loadNote:
        "Daily energy is conserved by construction: every hour shifted up is compensated by down-shifts inside the window, so the load consumes the same MWh either way.",
    },

    replay: {
      metaTitle: "Time Machine — WattSteer",
      title: "What if WattSteer had been running?",
      lede: "A past day, replayed against the forecast vintage available at D−1 and scored against what ONS settled.",
      dayLabel: "{date} · {subsystem}",
      honestyTitle: "What this replay is, and what it is not",
      // `integrity.provenance` — a statement, not a warning. There is no
      // IN-SAMPLE label here because there is no in-sample day: a day no
      // artifact held out is refused rather than labelled, so the badge says
      // *how* the day was held out and the notes below name the artifact that
      // held it.
      provenance: {
        served: "SERVED",
        fold_holdout: "FOLD-HOLDOUT",
      },
      provenanceServedNote:
        "The forecast on this screen is the one WattSteer actually published, at {published} — before the day it describes had begun. No version of the model could have seen the day, so this is a counterfactual in the strict sense and not a reconstruction.",
      provenanceFoldHoldoutNote:
        "This day falls in walk-forward test fold {fold}, and the forecast comes from that fold's own artifact ({artifact}) — never from the model on serving duty today. That artifact was trained on {trainFrom} – {trainTo} and calibrated on {calibrationFrom} – {calibrationTo}; neither window contains this day, and both are re-checked against the artifact's own record every time the day is read rather than taken on trust.",
      revisionOptimisticNote:
        "This day predates ingestion go-live ({goLive}). ONS rewrites history in place with no version marker, so the actual above is ONS's current restatement of the day, not what was published at the time. Prior vintages are unrecoverable and this can never be repaired retroactively.",
      pointInTimeNote:
        "This day postdates ingestion go-live ({goLive}), so every value here is the one that was genuinely knowable at the time — an as-of read, not today's restatement.",
      // The extent of the vintage caveat, named part by part. The parts are the
      // response's `vintage_affects` / `vintage_exempt`; this map only spells
      // them, so a part the service stops claiming disappears from the screen
      // without an edit here.
      vintageExtentNote:
        "It touches {affects}. It does not touch {exempt}: those carry the run that produced them as their own publication instant, so the D−1 run this replay planned against is that run.",
      vintagePart: {
        settled_actuals: "the settled actual this day is scored against",
        lagged_actual_features:
          "the lagged-actual features (the right hours, possibly the wrong values)",
        weather_run: "the weather run",
        dessem: "DESSEM",
        ons_programming: "the ONS programming",
      },
      // `null` on the wire, and the word the spec insists on. Never "0 MWh":
      // an unmeasured caveat rendered as a small number is the failure this
      // sentence exists to prevent.
      revisionPremiumUnmeasured:
        "The size of that caveat is unmeasured. It becomes measurable only once ONS has restated days WattSteer holds in both vintages, and until then no number is offered in its place.",
      revisionPremiumMeasured:
        "Measured against the days held in both vintages, the restatement is worth {mwh} MWh of recovered energy on average — the amount by which a revision-optimistic replay should be read down.",
      scenarioNote:
        "Recovered energy is what this dispatch achieves under this scenario against this forecast vintage. It is a property of the scenario, not of the day, and changing any asset parameter changes it.",
      claimsNote:
        "MWh recovered and % avoided are the only claims made. No carbon saving is derivable from recovered renewable energy without a marginal-emissions model, and none is offered.",

      // The one headline. Absorbed, recovered and avoided are one quantity with
      // three names, and three boxes would imply three facts.
      headlineRecovered: "Energy the fleet would have recovered",
      scoredOnObserved: "Scored on the settled day, not on the forecast",
      headlineSentence:
        "{recovered} MWh of the {actual} MWh ONS settled, absorbed by the fleet below under the execution rule: on the day an asset takes the scheduled amount or the amount actually being cut, whichever is smaller.",
      floorLabel: "Floor promised at D−1",
      floorMetLabel: "Floor cleared",
      floorMet: "Yes",
      floorMissed: "No",
      floorMarginLabel: "Margin over the floor",
      floorNote:
        "The floor is the P10-simulated recovery — what was promised before the day happened. Clearing it is an empirical claim the product checks per day, never a theorem: an observed day is not obliged to sit above the P10 envelope in every hour.",

      headlineAvoided: "Curtailment avoided",
      avoidabilityNote:
        "Recovered energy over the whole settled day. A day that came in larger than forecast earns a smaller share, because the fleet is fixed and the denominator is not.",
      avoidabilityUndefined:
        "Undefined, and shown as a dash rather than as 0 %. No hour of this day reached {mw} MW, so there was no curtailment to avoid — which is a different statement from a plan that avoided none of it.",
      headlineCurtailed: "Renewable energy curtailed",
      denominatorNote:
        "The whole local day, and the denominator of every share on this screen. Never the episode total: a percentage whose denominator moves with the threshold would improve simply for having drawn the episode more tightly.",

      compareTitle: "The day, three ways",
      compareSubtitle: "Settled vs forecast vs what would have been left",
      rowActual: "Curtailed — settled by ONS",
      rowActualNote: "{hours} contiguous hours above {mw} MW, peak {peak} MW.",
      rowForecast: "What the D−1 run said",
      rowForecastNote:
        "P10–P90 shaded, P50 solid. A joint day total, never the sum of the hourly quantiles.",
      rowRemaining: "Left after the fleet",
      rowRemainingNote:
        "What the settled day still contained once the fleet had taken what the plan scheduled and the hour actually offered.",

      hourlyTitle: "Hour by hour",
      hourlySubtitle: "What was forecast, and what happened",
      settledActual: "Settled actual",

      planVsExecutedTitle: "The plan, and what it would have done",
      planVsExecutedSubtitle: "Scheduled against executed — two series, never one",
      planVsExecutedFigure:
        "Hourly chart: settled curtailment as bars, with the scheduled and the executed absorption as two lines",
      seriesActual: "Settled by ONS",
      seriesScheduled: "Scheduled at D−1",
      seriesExecuted: "Executed on the day",
      planVsExecutedNote:
        "Where the executed line sits below the scheduled one, the forecast ran high and the scheduled energy was never there to take. Where the bars sit above both, the forecast ran low: real curtailment the plan never asked for, left alone on purpose — taking it would be a re-optimisation against information the plan did not have, and it would flatter exactly the days the forecast got most wrong.",

      // The upper bound, fenced. The label is the spec's own words and is not
      // compressed into something shorter: "potential" would read as a target.
      foresightLabel: "The best any plan could have done knowing the answer",
      foresightRecovered: "Recovered with perfect foresight",
      foresightAvoidability: "Share of the day",
      foresightGap: "What the forecast cost",
      foresightNote:
        "Hindsight, and labelled as one: this plan was built on the settled day itself, which no forecast can be. It is an upper bound and never a recovery claim, and the gap beside it is the only honest use of it — what a better forecast would have been worth on this day, for this fleet.",

      episodesTitle: "Episodes",
      episodesSubtitle: "A read-time view of the day, carrying its own parameters",
      episodeRow:
        "{from} → {to} · {hours} h · {mwh} MWh · peak {peak} MW · threshold {mw} MW · gap tolerance {gap} h",
      episodeNote:
        "An episode is a read-time view of curtailment hours, never a stored row. Every one above carries the threshold and the {gap}-hour gap tolerance that produced it, because an unstamped duration cannot be compared with another one — a different threshold would produce different episodes from the same data.",

      batteryTitle: "Battery",
      loadTitle: "Flexible load",
      fleetSubtitle: "The fleet this day is scored against",
      fleetReset: "Back to the reference fleet",
      fleetNote:
        "Moving any of these re-plans the day and re-scores it against what happened. It cannot re-forecast: the forecast is a pinned historical row and nothing in this request path loads a model, which is the property that makes this a replay rather than a simulation.",

      replayingTitle: "Replaying",
      replayingNote:
        "One solve and five scoring passes against the settled day. Nothing is drawn until all of them have answered — a half-filled screen would be numbers from two different fleets side by side.",
      replayingLive:
        "This screen reads a live API and cannot be prerendered. GET /v1/replay re-plans the day and scores it with the one simulator, which does not run in a browser — so a static export ships this note and no figures, and stays on it. To see a replayed day, point the build at a running gateway with EXPO_PUBLIC_API_URL, or start one locally with bun run api and reload. Grid Overview and Explain need neither.",

      observedOnlyTitle: "This day cannot be replayed, and here is the clause it failed",
      observedOnlyNote:
        "What is offered instead is the day itself: the settled profile, its episodes and the bound below, which needs no forecast and therefore no model. There is no recovered figure and no share avoided — not zero, absent, because WattSteer was never asked to plan this day.",

      refusalTitle: "No replay for that request",
      refusalNote:
        "Nothing is drawn in its place. A number with a caveat over it is a number that gets quoted without the caveat, which is the whole reason this screen refuses rather than labels.",
      refusalReset: "Back to the reference fleet",
      shareNote:
        "The fleet lives in the address bar, so this link is the whole state — including the day and the assets it was scored against.",
    },
  },
} as const;

/**
 * The shape every locale must satisfy, derived from English.
 *
 * `Widen` keeps the structure and the `readonly` markers but replaces each
 * string *literal* with `string`, so a locale supplies its own words while
 * still being checked key-for-key. A locale that omits a string, or invents
 * one, fails to compile — which is the whole point: a missing translation
 * should be a build error, not a silent fallback to a key name at runtime.
 */
export type Copy = Widen<typeof en>;

type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Widen<T[K]> }
      : T;
