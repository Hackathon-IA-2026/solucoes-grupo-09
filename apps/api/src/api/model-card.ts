import type {
  BandCalibration,
  CardWindow,
  Coverage,
  EnsembleSummary,
  GateDecision,
  MetricsRow,
  ModelCard,
  Reliability,
  ReliabilityPoint,
} from "@wattsteer/core/api";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import { UpstreamError } from "../errors.js";
import { callMl, type MlEndpoint } from "./ml-proxy.js";
import { laneName } from "./params.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/**
 * `GET /v1/model/card` — the Explain screen's second call, and the reason it is
 * a second call at all.
 *
 * `docs/specs/api-surface.md` §9: the reliability curve is "a property of
 * the *model*, not of a day". Folding it into `/v1/diagnosis/day-ahead` gives
 * a weekly-changing object a daily cache key and put the same tens of kilobytes
 * on the wire on every Explain view. So it is its own route, its own ETag and
 * its own hour-long freshness — and its cache identity is the artifact's, which
 * means the response changes when and only when a promotion happens.
 *
 * ### Why this one crosses to the modelling service
 *
 * For the reason `/v1/replay/days` does and `/v1/forecast/day-ahead` does not:
 * **the card is a file on the modelling service's volume**, and the gateway has
 * no volume. The alternative — mirroring the card into Postgres at publication
 * time — would make a second copy of a document whose whole purpose is to be
 * the one auditable record of an artifact, and the two copies would be free to
 * disagree about a model that only one of them was written beside.
 *
 * The failure this arrangement accepts is bounded and is the right one: with the
 * modelling service down, Explain loses its **curve**, not its attribution — the
 * diagnosis is a Postgres read and is unaffected. That is precisely the split
 * the two-endpoint decision buys.
 *
 * ### What the gateway shapes, and what it refuses to
 *
 * The card is large — a feature contract with every name and dtype, ninety-six
 * fitted sub-threshold means, the environment's package versions — and almost
 * none of that renders. This route returns the **product-facing subset** and
 * `card_url` pointing at the raw document for anyone auditing.
 *
 * Every field forwarded from the card keeps **the card's own spelling**.
 * `pit_dropped_days` is `pit_dropped_days` here; `upper_correction_realised` is
 * `upper_correction_realised`. The forecaster owns the card's vocabulary, this
 * ticket exposes a subset of it, and a rename on the way out is where two
 * vocabularies start — the same argument `meta.ts` makes about the lane states.
 * The only names this module mints are the grouping keys, and one derived
 * field, below.
 *
 * ### The one thing this module derives, and why it may refuse instead
 *
 * `correction_applied`. The card measures the correction; it does not name the
 * rule that applied it, and the rule is what makes a number readable.
 * `correction_regime = conformal_v1_partial_upper` says the lower correction
 * reaches the served band in full at every occurrence probability and the upper
 * one does not: `δ_hi` is added to the 0.90 knot of `Q_pos`, composition reads
 * `Q_pos` at `u = 1 − 0.1/p` which is below that knot for every `p < 1`, and at
 * `p ≤ 0.20` reaches none of it at all. So a `coverage_p90` well short of
 * nominal beside a `coverage_p10` of 1.0 is **not** the fit failing on one side;
 * it is the correction arriving in part. The pair that says so —
 * `upper_correction_realised` and the card's own note — travels inside the
 * `upper` block, where the schema makes the three fields required together,
 * because a P90 whose partial correction is invisible is worse than one that
 * says so.
 *
 * The reach is resolved from {@link CORRECTION_REACH}, a published table, and a
 * regime with no entry is a **refusal** rather than a guess. Defaulting an
 * unknown regime to `full` would publish a tail as exact on the strength of not
 * recognising its name.
 *
 * ### `pit_dropped_days` is a limitation of the band, not a training log line
 *
 * Every day-grain and national quantile is a quantile of whole-row draws of the
 * PIT matrix `U`, and `U` holds only the calibration days whose ninety-six
 * subsystem-hours are all settled. So `pit_rows` is the number of distinct days
 * the published day band is a statement about, and `pit_dropped_days` is how
 * many the all-96-cells rule cost. On the reference fixture that is 41 days
 * kept against 49 dropped, which is a fact about the published band and belongs
 * where a reader of the card can see it.
 */

/**
 * How far each tail's correction reaches the **served** band, per regime.
 *
 * A table and not a heuristic on the regime's name: `conformal_v1_partial_upper`
 * happens to say "partial upper" in its own spelling, and a future regime need
 * not. An unrecognised regime is refused by {@link reachOf} rather than parsed.
 */
export const CORRECTION_REACH: Record<
  string,
  { lower: "full" | "partial"; upper: "full" | "partial" }
> = {
  // Forecaster ticket 06's split-conformal correction. The lower tail is exact
  // at every `p`; the upper reaches the composed P90 only in the proportion
  // `upper_correction_fraction(p)` states, and none of it at `p ≤ 0.20`.
  conformal_v1_partial_upper: { lower: "full", upper: "partial" },
};

function reachOf(regime: string): {
  lower: "full" | "partial";
  upper: "full" | "partial";
} {
  const reach = CORRECTION_REACH[regime];
  if (reach === undefined) {
    // Loud, and on purpose. The alternative is publishing a coverage number
    // beside a claim about how much correction produced it that nobody checked.
    throw new UpstreamError(
      `The modelling service reported an unknown correction regime "${regime}", ` +
        "so how far each tail's correction reaches the served band is unknown",
      { code: "UPSTREAM_FAILED", details: { correction_regime: regime } },
    );
  }
  return reach;
}

/** The two `VintageFidelity` values, and there is no third to average into. */
const VINTAGE_FIDELITIES = ["point_in_time", "revision_optimistic"] as const;

/** The two gates. A lane names one; nothing here defaults to the other. */
const GATE_PROFILES = ["gate_early", "gate_late"] as const;

/** The modelling service's reply, read tolerantly and then read strictly. */
interface CardEnvelope {
  lane: string;
  artifact_id: string;
  correction_regime: string;
  card: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A card group, or the refusal that says the document is not one. */
function group(card: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = card[key];
  if (!isRecord(value)) {
    throw new UpstreamError(
      `The model card has no ${key} group; a card missing one of its groups is ` +
        "not a partially valid card",
      { code: "UPSTREAM_FAILED", details: { group: key } },
    );
  }
  return value;
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UpstreamError(`The model card's ${key} is not a number`, {
      code: "UPSTREAM_FAILED",
      details: { field: key },
    });
  }
  return value;
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw new UpstreamError(`The model card's ${key} is not a string`, {
      code: "UPSTREAM_FAILED",
      details: { field: key },
    });
  }
  return value;
}

/** `string | null`, where the null is a fact and a missing key is not. */
function nullableStr(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One of a closed set, or a refusal — never the nearest member.
 *
 * The reason this is a function and not a ternary: a ternary has a fallback
 * arm, and every fallback arm here would be a *label applied to a value nobody
 * recognised*. A card claiming a third vintage fidelity rounded down to
 * `revision_optimistic` is a metric filed under a caveat it was never measured
 * with, and `apps/api/test/contract.test.ts` fails any file that writes that
 * ternary — correctly, because it is the vintage rule's shape wearing a cast.
 */
function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = str(source, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UpstreamError(
      `The model card's ${key} is "${value}", which is not one of ` +
        `${allowed.join(", ")}`,
      { code: "UPSTREAM_FAILED", details: { field: key, value } },
    );
  }
  return value as T;
}

function window(source: Record<string, unknown>, key: string): CardWindow {
  const value = source[key];
  if (!isRecord(value)) {
    throw new UpstreamError(`The model card's ${key} is not a window`, {
      code: "UPSTREAM_FAILED",
      details: { field: key },
    });
  }
  return { start: str(value, "start"), end: str(value, "end") };
}

function toReliability(calibration: Record<string, unknown>): Reliability {
  const raw = calibration.reliability;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UpstreamError("The model card carries no reliability curve", {
      code: "UPSTREAM_FAILED",
      details: { field: "reliability" },
    });
  }
  const points: ReliabilityPoint[] = raw.map((entry) => {
    const point = isRecord(entry) ? entry : {};
    return {
      binLower: num(point, "bin_lower"),
      binUpper: num(point, "bin_upper"),
      binCentre: num(point, "bin_centre"),
      meanPredicted: num(point, "mean_predicted"),
      observedFrequency: num(point, "observed_frequency"),
      hourCount: num(point, "hour_count"),
      // The merges themselves are on the raw card. What renders is *that* a bin
      // is wide because it was merged, which is this flag: without it a merged
      // bin looks like an oddly shaped chart rather than a stated decision.
      merged: point.merged === true,
    };
  });
  // The fidelity is one value or the pool is refused upstream; a third value
  // reaching here is a contract violation and must not be rounded to one of the
  // two, because nothing on this surface averages across them.
  const fidelity = oneOf(calibration, "reliability_fidelity", VINTAGE_FIDELITIES);
  const folds = calibration.reliability_folds;
  return {
    points,
    sampleHours: num(calibration, "reliability_sample_hours"),
    window: window(calibration, "reliability_window"),
    vintageFidelity: fidelity,
    folds: Array.isArray(folds) ? folds.filter((one) => typeof one === "string") : [],
    excludedCalibrationHours: num(calibration, "reliability_excluded_calibration_hours"),
    ece: num(calibration, "ece"),
    mce: num(calibration, "mce"),
    topBinGap: num(calibration, "top_bin_gap"),
  };
}

/**
 * The coverage block, split by tail.
 *
 * Two objects rather than two numbers side by side. `coverage_p10` and
 * `coverage_p90` have different statuses and a reader who does not know that
 * draws the wrong conclusion from the gap between them; separating them puts
 * the reason inside the same object as the number.
 */
function toCoverage(quantiles: Record<string, unknown>, regime: string): Coverage | null {
  if (quantiles.coverage === null || quantiles.coverage_p10 === undefined) {
    return null;
  }
  const reach = reachOf(regime);
  const guardrail = quantiles.coverage_guardrail;
  return {
    foldId: str(quantiles, "coverage_fold"),
    population: "curtailed_hours",
    rows: num(quantiles, "coverage_rows"),
    target: num(quantiles, "coverage_target"),
    guardrail: Array.isArray(guardrail)
      ? guardrail.filter((one): one is number => typeof one === "number")
      : [],
    guardrailSatisfied: quantiles.coverage_guardrail_satisfied === true,
    lower: {
      coverageP10: num(quantiles, "coverage_p10"),
      correctionApplied: reach.lower,
      // The one product figure that rests on this tail, named on the response
      // rather than left to prose: `recovered_floor_mwh` is simulated against
      // P10, so "the floor we quote" and "the tail with no caveat" are the same
      // statement and a reader should not have to know that separately.
      quotedAs: "recovered_floor_mwh",
    },
    upper: {
      coverageP90: num(quantiles, "coverage_p90"),
      correctionApplied: reach.upper,
      upperCorrectionRealised: num(quantiles, "upper_correction_realised"),
      upperCorrectionNote: str(quantiles, "upper_correction_note"),
    },
    p50Unbiasedness: num(quantiles, "p50_unbiasedness"),
    crossingRate: num(quantiles, "crossing_rate"),
  };
}

function toBand(quantiles: Record<string, unknown>, regime: string): BandCalibration {
  const coverage = toCoverage(quantiles, regime);
  return {
    correctionRegime: regime,
    deltaLo: num(quantiles, "delta_lo"),
    deltaHi: num(quantiles, "delta_hi"),
    method: str(quantiles, "conformal_method"),
    miscoverage: num(quantiles, "conformal_miscoverage"),
    targetCoverage: num(quantiles, "conformal_target_coverage"),
    calibrationRows: num(quantiles, "conformal_calibration_rows"),
    rank: num(quantiles, "conformal_rank"),
    window: window(quantiles, "conformal_window"),
    guarantee: str(quantiles, "conformal_guarantee"),
    coverage,
    coverageAbsentReason:
      coverage === null
        ? (nullableStr(quantiles, "coverage_absent_reason") ??
          "this fold's test period held no curtailed hour")
        : null,
  };
}

function toEnsemble(ensemble: Record<string, unknown>): EnsembleSummary {
  const dayGrain =
    ensemble.day_total_coverage === undefined || ensemble.day_total_coverage === null
      ? null
      : {
          foldId: str(ensemble, "day_grain_fold"),
          days: num(ensemble, "day_grain_days"),
          dayTotalCoverage: num(ensemble, "day_total_coverage"),
          peakCoverage: num(ensemble, "peak_coverage"),
          target: num(ensemble, "day_grain_coverage_target"),
          population: "complete_settled_days" as const,
        };
  return {
    ensembleDraws: num(ensemble, "ensemble_draws"),
    pitRows: num(ensemble, "pit_rows"),
    pitDroppedDays: num(ensemble, "pit_dropped_days"),
    pitColumns: num(ensemble, "pit_columns"),
    pitWindow: window(ensemble, "pit_window"),
    pitDroppedDaysRule: str(ensemble, "pit_dropped_days_rule"),
    pitMaxKs: num(ensemble, "pit_max_ks"),
    pitKsTolerance: num(ensemble, "pit_ks_tolerance"),
    pitUniformWithinTolerance: ensemble.pit_uniform_within_tolerance === true,
    dayGrain,
    dayGrainAbsentReason:
      dayGrain === null
        ? (nullableStr(ensemble, "day_grain_absent_reason") ??
          "this fold's test period held no day whose twenty-four hours are all settled")
        : null,
  };
}

/**
 * The Metrics group, if the card has one.
 *
 * It does not yet: `ModelCard.to_dict` writes Identity, Lane, Contract, Data,
 * Calibration, Quantiles and Ensemble, and the Metrics group is forecaster
 * ticket 09's. Absent is therefore the honest answer today, and it is `null`
 * with a stated reason rather than `[]` — an empty table reads as "measured as
 * nothing", which is the opposite of "not measured yet".
 */
function toMetrics(card: Record<string, unknown>): MetricsRow[] | null {
  const raw = card.metrics;
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.filter(isRecord).map((row) => {
    return {
      run: str(row, "run"),
      rung: str(row, "rung"),
      rungNumber: num(row, "rung_number"),
      foldId: str(row, "fold_id"),
      // A group key and never a filter: the point of carrying it per row is
      // that nothing averages two folds of different fidelity together.
      vintageFidelity: oneOf(row, "vintage_fidelity", VINTAGE_FIDELITIES),
      rows: num(row, "rows"),
      prevalence: num(row, "prevalence"),
      prAuc: num(row, "pr_auc"),
      brier: num(row, "brier"),
      ece: num(row, "ece"),
      mce: num(row, "mce"),
      topBinGap: num(row, "top_bin_gap"),
      maePositivesMwh:
        typeof row.mae_positives_mwh === "number" ? row.mae_positives_mwh : null,
      pinball10: typeof row.pinball_10 === "number" ? row.pinball_10 : null,
      pinball50: typeof row.pinball_50 === "number" ? row.pinball_50 : null,
      pinball90: typeof row.pinball_90 === "number" ? row.pinball_90 : null,
    };
  });
}

/** The hot-swap gate's Decision group, when a gate has run over this card. */
function toDecision(card: Record<string, unknown>): GateDecision | null {
  const raw = card.gate;
  if (!isRecord(raw)) {
    return null;
  }
  const decision = raw.decision;
  if (decision !== "promote" && decision !== "refuse") {
    return null;
  }
  return {
    decision,
    reason: str(raw, "reason"),
    at: str(raw, "at"),
    bootstrapP: typeof raw.bootstrap_p === "number" ? raw.bootstrap_p : null,
    comparedAgainst: nullableStr(raw, "compared_against"),
  };
}

/**
 * The whole body, built field by field against the generated interface.
 *
 * Field by field for the reason `grid.ts`, `plants.ts` and `meta.ts` are: the
 * schema is `additionalProperties: false`, so a key the payload has no business
 * carrying — a feature name list, ninety-six fitted means, a package version —
 * is a contract violation found by a compiler here rather than by a validator
 * in production. Which is exactly what "the product-facing subset" has to mean
 * if it is to mean anything.
 */
export function toModelCard(envelope: CardEnvelope): ModelCard {
  const card = envelope.card;
  const identity = group(card, "identity");
  const lane = group(card, "lane");
  const contract = group(card, "contract");
  const fold = group(card, "fold");
  const data = group(card, "data");
  const calibration = group(card, "calibration");
  const quantiles = group(card, "quantiles");
  const ensemble = group(card, "ensemble");

  const riskBins = calibration.risk_bins;
  if (!isRecord(riskBins)) {
    throw new UpstreamError("The model card carries no risk bins", {
      code: "UPSTREAM_FAILED",
      details: { field: "risk_bins" },
    });
  }
  const edges = (key: string): [number, number] => {
    const value = riskBins[key];
    if (!Array.isArray(value) || value.length !== 2) {
      throw new UpstreamError(`The model card's ${key} risk bin is not two edges`, {
        code: "UPSTREAM_FAILED",
        details: { field: `risk_bins.${key}` },
      });
    }
    return [Number(value[0]), Number(value[1])];
  };

  const fidelityCounts = data.vintage_fidelity;
  const metrics = toMetrics(card);

  return {
    lane: envelope.lane,
    // A card is only served for a promoted artifact. The other three lane
    // states never reach this shape — they are a `MODEL_UNAVAILABLE` carrying
    // `details.lane_state`, so the field is a constant here rather than a
    // discriminator a client has to branch on.
    laneState: "promoted",
    artifact: {
      artifactId: envelope.artifact_id,
      createdAt: str(identity, "created_at"),
      estimatorFamily: str(identity, "estimator_family"),
      modelConfigVersion: str(identity, "model_config_version"),
      featureSet: str(lane, "feature_set"),
      featureSetVersion: nullableStr(lane, "feature_set_version"),
      gateProfile: oneOf(lane, "gate_profile", GATE_PROFILES),
      thresholdMw: num(lane, "threshold_mw"),
      // The hash and not the feature list: a client that needs the names is
      // auditing, and the raw card is where auditing happens.
      featureHash: str(contract, "feature_hash"),
      gitShaMl: nullableStr(identity, "git_sha_ml"),
      gitShaApi: nullableStr(identity, "git_sha_api"),
    },
    fold: {
      foldId: str(fold, "fold_id"),
      foldHash: str(fold, "fold_hash"),
      rulesDigest: str(fold, "rules_digest"),
    },
    windows: {
      training: window(data, "training_window"),
      baseFit: window(data, "base_fit_window"),
      calibration: window(data, "calibration_window"),
      test: window(data, "test_window"),
      // Counted per fidelity and never averaged across it (vocabulary rule 9).
      // Forwarded as the map the card holds, so a fold spanning ingestion
      // go-live arrives as two numbers rather than one that describes no fold.
      rowsByVintageFidelity: isRecord(fidelityCounts)
        ? Object.fromEntries(
            Object.entries(fidelityCounts).filter(
              ([, value]) => typeof value === "number",
            ) as [string, number][],
          )
        : {},
    },
    reliability: toReliability(calibration),
    riskBins: {
      low: edges("low"),
      elevated: edges("elevated"),
      high: edges("high"),
    },
    band: toBand(quantiles, envelope.correction_regime),
    ensemble: toEnsemble(ensemble),
    metrics,
    metricsAbsentReason:
      metrics === null
        ? "the artifact card carries no metrics group; the headline metrics " +
          "table and the baseline-ladder deltas are written by the forecaster " +
          "and this card predates them"
        : null,
    decision: toDecision(card),
    cardUrl: `/v1/model/card/raw?lane=${encodeURIComponent(envelope.lane)}`,
  };
}

/**
 * Fetch one lane's card, or throw the failure `ml-proxy.ts` decided it was.
 *
 * Nothing is mapped here. `callMl` raises through the one shared mapping, which
 * admits `MODEL_UNAVAILABLE` into the closed enum at the 503 the modelling
 * service chose and — since this ticket — carries that refusal's `details`
 * with it. That is what puts `lane_state` in front of a screen, and it had to
 * be fixed in the mapping rather than worked around here: a route that reached
 * past `mapUpstreamFailure` for a body it had already consumed would be a
 * second failure mapping, which is the one thing the module exists to prevent.
 */
async function fetchCard(lane: string, endpoint?: MlEndpoint): Promise<CardEnvelope> {
  const response = await callMl(
    "/v1/model/card",
    new URLSearchParams({ lane }),
    ...(endpoint === undefined ? [] : [endpoint]),
  );
  const body = await response.json().catch(() => null);
  if (!(isRecord(body) && isRecord(body.card))) {
    throw new UpstreamError("The modelling service returned an unreadable model card", {
      code: "UPSTREAM_FAILED",
    });
  }
  return {
    lane: typeof body.lane === "string" ? body.lane : lane,
    artifact_id: str(body, "artifact_id"),
    correction_regime: str(body, "correction_regime"),
    card: body.card,
  };
}

const LANE_DESCRIPTION =
  "The artifact lane, e.g. dessem_free_v1__gate_late__thr5. Required and never " +
  "defaulted: a card is a property of one lane's promoted artifact, and a " +
  "default would answer a question about a model the caller did not ask about.";

export function createModelCardRoutes(endpoint?: MlEndpoint) {
  return new Elysia({ name: "model-card" })
    .get(
      "/v1/model/card",
      async ({ query, request, set }) => {
        const envelope = await fetchCard(laneName("lane", query.lane), endpoint);
        // The artifact id and nothing else. `api-surface.md`'s caching table:
        // this response "changes only on promotion", so its cache identity *is*
        // the artifact — there is no clock in this key and no invalidation call
        // to forget, because a promotion mints a new id by construction.
        if (
          applyCachePolicy({ set, request }, CACHE_POLICIES.modelCard, [
            envelope.artifact_id,
          ])
        ) {
          return null;
        }
        return encodeWire("ModelCard", toModelCard(envelope));
      },
      {
        query: t.Object({ lane: t.String({ description: LANE_DESCRIPTION }) }),
        detail: {
          summary: "The model's reliability curve and headline numbers",
          description:
            "Model metadata and never a day's answer: the calibration curve " +
            "with its sample counts, window and vintage fidelity, the " +
            "calibration error metrics and the signed top-bin gap, the risk " +
            "bins, the band's conformal deltas with coverage **split by tail**, " +
            "and what the day-grain ensemble rests on. `band.coverage.upper` " +
            "carries `upper_correction_realised` beside `coverage_p90` because " +
            "the two are only readable together. Cached for an hour against an " +
            "ETag that is the artifact id, so the response changes exactly when " +
            "a promotion happens. 503 MODEL_UNAVAILABLE with `details.lane_state` " +
            "when the lane has nothing promoted.",
        },
      },
    )
    .get(
      "/v1/model/card/raw",
      async ({ query, request, set }) => {
        const envelope = await fetchCard(laneName("lane", query.lane), endpoint);
        // The same provenance with the representation on it: the raw card and
        // the shaped one are two encodings of one artifact, and a shared cache
        // holding both under one validator would serve either for the other.
        if (
          applyCachePolicy({ set, request }, CACHE_POLICIES.modelCard, [
            envelope.artifact_id,
            "raw",
          ])
        ) {
          return null;
        }
        // Verbatim, and deliberately not through `encodeWire`. The card is the
        // forecaster's audit document, already `snake_case`, and re-encoding it
        // would make this a second translator of a shape `packages/core` does
        // not type — and an auditor comparing this against the file on the
        // volume must be comparing the file on the volume.
        return envelope.card;
      },
      {
        query: t.Object({ lane: t.String({ description: LANE_DESCRIPTION }) }),
        detail: {
          summary: "The raw artifact card, for auditing",
          description:
            "The `*.card.json` written beside the bundle, byte-for-byte in " +
            "content: the full feature contract, the ninety-six fitted " +
            "sub-threshold means, the conditional coverage tables, the model " +
            "configuration and the environment's package versions. Large, " +
            "unshaped and not what a screen reads — `GET /v1/model/card` is.",
        },
      },
    );
}

/** The gateway's instance, mounted in `index.ts`. */
export const modelCardRoutes = createModelCardRoutes();
