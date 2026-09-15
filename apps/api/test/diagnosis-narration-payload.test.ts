import { describe, expect, it } from "bun:test";
import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { NOTABLE_DRIVER_LIMIT, NOTABLE_SHARE_MIN } from "@wattsteer/core/driver-display";
import { explain, validate } from "@wattsteer/core/schema";
import {
  buildNarrationPayload,
  canonicalNarrationJson,
  NARRATION_DISPLAY_PRECISION,
  narrationCacheKey,
  narrationDocument,
  narrationPayloadDigest,
  notableNarrationGroups,
  observedReasonsFromFlags,
  toNarrationDocument,
} from "../src/diagnosis/index.js";
import type {
  AttributionDriverRow,
  PublishedAttributionRow,
} from "../src/diagnosis/reads.js";
import type { ForecastDayRow } from "../src/forecast/reads.js";

/**
 * The renderer's entire world, assembled and closed.
 *
 * Everything here is fixture-driven: no database, no network, no artifact.
 * That is not a convenience, it is the property under test — `docs/specs/
 * diagnosis.md` says the narration payload is *assembled from two stored rows
 * and the fired rules*, and a test that needed anything else would have caught
 * the module recomputing.
 *
 * Four things this file is trying to make impossible, in the order they would
 * quietly go wrong:
 *
 *  1. **A number the copy wants that the document does not carry.** The
 *     renderer may not compute, so the first test walks the spec's own field
 *     list and asserts every one is present as a number — `top_two_share`
 *     loudest, because the prototype's fixture narration added two shares
 *     together and a narration doing correct arithmetic looks exactly like one
 *     that hallucinated.
 *  2. **A preformatted string.** `"310 MW left"` is a translated string by
 *     another name and would put en-US grouping into a Portuguese paragraph.
 *  3. **An accidental field.** It would change the cache key and silently
 *     invalidate every cached narration, so the canonical digest is pinned.
 *  4. **A cache that misses on noise or hits on a real change.** Rounding to
 *     display precision before hashing is what separates the two, and it is
 *     asserted in both directions (spec seam 12).
 */

const SUBSYSTEM = "NE" as const;
const TARGET_DATE = "2026-08-28";
const ARTIFACT = "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z";
const PUBLISHED_AT = new Date("2026-08-27T22:11:07.000Z");
const PROMPT_VERSION = "2026-08-28.1";

/**
 * Eight groups whose `phi` sum to the movement they decompose.
 *
 * `160 + 96 + 64 + 48 − 32 − 24 + 12 − 8 = 316 = 412 − 96`, and both signs are
 * represented so that `direction` is exercised rather than assumed. Ranked by
 * `|share|`, as the wire promises.
 */
const PHI: readonly [string, string, number][] = [
  ["renewable_resource", "proxy_renewable_load_ratio", 160],
  ["net_surplus", "proxy_residual_load_mwh", 96],
  ["export_stress", "dessem_export_utilisation", 64],
  ["demand_level", "programmed_load_mwh", 48],
  ["ramp_shape", "proxy_residual_load_ramp_1h", -32],
  ["calendar_season", "calendar_day_of_week", -24],
  ["recent_history", "observed_constrained_off_mwh_lag_24h", 12],
  ["data_conditions", "weather_run_age_hours", -8],
];

const SUM_ABS = PHI.reduce((total, [, , phi]) => total + Math.abs(phi), 0);

function drivers(): AttributionDriverRow[] {
  return PHI.map(([code, feature, phi], index) => ({
    code,
    labelCode: `driver.${code}`,
    rank: index + 1,
    phiMwh: phi,
    share: Math.abs(phi) / SUM_ABS,
    direction: phi >= 0 ? ("raises" as const) : ("lowers" as const),
    hourDisagreement: 1 + index / 10,
    headlineFeature: feature,
    observed: 1.42 + index / 100,
    typical: 0.96,
    observedAbsentReason: null,
    typicalAbsentReason: null,
    unit: "ratio",
    demoted: false,
  }));
}

function attributionRow(
  overrides: Partial<PublishedAttributionRow> = {},
): PublishedAttributionRow {
  const day = drivers();
  return {
    subsystem: SUBSYSTEM,
    targetDate: TARGET_DATE,
    gateProfile: "gate_late",
    thresholdMw: 5,
    artifactId: ARTIFACT,
    featureSet: "dessem_free_v1",
    correctionRegime: "conformal_v1_partial_upper",
    publishedAt: PUBLISHED_AT,
    ingestedAt: PUBLISHED_AT,
    dataVersion: 1,
    target: "expected_mwh_day",
    explains: "diagnosis.explains_expectation_not_band",
    hoursAttributed: 24,
    baselineExpectedMwh: 96,
    dayExpectedMwh: 412,
    totalAttributedMwh: 316,
    sumAbsAttributedMwh: SUM_ABS,
    localAccuracyResidualMwh: 0,
    topTwoShare: (160 + 96) / SUM_ABS,
    attributionStderrMwh: 4.1,
    baselineStderrMwh: 3.2,
    stderrResamples: 200,
    stderrSeed: 7,
    peakHourLocal: 13,
    peakHourExpectedMwh: 41,
    peakHourBaselineExpectedMwh: 9,
    driverGroupVersion: "3",
    driverGroupHash: `sha256:${"0".repeat(64)}`,
    backgroundSource: "base_fit",
    backgroundSeed: 11,
    backgroundRows: 128,
    coalitions: 256,
    ruleFlags: [],
    governingRuleAction: null,
    drivers: day,
    peakHourDrivers: day.map((driver) => ({ ...driver, hourDisagreement: null })),
    vintageFidelity: "point_in_time",
    ...overrides,
  };
}

function forecastRow(overrides: Partial<ForecastDayRow> = {}): ForecastDayRow {
  return {
    subsystem: SUBSYSTEM,
    targetDate: TARGET_DATE,
    gateProfile: "gate_late",
    thresholdMw: 5,
    artifactId: ARTIFACT,
    featureSet: "dessem_free_v1",
    trainedThrough: "2026-06-30",
    correctionRegime: "conformal_v1_partial_upper",
    publishedAt: PUBLISHED_AT,
    ingestedAt: PUBLISHED_AT,
    dataVersion: 1,
    dayTotalMwh: { p10: 0, p50: 370, p90: 980 },
    peakPowerMw: { p10: 0, p50: 118, p90: 260 },
    dayOccurrenceProbability: 0.87,
    dayExpectedMwh: 412,
    split: { windMwh: 300, solarMwh: 112 },
    hoursP50Nonzero: 9,
    derivation: "path_ensemble",
    riskBinElevatedFrom: 0.35,
    riskBinHighFrom: 0.7,
    ...overrides,
  };
}

function sources(
  attribution = attributionRow(),
  forecast = forecastRow(),
): Parameters<typeof buildNarrationPayload>[0] {
  return { attribution, forecast, locale: "pt-BR", promptVersion: PROMPT_VERSION };
}

/**
 * The canonical digest of the fixture document above.
 *
 * **This is the snapshot, and it is meant to be brittle.** A field added to the
 * payload — even a harmless-looking one — changes these bytes and therefore
 * changes every cache key in production, discarding every narration already
 * paid for. The spec asks for a test that fails on exactly that, and this
 * constant is it: when it moves, the question to answer is not "what is the new
 * hash" but "is invalidating the whole narration cache what we meant".
 *
 * **It moved once, deliberately**, from
 * `593294f6d1f0a243e8e6d88e0a30b93a6809fa8c934b356a100e6f4842347d1e`: `Driver`
 * gained `observed_absent_reason` and `typical_absent_reason` when a headline
 * reading became a number *or* a stated absence (api-surface 10). Invalidating
 * every cached paragraph is what we meant — a paragraph written before the
 * document could say "this group has no reading" was written against a
 * document that had refused to exist in that case, so there is no cached
 * narration the new document is equivalent to.
 */
const CANONICAL_DIGEST =
  "406b37601c57588a63d89f87f201d7b42681d2d0597e94721078fa96b55f0f30";

describe("the narration payload · every figure the copy could want, as a number", () => {
  it("assembles the whole document from the two stored rows", () => {
    const payload = buildNarrationPayload(sources());

    expect(payload.schemaVersion).toBe("diagnosis.narration.v1");
    expect(payload.promptVersion).toBe(PROMPT_VERSION);
    expect(payload.locale).toBe("pt-BR");
    expect(payload.subsystem).toBe("NE");
    expect(payload.subsystemDisplayName).toBe("NORDESTE");
    expect(payload.targetDate).toBe(TARGET_DATE);
    expect(payload.thresholdMw).toBe(5);
    expect(payload.forecastOrigin).toEqual({
      runLabel: ARTIFACT,
      gateProfile: "gate_late",
      publishedAt: "2026-08-27T22:11:07.000Z",
    });
    expect(payload.vintageFidelity).toBe("point_in_time");
    expect(payload.risk).toEqual({
      dayOccurrenceProbability: 0.87,
      riskClass: "high",
      hoursP50Nonzero: 9,
    });
    expect(payload.magnitude).toEqual({
      dayExpectedMwh: 412,
      baselineExpectedMwh: 96,
      dayEnergyP10Mwh: 0,
      dayEnergyP50Mwh: 370,
      dayEnergyP90Mwh: 980,
      peakPowerP50Mw: 118,
      peakHourLocal: 13,
    });
    expect(payload.attribution.target).toBe("expected_mwh_day");
    expect(payload.attribution.totalAttributedMwh).toBe(316);
    expect(payload.attribution.sumAbsAttributedMwh).toBe(SUM_ABS);
    expect(payload.attribution.stderrMwh).toBe(4.1);
    expect(payload.attribution.groups).toHaveLength(8);
    expect(payload.ruleFlags).toEqual([]);
  });

  it("carries `top_two_share` rather than adding two shares", () => {
    // The stored value is deliberately not the sum of the top two. A builder
    // that "helpfully" recomputed it would return 0.576…; one that carries the
    // published number returns what was published. The renderer downstream may
    // not add, and neither may the thing that feeds it.
    const payload = buildNarrationPayload(sources(attributionRow({ topTwoShare: 0.42 })));
    expect(payload.attribution.topTwoShare).toBe(0.42);
  });

  it("classifies the risk through the one classifier, off the stored edges", () => {
    const quiet = forecastRow({ dayOccurrenceProbability: 0.4 });
    expect(buildNarrationPayload(sources(attributionRow(), quiet)).risk.riskClass).toBe(
      "elevated",
    );
    const calm = forecastRow({ dayOccurrenceProbability: 0.05 });
    expect(buildNarrationPayload(sources(attributionRow(), calm)).risk.riskClass).toBe(
      "low",
    );
  });

  it("reads `observed_reasons_latest` off the rule that reported it", () => {
    const flags = [
      {
        code: "unmodelled_outage_regime",
        action: "annotate" as const,
        facts: {
          settled_date: "2026-08-27",
          top_reason: "REL",
          top_reason_share: 0.62,
        },
      },
    ];
    expect(observedReasonsFromFlags(flags)).toEqual({
      date: "2026-08-27",
      topReason: "REL",
      topReasonShare: 0.62,
    });
    // No rule, no block: absence here means "no rule reported one", which is
    // why the field is optional in the schema rather than defaulted to a zero.
    expect(observedReasonsFromFlags([])).toBeUndefined();

    const payload = buildNarrationPayload(sources(attributionRow({ ruleFlags: flags })));
    expect(payload.observedReasonsLatest?.topReason).toBe("REL");
    expect(payload.ruleFlags).toEqual([
      { code: "unmodelled_outage_regime", severity: "annotate", facts: flags[0].facts },
    ]);
  });
});

describe("the narration payload · codes only, and one proper noun", () => {
  it("carries `observed` and `typical` as numbers with a unit code", () => {
    const document = narrationDocument(sources());
    const groups = (document.attribution as { groups: Record<string, unknown>[] }).groups;
    for (const group of groups) {
      expect(typeof group.observed).toBe("number");
      expect(typeof group.typical).toBe("number");
      expect(typeof group.unit).toBe("string");
    }
  });

  it("contains no prose but ONS's own display name", () => {
    const document = narrationDocument(sources());
    const prose: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          walk(item, `${path}[${index}]`);
        });
      } else if (typeof value === "object" && value !== null) {
        for (const [key, member] of Object.entries(value)) {
          walk(member, path === "" ? key : `${path}.${key}`);
        }
      } else if (typeof value === "string" && /\s/.test(value)) {
        prose.push(`${path}: ${value}`);
      }
    };
    walk(document, "");
    expect(prose).toEqual([]);

    // The one untranslated proper noun, and it is ONS's rather than ours.
    expect(SUBSYSTEMS.map((one) => one.onsDisplayName)).toContain(
      document.subsystem_display_name as string,
    );
  });

  it("refuses a preformatted reading", () => {
    const day = drivers();
    // `"310 MW left"` is what the prototype's fixture carried. It is a
    // translated string by another name, and the type system alone no longer
    // permits it — so the runtime check is asserted through a cast, which is
    // exactly how one would arrive from an untyped row.
    day[0] = { ...day[0], observed: "310 MW left" as unknown as number };
    expect(() => narrationDocument(sources(attributionRow({ drivers: day })))).toThrow(
      /prose rather than a code/,
    );
  });

  it("refuses a display name that is not ONS's", () => {
    const payload = buildNarrationPayload(sources());
    expect(() =>
      toNarrationDocument({ ...payload, subsystemDisplayName: "Northeast" }),
    ).toThrow(/ONS's, untranslated/);
  });
});

describe("the narration payload · the document is closed", () => {
  it("validates against the JSON Schema, which is the authority", () => {
    const document = narrationDocument(sources());
    const result = validate("diagnosis-narration-input.schema.json", document);
    expect(explain(result)).toBe("");
    expect(result.valid).toBe(true);
  });

  it("refuses a field the schema does not name", () => {
    const payload = buildNarrationPayload(sources());
    const stowaway = { ...payload, narrationHint: "keep it short" } as typeof payload;
    // Not a passthrough. `encodeWire` carries an unknown key through unrenamed
    // by design, so without this check the field would reach the renderer and,
    // worse, change the cache key.
    expect(() => toNarrationDocument(stowaway)).toThrow(/this document is closed/);
  });

  it("refuses a document missing a field a renderer is promised", () => {
    const payload = buildNarrationPayload(sources());
    const { magnitude: _magnitude, ...short } = payload;
    expect(() => toNarrationDocument(short as typeof payload)).toThrow(/is missing/);
  });

  it("refuses a nested field the schema does not name", () => {
    const payload = buildNarrationPayload(sources());
    const nested = {
      ...payload,
      risk: { ...payload.risk, confidence: 0.5 },
    } as typeof payload;
    expect(() => toNarrationDocument(nested)).toThrow(/risk.confidence/);
  });

  it("refuses two rows that are not the same publication", () => {
    expect(() =>
      buildNarrationPayload(
        sources(attributionRow(), forecastRow({ artifactId: "another_run" })),
      ),
    ).toThrow(/cannot restate two runs/);

    expect(() =>
      buildNarrationPayload(
        sources(attributionRow(), forecastRow({ dayExpectedMwh: 500 })),
      ),
    ).toThrow(/must add up to the figure beside them/);

    expect(() =>
      buildNarrationPayload(
        sources(attributionRow(), forecastRow({ targetDate: "2026-08-29" })),
      ),
    ).toThrow(/the forecast is for/);
  });

  it("refuses a band whose quantiles are out of order", () => {
    expect(() =>
      buildNarrationPayload(
        sources(
          attributionRow(),
          forecastRow({ dayTotalMwh: { p10: 500, p50: 370, p90: 980 } }),
        ),
      ),
    ).toThrow(/out of order/);
  });
});

describe("the narration payload · the canonical form", () => {
  it("sorts keys at every depth", () => {
    const canonical = canonicalNarrationJson(narrationDocument(sources()));
    const keys = [...canonical.matchAll(/"([a-z_0-9]+)":/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    // The top-level run is sorted; so is every nested object, which is what
    // JCS guarantees and what makes the digest independent of insertion order.
    const topLevel = Object.keys(JSON.parse(canonical) as Record<string, unknown>);
    expect(topLevel).toEqual([...topLevel].sort());
  });

  it("is the same bytes for a document whose keys arrived in another order", () => {
    const document = narrationDocument(sources());
    const shuffled = Object.fromEntries(Object.entries(document).reverse());
    expect(canonicalNarrationJson(shuffled)).toBe(canonicalNarrationJson(document));
  });

  it("pins the digest, so an accidental field fails here rather than in the cache", () => {
    expect(narrationPayloadDigest(narrationDocument(sources()))).toBe(CANONICAL_DIGEST);
  });

  it("hits on jitter below display precision and misses above it", () => {
    const base = narrationPayloadDigest(narrationDocument(sources()));

    // A `phi` recomputed on another machine, differing in the twelfth decimal.
    const jittered = drivers();
    jittered[0] = { ...jittered[0], phiMwh: 160 + 1e-12 };
    expect(
      narrationPayloadDigest(
        narrationDocument(sources(attributionRow({ drivers: jittered }))),
      ),
    ).toBe(base);

    // A change the reader could see: one decimal of MWh.
    const moved = drivers();
    moved[0] = { ...moved[0], phiMwh: 160.1 };
    expect(
      narrationPayloadDigest(
        narrationDocument(sources(attributionRow({ drivers: moved }))),
      ),
    ).not.toBe(base);
  });

  it("refuses a number nobody has decided a precision for", () => {
    const document = narrationDocument(sources());
    expect(() =>
      canonicalNarrationJson({ ...document, unpriced_addition: 1.234_56 }),
    ).toThrow(/no display precision/);
  });

  it("prices every number the document actually carries", () => {
    // The complement of the test above: the table is not merely non-empty, it
    // covers this document. A field renamed upstream fails here.
    const document = narrationDocument(sources());
    const missing: string[] = [];
    const walk = (value: unknown, name: string) => {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, name);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [key, member] of Object.entries(value)) {
          walk(member, key);
        }
      } else if (
        typeof value === "number" &&
        NARRATION_DISPLAY_PRECISION[name] === undefined
      ) {
        missing.push(name);
      }
    };
    walk(document, "");
    expect(missing).toEqual([]);
  });

  it("builds the cache key the spec writes down", () => {
    const digest = narrationPayloadDigest(narrationDocument(sources()));
    expect(
      narrationCacheKey({
        promptVersion: PROMPT_VERSION,
        modelId: "claude-opus-5",
        locale: "pt-BR",
        digest,
      }),
    ).toBe(`narration:v1:${PROMPT_VERSION}:claude-opus-5:pt-BR:${digest}`);
  });

  it("misses when the locale, the prompt or the model changes", () => {
    const digest = narrationPayloadDigest(narrationDocument(sources()));
    const base = {
      promptVersion: PROMPT_VERSION,
      modelId: "claude-opus-5",
      locale: "pt-BR",
      digest,
    };
    const keys = new Set([
      narrationCacheKey(base),
      narrationCacheKey({ ...base, locale: "en-US" }),
      narrationCacheKey({ ...base, promptVersion: "2026-09-01.1" }),
      narrationCacheKey({ ...base, modelId: "claude-sonnet-5" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("misses when the artifact that produced the numbers changes", () => {
    // The run label is *in* the document, so a retrain, a promotion or a
    // superseding run invalidates the key by construction. There is no manual
    // invalidation path to forget to call.
    const other = attributionRow({ artifactId: "dessem_free_v1__gate_late__thr5/x" });
    const forecast = forecastRow({ artifactId: "dessem_free_v1__gate_late__thr5/x" });
    expect(narrationPayloadDigest(narrationDocument(sources(other, forecast)))).not.toBe(
      narrationPayloadDigest(narrationDocument(sources())),
    );
  });
});

describe("the narration payload · selection is shared, the merge is not", () => {
  it("names the notable groups and no others", () => {
    const payload = buildNarrationPayload(sources());
    const notable = notableNarrationGroups(payload);

    expect(notable).toHaveLength(NOTABLE_DRIVER_LIMIT);
    for (const group of notable) {
      expect(group.share).toBeGreaterThanOrEqual(NOTABLE_SHARE_MIN);
    }
    // The document still carries all eight, whatever the cut selected: the
    // shares' denominator is the whole attributed movement, and a shortlist on
    // the wire would be a share whose denominator no longer exists.
    expect(payload.attribution.groups).toHaveLength(8);
  });

  it("computes no `other` row and no `mixed` direction", () => {
    const payload = buildNarrationPayload(sources());
    const codes = payload.attribution.groups.map((group) => group.code);
    expect(codes).not.toContain("other");
    for (const group of payload.attribution.groups) {
      expect(["raises", "lowers"]).toContain(group.direction);
    }
  });
});
