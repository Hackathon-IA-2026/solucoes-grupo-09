import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DECLINED_FIGURES, MODEL_CARD_DECLINES } from "@wattsteer/core/declines";
import { validate } from "@wattsteer/core/schema";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { createModelCardRoutes, toModelCard } from "../src/api/model-card.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * `/v1/model/card` — the Explain screen's second call.
 *
 * The card itself is the forecaster's, and `apps/ml/tests/test_model_card_route.py`
 * asserts the half that lives on the volume: which artifact's card comes back,
 * and that a lane with nothing promoted refuses with its state. What is
 * asserted here is the half the gateway owns and the modelling service cannot —
 * the product-facing subset, the cache identity, the error envelope, and the
 * two honesty surfaces this ticket exists to keep on the wire.
 *
 * The fixture is a **real card**, written by `train_fold` and copied out of the
 * ML test suite rather than typed here. That matters for two of the assertions
 * below: `pit_dropped_days = 49` against `pit_rows = 41`, and a `coverage_p90`
 * of 0.60 beside a `coverage_p10` of 1.0 with `upper_correction_realised` at
 * 0.65 — those numbers are what the model actually produced, and a hand-written
 * fixture would have made them whatever this test wanted them to be.
 *
 * The card was regenerated under `conformal_v2_full_upper` (forecaster ticket
 * 21). On the same fold and the same fit — `delta_lo` and `delta_hi` are
 * unchanged to the bit — `upper_correction_realised` went 0.23 → 0.65 and
 * `coverage_p90` 0.51 → 0.60. What remains of the gap to 1.0 is structural and
 * not correctable: 35% of the fold's curtailed hours have `p <= 0.10`, where
 * `Q_Y(0.90)` is the mixture's point mass at zero.
 *
 * The modelling service is stood up for real on a loopback port, as
 * `replay-days.test.ts` and `ml-proxy.test.ts` do it: the thing under test is
 * partly a proxy, and a stubbed `fetch` would be testing the stub.
 */

const CARD = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "model", "card.json"), "utf8"),
) as Record<string, unknown>;

const LANE = "dessem_free_v1__gate_late__thr5";
const ARTIFACT = "2026-08-29T04:00:00Z";
const REGIME = "conformal_v2_full_upper";

/**
 * The regime this fixture's card was *not* produced under. Rows and cards
 * written before forecaster ticket 21 are still readable and still say
 * something true about the hours they were served for, so the table has an
 * entry for it and this file has a test that reads one.
 */
const RETIRED_REGIME = "conformal_v1_partial_upper";

const envelope = (body: unknown = CARD, regime = REGIME) => ({
  lane: LANE,
  artifact_id: ARTIFACT,
  correction_regime: regime,
  card: body,
});

let reply: () => Response = () => Response.json(envelope());
const upstream: Server = Bun.serve({ port: 0, fetch: () => reply() });
afterAll(() => upstream.stop(true));

const endpoint = { baseUrl: `http://127.0.0.1:${upstream.port}`, timeoutMs: 2000 };
const app = new Elysia().use(errorHandler).use(createModelCardRoutes(endpoint));

const get = (path: string, headers?: Record<string, string>): Promise<Response> =>
  app.handle(new Request(`http://local${path}`, { headers }));

const card = (query = `?lane=${LANE}`) => get(`/v1/model/card${query}`);

/**
 * The wire body, in the casing a client actually receives — `snake_case`, per
 * `api-surface.md`: the gateway emits the wire and the generated client is the
 * only thing that renames.
 */
// biome-ignore lint/suspicious/noExplicitAny: a wire body is untyped JSON by construction, and this file exists to assert its shape rather than to assume one.
type Wire = Record<string, any>;
const wire = async (response: Response): Promise<Wire> => (await response.json()) as Wire;

const refuses = (status: number, code: string, details?: unknown) => {
  reply = () => Response.json({ error: { code, message: code, details } }, { status });
};

const serves = (body: unknown = envelope()) => {
  reply = () => Response.json(body);
};

describe("model card · the subset, and what it leaves behind", () => {
  it("validates against the schema, which is the contract", async () => {
    serves();
    const body = await wire(await card());
    const result = validate("model-card.schema.json", body);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("carries the curve, its sample counts, its window and its fidelity", async () => {
    serves();
    const { reliability } = await wire(await card());
    expect(reliability.points.length).toBeGreaterThan(0);
    expect(reliability.sample_hours).toBe(
      reliability.points.reduce((n: number, p: Wire) => n + p.hour_count, 0),
    );
    expect(reliability.window).toEqual({ start: "2024-07-01", end: "2024-11-30" });
    // One value, never a mix — nothing on this surface averages across fidelity.
    expect(reliability.vintage_fidelity).toBe("revision_optimistic");
    expect(reliability.folds).toEqual(["P1", "P2"]);
    // Pooled hours removed because they sat inside the isotonic map's own
    // window. Published, so "the pool had some and they went" is legible.
    expect(reliability.excluded_calibration_hours).toBe(5664);
  });

  it("keeps the top-bin gap signed, so a direction cannot be hidden", async () => {
    serves();
    const { reliability } = await wire(await card());
    expect(reliability.top_bin_gap).toBeCloseTo(-0.008_45, 5);
    // The absolute-valued siblings are separate fields and stay separate.
    expect(reliability.ece).toBeGreaterThan(0);
    expect(reliability.mce).toBeGreaterThan(reliability.ece);
  });

  it("does not put the feature list, the fitted means or the environment on the wire", async () => {
    serves();
    const body = await wire(await card());
    const flat = JSON.stringify(body);
    // The three biggest things on the card, and the reason this endpoint
    // returns a subset at all rather than the document.
    expect(flat).not.toContain("feature_names");
    expect(flat).not.toContain("featureNames");
    expect(flat).not.toContain("sub_threshold_means");
    expect(flat).not.toContain("coverage_by_local_hour");
    // What replaces the feature list: the hash that identifies the contract.
    expect(body.artifact.feature_hash).toBe(
      (CARD.contract as Wire).feature_hash as string,
    );
  });

  it("points at the raw card by URL, and serves it verbatim there", async () => {
    serves();
    const body = await wire(await card());
    expect(body.card_url).toBe(`/v1/model/card/raw?lane=${LANE}`);
    const raw = await wire(await get(body.card_url));
    // Byte-for-byte in content: an auditor comparing this against the file on
    // the volume must be comparing the file on the volume.
    expect(raw).toEqual(CARD);
  });
});

describe("model card · the correction caveat survives to the wire", () => {
  it("names the rule that produced the band", async () => {
    serves();
    const { band } = await wire(await card());
    expect(band.correction_regime).toBe(REGIME);
  });

  it("splits coverage by tail, and the upper tail carries its own caveat", async () => {
    serves();
    const { band } = await wire(await card());
    const { lower, upper } = band.coverage;

    // The lower tail: exact at every `p`, and named as the half the product's
    // quoted floor rests on.
    expect(lower.coverage_p10).toBe(1);
    expect(lower.correction_applied).toBe("full");
    expect(lower.quoted_as).toBe("recovered_floor_mwh");

    // The upper tail: now the same kind of statement as the lower one — the
    // correction reaches the composed P90 in full wherever that edge is a
    // positive number — and still *unreadable without* the fraction, which now
    // says how many scored hours had a positive P90 at all.
    expect(upper.coverage_p90).toBeCloseTo(0.5974, 4);
    expect(upper.correction_applied).toBe("full");
    expect(upper.upper_correction_realised).toBeCloseTo(0.6494, 4);
    expect(upper.upper_correction_note).toContain("point mass");
  });

  it("publishes the rows each tail's coverage is actually a statement over", async () => {
    serves();
    const { band } = await wire(await card());
    const { lower, upper } = band.coverage;

    // Forecaster ticket 24. The two coverages are counted over the *same* rows
    // — every curtailed hour of the fold — and disagree about what a zero edge
    // means: at `p <= 0.10` both served edges are 0 MWh, `y >= P10` holds for
    // free and `y <= P90` fails with certainty. So a marginal is only readable
    // beside the count of rows on which its edge was a bound at all.
    expect(lower.stated_rows).toBe(0);
    expect(upper.stated_rows).toBe(50);

    // Null and never 1.0: no row stated a floor, so the floor has no coverage.
    // This is the whole of why `coverage_p10 = 1.0` says nothing about it.
    expect(lower.coverage_p10_where_stated).toBeNull();

    // And where the upper edge *is* a bound, it covers nominally. The marginal
    // is that width times the reach, exactly, because a row whose P90 is zero
    // can never be covered.
    expect(upper.coverage_p90_where_stated).toBeCloseTo(0.92, 4);
    expect(
      upper.upper_correction_realised * (upper.coverage_p90_where_stated ?? 0),
    ).toBeCloseTo(upper.coverage_p90, 6);
  });

  it("refuses to let the band be read as a 90% statement while it is not one", async () => {
    serves();
    const { band } = await wire(await card());

    expect(band.coverage.nominal_claim).toBe(false);
    expect(band.coverage.claim_note).toContain("NOT a 90% band");
    // The named unmeasured reason travels with the refusal, so nobody reads the
    // fixture's decimal as a measurement of the Brazilian grid.
    expect(band.coverage.claim_note).toContain("has not been measured");
    expect(band.coverage.claim_note).not.toContain("no data source");
  });

  it("still reads a card written under the regime that was retired", async () => {
    // The old rows are in the database and are not re-stamped: they carry a
    // narrower statement about the hours they were served for, and this route
    // has to keep saying which one it is looking at rather than flattening the
    // two into one claim.
    serves(envelope(CARD, RETIRED_REGIME));
    const { band } = await wire(await card());
    expect(band.correction_regime).toBe(RETIRED_REGIME);
    expect(band.coverage.lower.correction_applied).toBe("full");
    expect(band.coverage.upper.correction_applied).toBe("partial");
  });

  it("reads the crossing rate the card counted over this block's rows", async () => {
    // Forecaster 29. The card spells this figure `coverage_crossing_rate`,
    // because it is counted over the fold's *curtailed* hours — the population
    // this block declares — while the metrics table's `crossing_rate` is the
    // same quantity over every settled hour and is the one the hot-swap gate
    // vetoes on. Under one name the two took turns, so the gateway reads the
    // spelling that names the population and nothing else.
    serves();
    const { band } = await wire(await card());
    const quantiles = CARD.quantiles as Wire;
    expect(quantiles.coverage_crossing_rate).toBeDefined();
    expect(quantiles.crossing_rate).toBeUndefined();
    expect(band.coverage.crossing_rate).toBe(quantiles.coverage_crossing_rate);
  });

  it("refuses a card that still publishes the crossing rate under the bare name", async () => {
    // The old spelling is not silently accepted: it carried the curtailed-subset
    // figure under the name of the settled-hour one, and reading it here would
    // put a number on the wire whose population depends on which card wrote it.
    // A refusal names the field, which is what makes the retrain legible.
    const stale = structuredClone(CARD) as Wire;
    stale.quantiles.crossing_rate = stale.quantiles.coverage_crossing_rate;
    delete stale.quantiles.coverage_crossing_rate;
    serves(envelope(stale));
    const response = await card();
    expect(response.status).toBe(502);
    const body = await wire(response);
    expect(body.error.code).toBe("UPSTREAM_FAILED");
    expect(body.error.details.field).toBe("coverage_crossing_rate");
  });

  it("cannot publish a P90 without the fraction that explains it", async () => {
    // The structural half of the claim: the schema requires all three fields of
    // the upper block together, so a client cannot be handed a bare
    // `coverage_p90` by any code path.
    serves();
    const body = await wire(await card());
    const stripped = structuredClone(body);
    delete stripped.band.coverage.upper.upper_correction_realised;
    expect(validate("model-card.schema.json", stripped).valid).toBe(false);
  });

  it("refuses rather than guessing when the regime is one it does not know", async () => {
    // Defaulting an unknown regime to `full` would publish a tail as exact on
    // the strength of not recognising its name.
    serves(envelope(CARD, "conformal_v9_unknown"));
    const response = await card();
    expect(response.status).toBe(502);
    const body = await wire(response);
    expect(body.error.code).toBe("UPSTREAM_FAILED");
    expect(body.error.details.correction_regime).toBe("conformal_v9_unknown");
  });
});

describe("model card · what the published band actually rests on", () => {
  it("carries the PIT drop count beside the days that were kept", async () => {
    serves();
    const { ensemble } = await wire(await card());
    // 41 distinct calibration days survive the all-96-cells rule; 49 do not.
    // Every day-grain and national quantile is a quantile of draws of those 41.
    expect(ensemble.pit_rows).toBe(41);
    expect(ensemble.pit_dropped_days).toBe(49);
    expect(ensemble.pit_columns).toBe(96);
    expect(ensemble.ensemble_draws).toBe(500);
    expect(ensemble.pit_dropped_days_rule).toContain("dropped whole");
  });

  it("reports the day-grain coverage as absent with a reason, never as zeros", async () => {
    const withoutDayGrain = structuredClone(CARD) as Wire;
    for (const key of [
      "day_grain_fold",
      "day_grain_days",
      "day_total_coverage",
      "peak_coverage",
    ]) {
      delete withoutDayGrain.ensemble[key];
    }
    withoutDayGrain.ensemble.day_grain_absent_reason = "no complete settled day";
    serves(envelope(withoutDayGrain));
    const { ensemble } = await wire(await card());
    expect(ensemble.day_grain).toBeNull();
    expect(ensemble.day_grain_absent_reason).toBe("no complete settled day");
  });

  it("says the metrics table is absent rather than empty", async () => {
    // Forecaster ticket 09's Metrics group is not on the card yet. `null` with
    // a stated reason is "not measured yet"; `[]` would read as "measured as
    // nothing", which is the opposite reading of the same slot.
    serves();
    const body = await wire(await card());
    expect(body.metrics).toBeNull();
    expect(body.metrics_absent_reason).toContain("no metrics group");
    // And it is the sentence on `/v1/meta`'s census, not a second spelling of
    // it. Forecaster 27: this reason is minted here rather than forwarded, so
    // a reviewer can only find it if the one it finds is the one shipped.
    expect(body.metrics_absent_reason).toBe(
      MODEL_CARD_DECLINES.metricsAbsentReason.reason,
    );
    expect(GATEWAY_DECLINED_FIGURES).toContain(MODEL_CARD_DECLINES.metricsAbsentReason);
  });
});

describe("model card · its cache identity is the artifact's", () => {
  it("ETags on the artifact id and the lane, and caches for an hour", async () => {
    serves();
    const response = await card();
    // The lane is in the validator because **an artifact id is unique within a
    // lane and not across them** — see the test below, which is the failure
    // this pair prevents.
    expect(response.headers.get("etag")).toBe(`W/"${ARTIFACT}:${LANE}"`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    // Nothing in this domain is immutable, and this response least of all: a
    // promotion changes it.
    expect(response.headers.get("cache-control")).not.toContain("immutable");
  });

  it("does not answer one lane's validator with another lane's card", async () => {
    // `jobs/retrain.ts`: the run id "is the artifact stem in both lanes", so one
    // retrain mints one artifact id across `gate_early` and `gate_late` alike.
    // With the id alone as the validator, a client holding the late gate's ETag
    // could send it against the early gate and be answered 304 with no body —
    // then render the late gate's reliability curve, coverage and risk bins as
    // the early gate's. The two gates see different weather runs and their
    // calibration is not interchangeable.
    const early = "dessem_free_v1__gate_early__thr5";
    serves();
    const late = await card();
    const lateTag = late.headers.get("etag") as string;
    expect(lateTag).toContain(ARTIFACT);

    serves();
    const crossed = await get(`/v1/model/card?lane=${early}`, {
      "if-none-match": lateTag,
    });
    expect(crossed.status).not.toBe(304);
    // And the two lanes' validators differ, which is the property that makes
    // the line above hold for a reason rather than by accident.
    serves();
    const earlyTag = (await get(`/v1/model/card?lane=${early}`)).headers.get("etag");
    expect(earlyTag).not.toBe(lateTag);
  });

  it("revalidates to a 304 rather than re-reading the card", async () => {
    serves();
    const first = await card();
    const etag = first.headers.get("etag") as string;
    const again = await get(`/v1/model/card?lane=${LANE}`, { "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  it("changes the ETag when a promotion changes the artifact", async () => {
    serves();
    const before = (await card()).headers.get("etag");
    serves({ ...envelope(), artifact_id: "2026-09-05T03:11:07Z" });
    const after = (await card()).headers.get("etag");
    expect(after).not.toBe(before);
  });
});

describe("model card · the refusals stay four different sentences", () => {
  it("returns MODEL_UNAVAILABLE with the lane state in the details", async () => {
    refuses(503, "MODEL_UNAVAILABLE", {
      lane: LANE,
      lane_state: "present_unpromoted",
      volume_mounted: true,
    });
    const response = await card();
    expect(response.status).toBe(503);
    const body = await wire(response);
    expect(body.error.code).toBe("MODEL_UNAVAILABLE");
    // The whole point of the field: "a candidate was refused" is a different
    // sentence to "nothing has been trained" and to "the volume cannot say".
    expect(body.error.details.lane_state).toBe("present_unpromoted");
    expect(body.error.details.volume_mounted).toBe(true);
    expect(body.error.details.lane).toBe(LANE);
  });

  it("keeps an unmounted volume distinguishable from an untrained lane", async () => {
    refuses(503, "MODEL_UNAVAILABLE", {
      lane: LANE,
      lane_state: "no_artifact",
      volume_mounted: false,
    });
    const body = await wire(await card());
    expect(body.error.details.lane_state).toBe("no_artifact");
    expect(body.error.details.volume_mounted).toBe(false);
  });

  it("refuses a malformed lane before the network hop", async () => {
    // Rounding this to MODEL_UNAVAILABLE would say the model is missing when
    // what is missing is a well-formed lane. Asserted by the status: the stub
    // is set to answer 200, so a 400 can only have come from the gateway.
    serves();
    const response = await card("?lane=not-a-lane");
    expect(response.status).toBe(400);
    expect((await wire(response)).error.code).toBe("BAD_INPUT");
  });

  it("never defaults the lane", async () => {
    serves();
    expect((await card("")).status).toBe(422);
  });

  it("reports an unreadable card as an upstream failure, not as an empty one", async () => {
    reply = () => Response.json({ lane: LANE, artifact_id: ARTIFACT });
    const response = await card();
    expect(response.status).toBe(502);
    expect((await wire(response)).error.code).toBe("UPSTREAM_FAILED");
  });

  it("refuses a card missing a group rather than shaping a partial one", async () => {
    const partial = structuredClone(CARD) as Wire;
    delete partial.quantiles;
    serves(envelope(partial));
    expect((await card()).status).toBe(502);
  });
});

describe("model card · the shaping function, without a network", () => {
  it("builds the subset from the card alone", () => {
    const shaped = toModelCard({
      lane: LANE,
      artifact_id: ARTIFACT,
      correction_regime: REGIME,
      card: CARD,
    });
    expect(shaped.laneState).toBe("promoted");
    expect(shaped.artifact.artifactId).toBe(ARTIFACT);
    expect(shaped.artifact.featureSetVersion).toBeNull();
    expect(shaped.windows.calibration).toEqual({
      start: "2025-01-01",
      end: "2025-03-31",
    });
    // Counted per fidelity, never averaged into one number (rule 9).
    expect(shaped.windows.rowsByVintageFidelity).toEqual({ point_in_time: 12_192 });
    expect(shaped.riskBins.high).toEqual([0.3, 1]);
    expect(shaped.band.deltaLo).toBeLessThan(0);
    expect(shaped.decision).toBeNull();
  });

  it("carries the gate's decision when a gate has run over the card", () => {
    const decided = {
      ...CARD,
      gate: {
        decision: "promote",
        reason: "bootstrap P = 0.94",
        at: "2026-09-04T03:10:12Z",
        bootstrap_p: 0.94,
        compared_against: "2026-08-01T03:00:00Z",
      },
    };
    const shaped = toModelCard({
      lane: LANE,
      artifact_id: ARTIFACT,
      correction_regime: REGIME,
      card: decided,
    });
    expect(shaped.decision).toEqual({
      decision: "promote",
      reason: "bootstrap P = 0.94",
      at: "2026-09-04T03:10:12Z",
      bootstrapP: 0.94,
      comparedAgainst: "2026-08-01T03:00:00Z",
    });
  });
});
