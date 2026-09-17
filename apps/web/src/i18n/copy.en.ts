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
  },

  /**
   * The loading screen at bare `/`, and the footer.
   *
   * `splash.tagline` used to be `gate.tagline`, and used to be rendered in
   * **both** locales at once, side by side, because the screen it belonged to
   * was a chooser and a chooser that addresses the reader in one language has
   * already chosen for them. There is no chooser any more: the screen resolves
   * the locale itself (stored choice, then browser, then Portuguese) and says
   * one sentence, in that locale. So this now goes through `copy` like every
   * other string.
   */
  splash: {
    tagline: "Curtailment intelligence for the Brazilian grid.",
    /** Screen-reader name for the progress indicator; never drawn as text. */
    loading: "Loading WattSteer",
    /** Only reachable with scripting off — see `app/index.tsx`. */
    continue: "Continue to WattSteer",
  },

  footer: {
    /** AGPL §13: the offer of corresponding source, on the page it is served from. */
    sourceLink: "Source code",
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
    VOICE_NOT_CONFIGURED: "Voice isn't configured in this deployment.",
    VOICE_UNAVAILABLE: "The voice session couldn't be started.",
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
    eyebrow: "Day-ahead curtailment · Brazilian grid",
    headline: {
      lead: "Today we can tell that curtailment happened.",
      accent: "WattSteer tells you it is coming.",
    },
    /**
     * The team's own deck, not the essay this used to be.
     *
     * It ran 351 characters across four clauses, three of which restated the
     * problem the headline directly above had already stated. Page 01 of
     * `public/wattsteer-pitch.pdf` makes the whole pitch in 118 — a figure, a
     * fact, a claim — and page 04's spine ("do plano à decisão") is the
     * sentence this now is: the deck's own subhead, "a camada de decisão
     * entre o plano do ONS e a operação em tempo real", plus the three things
     * the product puts in that layer.
     *
     * Every clause is a description of the product, not a promise about this
     * deployment: no artifact is promoted, so nothing here may read as "a
     * forecast is waiting for you". "Tomorrow's curtailment risk" is the
     * deck's own wording for the demonstration site (p. 05, "risco de corte
     * do dia seguinte por região, sempre como faixa"), and the readout
     * directly below carries the sample badge that says whose numbers those
     * are.
     *
     * The middle term is "what pushed it up", where the deck names the thing
     * the ONS reason codes name. Not a softening — the §10 boundary in
     * `docs/domain-model.md`. The engine reports attribution, so the product
     * may say the model raised or lowered its forecast and may not say a
     * grid condition brought the cut about. The Portuguese for the deck's
     * word is a banned lemma and the repo-level boundary guard under `test/`
     * caught it here; the English one is not, and would have shipped on the
     * same sentence a scan had just rejected. That asymmetry is
     * why both locales take the sanctioned verb rather than only the one the
     * scanner happened to stop.
     */
    sub: "The decision layer between ONS's day-ahead plan and real time: tomorrow's curtailment risk by subsystem, what pushed it up, and the band around it — never a bare number.",
    primaryCta: "Open the prototype",
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
      "The expected-value line is the one that adds: the four expectations come to exactly the national figure beside them, and you can check it. The P50s do not add — the P50 of a sum is the sum of the P50s only if the four subsystems move together, and they do not — and bands are not additive at all. That is why the national figure is an expectation and not a median.",
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
      "A curtailment forecast that says {value} MWh and nothing else is a number pretending to be a fact. WattSteer publishes P10, P50 and P90 together and draws the distance between them, so the width of the uncertainty is as visible as the middle of it. Where a figure genuinely has no band — a measured historical actual — it is labelled observed, so the absence means something.",
  },

  engines: {
    title: "Four engines, not one model",
    sub: "Forecasting alone is half a product. The value is in what happens after the number.",
    /**
     * Which of the four are answering today.
     *
     * The four cards are written in the present tense and the deployment does
     * not yet earn all of it: ingestion and the data platform are live, and no
     * model artifact has been promoted, so the forecast and diagnosis routes
     * answer with a named refusal rather than a number. A section that
     * describes four engines without saying which one is serving is the
     * overclaim this page is least able to afford, because it is the page's
     * whole argument.
     */
    status:
      "Where each stands today: ingestion and the data platform are live and reading ONS, ANEEL and Open-Meteo on schedule. No model artifact is promoted for serving yet, so the Forecaster and Diagnosis routes answer with a stated refusal rather than a forecast, and every figure shown on this page is a deterministic fixture. The Flex Optimizer and Replay solve against a real gateway when one is running.",
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
    sub: "These are the product's own panels, rendered over a deterministic fixture. Same components, same units, same bands as the prototype's own screens.",
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
        // Named here rather than left to be inferred. `app.narration
        // .flag_unmodelled_outage_regime` already states the same absence
        // inside the product, where a driver group has no transmission
        // feature to read; this is the public half of the same sentence.
        {
          label: "No transmission maintenance is read",
          body: "ONS publishes planned maintenance and outages as prose rather than as a dataset, and WattSteer ingests none of it. So a day whose curtailment was driven by a line out of service has no feature carrying that fact, and the model reads around it. Nothing on this site is derived from maintenance data.",
        },
      ],
    },
  },

  footerCta: {
    headline: {
      lead: "Don't just predict wasted energy.",
      accent: "Prevent it.",
    },
    sub: "Day-ahead curtailment risk for the Brazilian grid, from open data.",
    button: "Open the prototype",
  },

  /**
   * Head metadata. Locale-prefixed routes only pay off if what a crawler
   * indexes is *also* in that locale, so the title and description are copy
   * like everything else rather than a constant in the route file.
   */
  meta: {
    /** Alt text for the 1200×630 share card (`public/og.png`). */
    imageAlt: "WattSteer — curtailment intelligence for the Brazilian grid",
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

  /**
   * The pitch deck page at `/pitch`.
   *
   * It has no entry under `meta` above because it is not one of the
   * locale-prefixed routes that block describes: the deck is a single PDF, the
   * page is `noindex,follow`, and only the chrome around the frame is copy at
   * all. Its head strings therefore sit with the rest of the screen, the way
   * `notFound.metaTitle` and `app.*.metaTitle` already do.
   */
  pitch: {
    metaTitle: "Pitch deck — WattSteer",
    metaDescription:
      "The WattSteer pitch deck: what curtailment costs the Brazilian grid, and what seeing it a day ahead is worth.",
    badge: "Pitch deck",
    title: "The case for WattSteer, in ten slides",
    lede: "The same argument the product makes, in the order it was first made: the curtailed energy ONS already publishes, the forecast that would have seen it coming, and what a plant could have done with a day's warning.",
    embedTitle: "WattSteer pitch deck (PDF)",
    fallback:
      "The deck is a PDF. If your browser downloads PDFs rather than showing them, the frame below stays blank.",
    openLabel: "Open the PDF",
    /** The footer link. Short: it sits in a row with the legal links. */
    footerLink: "Pitch deck",
    /** The top-nav link. Same words as the footer's, one row apart. */
    navLink: "Pitch deck",
    /**
     * The landing page's deck section. `title` and `lede` above are reused
     * there verbatim — one document, one description of it — so the section
     * adds only the two strings the `/pitch` page has no use for: the button
     * that opens it, and the alternative text for the slide it previews.
     */
    sectionCta: "Open the deck",
    slideAlt:
      "The deck's first slide: R$ 6.5 billion of clean energy curtailed in 2025, beside a map of Brazil's four subsystems.",
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
  briefing: {
    label: "Visual briefing",
    dismiss: "Close",
    /** Read out to a screen reader as the sequence advances. */
    position: "Scene {index} of {total}",
    /** Shown when the browser refused to play audio, or the reader has it off. */
    silent: "No audio — the narration is written below.",
    refusalTitle: "Nothing to present",
    recommendationBody:
      "Pre-position the flexibility across the window above. The plan is on Mitigate, against the fleet you described.",
    done: "End of briefing",
    again: "Replay",
    scenes: {
      title: "Briefing",
      mapFocus: "Where",
      forecastCurve: "Hour by hour",
      observedCurve: "What settled",
      constraint: "Registered reasons",
      comparison: "Plan vs executed",
      counterfactual: "What if?",
      recommendation: "Suggested action",
      sources: "Sources",
    },
  },
  app: {
    shell: {
      backToLanding: "WattSteer — back to the landing page",
      /**
       * The badge used to read `PROTOTYPE · FIXTURE DATA`, unconditionally, on
       * all four screens. The second half stopped being true when Mitigate
       * started solving on `POST /v1/optimize`, and it is now false everywhere:
       * every screen reads the gateway. What is left is the half that is still
       * true, and `noModelBadge` beside it — which is a fact read from
       * `/v1/meta` rather than a label, and disappears on its own the day an
       * artifact is promoted.
       */
      noModelBadge: "NO MODEL PROMOTED",
      /** Names the `tablist` around the four screen pills for a screen reader. */
      screensLabel: "Screens",
      /** The accordion control on a collapsed section, and on an open one. */
      expand: "Open",
      collapse: "Collapse",
      /**
       * The two sections of the Grid Overview, named short.
       *
       * Not in `screens` any more: that node is the nav row's labels, and the
       * row names places a reader travels to. These are places on the page the
       * reader is already on. The voice agent still names them — "Opened
       * Explain for you" — which is why they are copy and not a comment.
       */
      sections: {
        explain: "Explain",
        mitigate: "Mitigate",
      },
      screens: {
        overview: "Grid Overview",
        replay: "Time Machine",
      },
      selection: {
        subsystem: "Subsystem",
        run: "D−1 run",
        /*
          Shown on the run pills when they cannot change anything.

          The run chooses which D−1 forecast to read, so with no model promoted
          every choice reads the same refusal. A live control that moves nothing
          is the one kind of dishonesty this product cannot afford: every other
          panel here withholds itself and says why, and a selector that stays
          bright while doing nothing contradicts all of them.
        */
        runUnavailable: "This run has no promoted model — picking it changes nothing",
        targetDay: "Target day",
      },
    },

    /**
     * The serving lanes, as `/v1/meta` reports them.
     *
     * Codes are keys and labels are copy, exactly as for risk classes and
     * reason codes. The modelling service also publishes an `unusable_reason`
     * — the gate's own English prose, naming the guardrail and its numbers —
     * and it is deliberately **not** rendered: it is developer prose in the
     * same status as an error envelope's `message`, and an English paragraph
     * printed to a Portuguese reader is the failure the whole i18n rule exists
     * to prevent.
     */
    lane: {
      heading: "Serving lanes:",
      condition: {
        no_artifact: "no artifact",
        present_unpromoted: "refused by the gate",
        promoted: "promoted",
        unresolvable: "unresolvable",
      },
      noLanes: "none reported",
      modelUnreachable: "the modelling service could not be reached",
      note: "A lane is a feature set, a gate and a threshold. A forecast is published only from a promoted lane, so while none of the {count} above is promoted there is nothing to publish — the gate refusing a candidate is the gate working, and the detail is on GET /v1/meta.",
    },

    /** `Technology` is an enum in the API; these are its words. */
    technology: { WIND: "Wind", SOLAR: "Solar" },

    /**
     * The voice copilot — `components/voice/*`.
     *
     * Keyed on the same unions the code branches on: `VoiceStatus` (seven, two
     * of them WattSteer's own) and `ToolRefusalCode` (thirteen). That is
     * deliberate and `voice-dock.test.ts` asserts it, because the failure it
     * prevents is invisible — a status or a refusal with no sentence is a pill
     * that renders blank or a card that renders `undefined`, at exactly the
     * moment the reader is watching hardest.
     *
     * The refusals are written as the **agent** speaking, not as the app
     * reporting. `execute.ts` separates its codes by what the reader should
     * hear — `unknown_subsystem` is answerable with "I know N, NE, SE and S"
     * and `unknown_run` with "there are two runs" — and writing them in the
     * third person would spend that separation on nothing.
     */
    voice: {
      /** The header control. Short, because it sits beside `PT / EN`. */
      /** The IDLE pill — the invitation, written out in full exactly once. */
      idle: "Ask WattSteer",
      panelTitle: "WATTSTEER AI",
      expand: "Open the voice panel",
      collapse: "Collapse the voice panel",
      close: "End the voice session",
      status: {
        idle: "Ask WattSteer",
        connecting: "Connecting…",
        listening: "Listening…",
        thinking: "Thinking…",
        speaking: "Speaking…",
        acting: "Opening it for you…",
        error: "Voice stopped. Press to try again.",
      },
      transcript: {
        you: "You",
        agent: "WattSteer",
        empty:
          "Ask about a region, why a day looks the way it does, or what could be done about it.",
      },
      action: {
        navigate: "Opened {screen} for you",
        focused: "Changed the selection for you",
        highlighted: "Highlighted {subsystem}",
        highlightCleared: "Cleared the highlight",
        briefing: "Briefing opened",
        refused: "I didn't do that",
        noScreenChange: "No screen change — you're already where the answer is.",
        scenarioChanged: "scenario updated",
      },
      refusal: {
        unknown_tool: "That isn't something I can do here.",
        malformed_arguments: "I couldn't read what I asked for. Say it again?",
        unexpected_argument: "That doesn't belong to what I was doing.",
        missing_argument: "I need to know which one you mean.",
        unknown_subsystem: "I don't know that subsystem — I know N, NE, SE and S.",
        unknown_technology: "I know two fleets: wind and solar.",
        unknown_run: "There are two D−1 runs: 00Z and 12Z.",
        unknown_driver: "That isn't one of the driver groups the attribution ranks.",
        unknown_episode: "That day isn't in the Time Machine's catalogue.",
        unknown_question_kind:
          "I couldn't tell what kind of question that was, so I didn't open a briefing.",
        value_out_of_range: "That value is outside what the editors themselves accept.",
        ambiguous_replay: "Tell me either a day or how far back — not both.",
        no_episode_for_relative_day: "Nothing that far back is in the catalogue.",
        scenario_refused: "That fleet isn't one the optimizer would accept.",
      },
      mic: {
        deniedTitle: "No microphone",
        deniedBody:
          "The browser didn't let WattSteer hear you. Type instead — the same questions work.",
      },
      typed: {
        label: "Type a question instead of speaking",
        placeholder: "Type a question",
        send: "Send",
      },
    },

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
      // The same two sentences without the pair, for a group whose headline
      // feature has no reading for this day or none over the matched
      // background. The contribution, the share and the direction are the
      // model's and are unaffected; only the comparison is missing, and the
      // sentence says so instead of quoting a zero.
      driver_raises_no_reading:
        "{code} raises the model's forecast: {phi_mwh}, {share} of the attributed movement. Its headline feature has no observed-against-typical pair for this day, so none is quoted.",
      driver_lowers_no_reading:
        "{code} lowers the model's forecast: {phi_mwh}, {share} of the attributed movement. Its headline feature has no observed-against-typical pair for this day, so none is quoted.",
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
      // No promoted artifact means no reliability run, so this sentence says
      // how to read the diagram and quotes nothing. The pair of percentages
      // that used to stand here belonged to the fixture, not to a measurement.
      note: "Dots below the dashed identity line are over-confident: fewer hours cleared the threshold than the forecast probability for that bin promised. Dot area is the number of hours in the bin.",
    },

    /**
     * The **settled** vocabulary, and the reason it is a block of its own.
     *
     * The Overview answers the same six questions in two states — a promoted
     * model, and none — and the strings for the second state are not variants
     * of the strings for the first. They name a different day, a different
     * quantity and a different kind of claim, and every one of them says so in
     * words rather than leaving it to a colour: "settled", "observed", the
     * window, the date. A reader who sees only one of the two states must still
     * be able to tell which one it is, and a screen reader user gets nothing
     * from the cyan.
     *
     * Nothing in here may promise an interval. There is no P10–P90 over a
     * measurement, and where the forecast copy names one, the observed copy
     * says why there is none.
     */
    observed: {
      badge: "Observed",
      stamp: "Observed · settled through {when} BRT · {lag} h behind",
      window24h: "Last 24 h to {hour} BRT",
      windowDay: "Settled day, {date}",
      rowEnergy: "Curtailed energy, last 24 h",
      selectedFigure: "{mwh} MWh settled · wind {wind} · solar {solar}",
      noFan:
        "There is no P10–P90 ribbon over these bars and there cannot be: a ribbon is a model's output and these hours are settled. What is drawn is what happened, to the megawatt-hour.",
      dayTotal: "Settled curtailed energy, whole day · {subsystem}",
      dayTotalNote:
        "The settled hours of the day, added. Observations add exactly — the same addition that lets a national total exist at all — so this figure may be computed here, where a forecast band never could be.",
      peakHour: "Largest settled hour · {subsystem}",
      peakHourWindow: "{hour}h BRT on {date}",
      peakHourNote:
        "An energy in MWh, not a power in MW: ONS publishes energy per hour, and the peak-power band a forecast states is a model's claim about the shape inside that hour. There is no such model today, so no such figure is shown.",
      splitTitle: "Wind and solar",
      splitSubtitle: "{subsystem} · settled, two measurements",
      splitTotal: "Settled curtailed energy, whole day",
      splitNote:
        "ONS settles the two fleets separately — the published grain is subsystem, technology and hour — so these are two measurements and the total is their sum. The forecast version of this panel is the opposite: one modelled expectation, divided in two.",
      emptyDay:
        "The day settled with no curtailment at all in this subsystem, which is a measurement and not a missing figure.",
      nationalTitle: "The last 24 hours, across all four subsystems",
      nationalSubtitle: "A sum of four measurements, and it is exact",
      nationalLabel: "Settled constrained-off energy, all four subsystems",
      nationalNote:
        "This figure is the four subsystem rows of the same window, added — the gateway says so in a field of its own, `derived: sum_of_four`. It is not the ONS `SIN` line, which WattSteer never uses because it would double-count what the four rows already carry. Measurements add exactly; no forecast quantile does.",
    },

    overview: {
      /**
        Question 5 of the operator brief, answered with what is true.

        The brief asks for a "likely cause". There is no such model — the
        forecaster has one head per subsystem and produces a quantity, not a
        reason. REL/CNF/ENE are ONS's record of days that have happened, so the
        sentence carries the date and never sits unlabelled beside a forecast.
      */
      causeEvidence: "Rule: {document} {revision}, p. {page}",
      causeEvidenceNoPage: "Rule: {document} {revision}",
      causeLabel: "Dominant reason",
      causeSentence: "{reason} accounted for {share} of the energy curtailed on {date}.",
      causeNote:
        "A reason ONS settled for a past day, at the grain it publishes — conjunto and subsystem. Not a forecast of cause: WattSteer forecasts how much will be curtailed, not why.",
      /** Question 4 of the operator brief: "when?" — said, not drawn. */
      windowLabel: "Critical window",
      windowRange: "{from}h–{to}h BRT",
      windowPeak: "Peak at {peak}h · {mwh} MWh",
      windowScattered:
        "{hours} hours of the day expect curtailment; this is the longest run.",
      windowNone: "No hour of the day is more likely to curtail than not.",
      metaTitle: "Grid Overview — WattSteer",
      title: "Grid Overview",
      lede: "Day-ahead curtailment risk for {date}, by subsystem. Every figure is a P10/P50/P90 interval, not a point.",
      /*
        The row *selects*; it no longer navigates. The label said "open Explain"
        because pressing it did, which is the defect this screen carried: one
        gesture, two plausible meanings, and it silently did the one that takes
        the reader off the screen.
      */
      ledeObserved:
        "What the grid has already settled, by subsystem. Every figure here is measured; none is a forecast, because no model is promoted.",
      rowFigure: "{subsystem}: select",
      rowExplain: "Explain",
      rowExplainLabel: "Explain {subsystem}",
      selectedBadge: "Selected",
      selectedTitle: "Selected region",
      selectedNote:
        "The four panels below — 24-hour profile, wind and solar, day energy and peak — are all about this region. Picking another swaps all four in place, without leaving the screen.",
      selectedAbsent:
        "No forecast figures for this region today, because no model is promoted. What follows is observed and holds either way.",
      rowEnergy: "Expected curtailed energy",
      rowPeak: "peak {low}–{high} MW",
      profileSubtitle: "24-hour profile, P10–P90",
      nationalTitle: "The day, across all four subsystems",
      nationalSubtitle:
        "Expected value — the one forecast quantity that adds across subsystems",
      dailyEnergy: "Curtailed energy, whole day · {subsystem}",
      dailyEnergyNote:
        "A day total is a joint forecast read from the path ensemble. It is neither the sum of the hourly P90s nor the sum of the hourly P50s — no quantile adds, medians included.",
      peakPower: "Peak hourly power · {subsystem}",
      peakPowerNote:
        "The largest hour within a drawn day, over the same ensemble. Threshold in force: {mw} MW at subsystem grain.",
      grainNote:
        "Forecast grain is the subsystem. Observed curtailment is published per reporting entity — a conjunto for most of {subsystem} — and restriction reasons exist only there; see Explain.",
      readingTitle: "Reading the grid",
      /** Screen-reader name for the mark that a re-read is in flight. */
      refreshingLabel: "Updating the figures for the selected region",
      refusedTitle: "The gateway did not answer",
      refusedNote:
        "Every panel on this screen reads the gateway, including the ones that need no model, so there is nothing to show in the meantime. The figures are not cached in the page; a reload once the service is back is all this needs.",
      /**
       * The forecast half is absent. Two sentences and no numbers.
       *
       * The refusal code goes above this note, from the closed enum and in the
       * reader's locale, and the lane conditions go below it. This sentence is
       * the screen's own half: what it is showing instead, and why that is a
       * different kind of number.
       */
      absentTitle: "No forecast for this day",
      absentNote:
        "The risk classes, the P10–P90 bands and the forecast day totals are model output, and there is none — so they are not shown. In their place every panel answers what the settled data can answer with no model at all: megawatt-hours ONS has already published, marked as observed wherever they appear.",
      settledTitle: "Settled across the four subsystems",
      settledSubtitle: "Last 24 h to {hour} BRT · {lag} h behind",
      settledSplit: "wind {wind} MWh · solar {solar} MWh",
      settledNationalNote:
        "National total {mwh} MWh, the sum of the four. Observations add exactly, which is why this total exists here and no national forecast band does.",
      settledDayTitle: "{subsystem} — the last settled day",
      settledDaySubtitle: "Observed hourly curtailment, {date}",
      settledDayNote:
        "One bar per local hour, wind and solar added. An hour with no settled row draws no bar at all: an hour that settled at zero and an hour that has not settled are different facts.",
      settledDayEmpty: "No curtailment settled in this subsystem on this day.",
      episodesTitle: "Recent episodes",
      episodesSubtitle: "{from} to {to}, above {mw} MW",
      episodeColumns: {
        period: "Period",
        duration: "Duration",
        energy: "Energy",
        peak: "Peak",
      },
      episodeNote:
        "An episode is a run of hours above the threshold, joined across gaps of at most {gap} h. Both parameters are stamped on every episode, because they are part of what an episode is.",
      episodesEmpty: "No hour in this window went above the threshold in this subsystem.",
      map: {
        title: "The four subsystems",
        subtitle: "Same risk class as the rows below",
        /**
         * The whole map, for a reader who gets one string for the figure.
         * It says what the shape is and what the colour means, because a map
         * whose only description is "map of Brazil" has told a screen-reader
         * user nothing the rows below do not already say better.
         */
        figure:
          "Map of Brazil divided into the four ONS subsystems, each shaded by its curtailment risk class. The four regions are also listed as rows below.",
        /** One region. `{risk}` is the binned class, never a bare number. */
        region: "{subsystem}: {risk} risk, about {probability}. Select.",
        /** Arrow keys move the selection, so the map has to say so. */
        keyboardNote:
          "Arrow keys move across the four regions and change the selection; Enter selects the focused region.",
        /**
         * Maranhão is in the Norte subsystem and in the Nordeste geographic
         * region, and a reader who knows the map but not the grid will read
         * the north-east corner as an error. The note is on the figure rather
         * than in a tooltip because it is the answer to a question the map
         * itself provokes.
         */
        boundaryNote:
          "Electrical boundaries, not geographic regions: Maranhão is in the Norte subsystem, Acre and Rondônia are in Sudeste/Centro-Oeste, and so are Mato Grosso, Mato Grosso do Sul, Goiás and the Distrito Federal.",
        /**
         * Attribution, shown under the figure rather than buried in a source
         * comment. IBGE publishes this mesh as open government data under the
         * Lei de Acesso à Informação, which asks for the credit and not for a
         * licence notice — so the line names the publisher and the year of the
         * mesh, which is also what makes the map checkable against a newer one.
         */
        /** The observed map's own four strings. See `app.observed`. */
        titleObserved: "The four subsystems",
        subtitleObserved: "Settled curtailed energy, last 24 h",
        figureObserved:
          "Map of Brazil divided into the four ONS subsystems, each shaded by the curtailed energy ONS has already settled for it over the last 24 hours, and with that figure printed on the region. The four regions are also listed as rows beside it.",
        regionObserved: "{subsystem}: {mwh} MWh settled in the last 24 hours. Select.",
        legendLow: "Less",
        source: "Boundaries: IBGE, Malhas Territoriais (open government data).",
      },
    },

    split: {
      title: "Wind and solar",
      /** Named. A panel that does not say whose numbers it holds cannot show
          a reader that the numbers changed under it. */
      subtitle: "{subsystem} · two scalars, no band",
      expected: "Expected curtailed energy, whole day",
      expectedNote:
        "E[Y], published beside the band rather than inside it. It is not the middle of the interval: with mass sitting on “no curtailment at all”, the expectation runs above the median, and on a quiet day the median is flatly zero while the expectation is not.",
      note: "The forecaster has one head per subsystem, so wind and solar are a division of that expectation and nothing more. There is no wind band and no solar band to draw, which is why picking a technology above emphasises one of these two numbers instead of filtering the forecast.",
      // "shown" made the badge read "Wind · shown", which says the other number
      // is not — a filter, which is precisely the misreading `note` above
      // exists to prevent, and it said it two lines above a sentence promising
      // the opposite. pt has always said "em destaque"; this was the one place
      // the two dictionaries made different claims about the product. The word
      // is now the note's own verb, so the badge and the paragraph agree.
      emphasised: "emphasised",
    },

    explain: {
      metaTitle: "Explain — WattSteer",
      title: "Why {subsystem}?",
      lede: "What the model is reading on {date}, and how much of it to believe.",
      /*
        The lede when there is no diagnosis, for the reason
        `overview.ledeObserved` gives about its own pair: the lede above
        promises "what the model is reading", which is flatly false on a
        deployment where nothing is promoted — and it is the first line a reader
        meets, so it is the first thing that has to be right.

        The body already says this in `absentNote`, three panels down. Saying it
        in the lede is not a repetition: it is the difference between a reader
        learning it before they start reading and learning it after.
      */
      ledeAbsent:
        "What ONS recorded for {date}. No model is promoted, so there is no diagnosis — only what was observed.",
      riskTitle: "Curtailment risk",
      riskSubtitle: "P(any hour above threshold)",
      magnitude: "Expected magnitude, whole day",
      magnitudeNote: "Conditional on the day clearing the threshold at all.",
      peakPower: "Peak hourly power",
      readingTitle: "Reading the diagnosis",
      refusedTitle: "The gateway did not answer",
      refusedNote:
        "Not even the observed restriction reasons, which need no model. There is nothing on this screen that does not come from the gateway.",
      absentTitle: "Nothing to explain for this day",
      absentNote:
        "The risk, the two bands, the driver attribution and the narration are all model output, and there is none — a diagnosis explains a forecast, and no forecast was published. The observed restriction reasons below are unaffected: they are what ONS recorded about a day that happened.",
      reliabilityAbsentNote:
        "A reliability curve is a property of a promoted model, so there is none to draw. The card of an artifact the gate refused is not shown in its place: a calibration curve here is the claim “this is how well the model you are reading is calibrated”, and there is no model anyone is reading.",
      reasonsEmpty: "ONS recorded no restriction for this subsystem on this day.",
      causeMixed:
        "The recorded reason changed part-way through the day; only one is stored, which is a simplification and not an observation.",
      narrationTitle: "Narration",
      narrationSubtitle: "Generated in the requested locale",
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
      /**
        The band's measured coverage — the figure the gate computes at every
        gate and that no screen was showing.

        Never from `claim_note`: the contract says that is auditor prose in the
        same status as an error `message` and never reaches a reader. These
        sentences are assembled from the numbers, and the withheld one exists
        because the type warns that a client rendering a coverage claim without
        reading `nominal_claim` has a bug.
      */
      coverageTitle: "Did the band cover what it promises?",
      coverageClaim:
        "Over the {rows} curtailed hours of fold {fold}, the lower edge covered {p10} and the upper {p90}, against a target of {target}.",
      coverageWithheld:
        "This band may not be described as a {target} band over this fold's curtailed hours. The numbers are above; the claim is withheld.",
      coverageNote:
        "Measured over a whole fold, not over a day. A day lands inside its band or outside it; the fraction of days that land inside is what this figure is — and it is what the Time Machine names when it refuses to grade a single day.",
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
      /* The lede when no plan was drawn. See `overview.ledeObserved`. */
      ledeAbsent:
        "{subsystem}, {date}. No plan is drawn — sizing flexibility needs a day-ahead forecast, and there is none.",
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
      solvingLive:
        "This screen reads a live API and cannot be prerendered. POST /v1/optimize builds and solves the MILP, which does not run in a browser — so a static export ships this note and no plan, and stays on it. To size a fleet, point the build at a running gateway with EXPO_PUBLIC_API_URL, or start one locally with bun run api and reload. Grid Overview and Explain need neither.",
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
      // --- forecast accuracy: item 3 of the Time Machine brief ---
      accuracyTitle: "Did the forecast hold?",
      accuracySubtitle: "What the system said the day before, against what ONS settled",
      accuracyForecast: "Forecast (P50)",
      accuracySettled: "Settled",
      accuracyError: "Error",
      accuracyPlacement: {
        inside:
          "The day settled inside the P10–P90 band ({p10}–{p90} MWh), which is where the forecast said it would land.",
        above:
          "The day settled above P90 ({p90} MWh): it curtailed more than the band allowed for.",
        below:
          "The day settled below P10 ({p10} MWh): it curtailed less than the band allowed for.",
      },
      accuracyNote:
        "A P10–P90 band is meant to be exceeded on about one day in five — a band that is never exceeded is too wide to act on. So this screen says where the day fell and does not grade it. The fraction of days that land inside is a property of many days rather than one: it is the gate's `coverage_p10_in_band` rail, measured over a whole fold.",
      metaTitle: "Time Machine — WattSteer",
      title: "What if WattSteer had been running?",
      lede: "A past day, replayed against the forecast vintage available at D−1 and scored against what ONS settled.",
      /* The lede when nothing was replayed. See `overview.ledeObserved`. */
      ledeAbsent:
        "A past day, and what ONS settled about it. There is nothing replayed to score beside it.",
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
      episodesSubtitle:
        "A read-time view of the day, above {mw} MW — carrying its own parameters",
      episodeColumns: {
        period: "Period",
        duration: "Duration",
        energy: "Energy",
        peak: "Peak",
      },
      episodesEmpty: "No hour of this day went above the threshold in this subsystem.",
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
