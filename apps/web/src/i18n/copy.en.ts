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
        body: "Source datasets remain the property of their publishers and are used under their respective open licences. Where a licence requires attribution or share-alike treatment of derived data, WattSteer complies with it; those notices appear alongside the data they cover.",
      },
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
