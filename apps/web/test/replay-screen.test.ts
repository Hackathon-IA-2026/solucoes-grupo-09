import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Replay } from "@wattsteer/core/api";
import { decodeWire } from "@wattsteer/core/wire";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";

/**
 * The Time Machine screen, asserted against the **published** contract rather
 * than against a fixture it could have restated.
 *
 * `docs/specs/replay.md` is unusual in that every defect it guards against
 * produces a *better* number, in the flattering direction, with nothing on
 * screen to show it. So the tests here assert the things that would have to be
 * true for the number to be honest — where it came from, what it is divided by,
 * and what is drawn beside it — rather than that a component renders.
 *
 * Two kinds of assertion, and the split is deliberate:
 *
 *  - **Contract**, over `packages/core/fixtures/spec-examples/12-replay.json`.
 *    That file is the published example of the shape both sides of the wire
 *    agree on, so asserting the screen's inputs against it is asserting them
 *    against something a fixture cannot quietly diverge from.
 *  - **Structural**, over the screen's own source. Several of this ticket's
 *    obligations are about what the screen *does not* do — it does not sum a
 *    band, it does not divide by an episode, it does not draw one dispatch
 *    series where there are two — and an absence is not renderable. A grep is
 *    the honest instrument for an absence, and it says so where it is one.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const SCREEN = join(ROOT, "apps", "web", "src", "app", "app", "replay.tsx");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * The same file with its comments blanked and its newlines kept.
 *
 * Every structural check below is about what the code *does*, and these files
 * explain at length what they deliberately no longer do — the prototype's
 * `IN-SAMPLE` branch is named in the screen's own header precisely so the next
 * reader knows it was deleted rather than forgotten. Reading that as code would
 * make the guards fire on their own documentation, and the honest response to
 * such a failure would be to delete an explanation.
 */
function sourceWithoutComments(path: string): string {
  return source(path).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** The published example, decoded through the one translator a screen uses. */
const EXAMPLE: Replay = decodeWire(
  "Replay",
  JSON.parse(
    source(join(ROOT, "packages", "core", "fixtures", "spec-examples", "12-replay.json")),
  ),
) as Replay;

describe("the day total is joint, and the screen reads it", () => {
  it("the published day total is not the componentwise sum of the hours", () => {
    // Quantiles do not add. Summing 24 P90s describes a day on which every hour
    // lands at its own 90th percentile *together*, which is a far worse day
    // than a 90th-percentile day.
    //
    // The P90 is asserted with a direction and the other two without one, and
    // that asymmetry is the arithmetic rather than a hedge: imperfect
    // dependence makes the joint P90 sit below the componentwise sum, but an
    // hourly hurdle puts mass at exactly zero, so a drawn day whose common
    // level runs low switches whole episode hours off and can land the joint
    // P10 either side of the sum of the hourly P10s. Pinning a direction there
    // would pin an assumption about the dependence structure instead of the
    // rule.
    const sum = (key: "p10" | "p50" | "p90") =>
      EXAMPLE.forecast.hours.reduce((acc, hour) => acc + hour.constrainedOffMwh[key], 0);
    expect(EXAMPLE.forecast.dayTotal.p90).toBeLessThan(sum("p90"));
    expect(EXAMPLE.forecast.dayTotal.p50).not.toBe(sum("p50"));
    expect(EXAMPLE.forecast.dayTotal.p10).not.toBe(sum("p10"));
    expect(EXAMPLE.forecast.dayTotal.p10).toBeLessThanOrEqual(
      EXAMPLE.forecast.dayTotal.p50,
    );
    expect(EXAMPLE.forecast.dayTotal.p50).toBeLessThanOrEqual(
      EXAMPLE.forecast.dayTotal.p90,
    );
  });

  it("the screen reads the joint total and builds no band of its own", () => {
    // `test/no-summed-bands.test.ts` is the standing repo-wide guard; this is
    // the local half, which says the screen reaches for the field that exists
    // rather than reaching for it and *also* keeping a sum around.
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("replay.forecast.dayTotal");
    expect(screen).not.toMatch(/forecast\.hours\s*\.\s*reduce/);
    expect(screen).not.toContain("forecastBand");
  });
});

describe("the denominator is the day, not the episode", () => {
  it("the published example divides the day total, not the episode total", () => {
    // They differ in the published example, which is the whole reason the
    // distinction is worth a test: an episode is the run of hours above the
    // threshold, so a share taken over it would improve simply for having drawn
    // the episode more tightly.
    const episode = EXAMPLE.episodes[0];
    expect(episode).toBeDefined();
    if (episode === undefined) {
      throw new Error("asserted above");
    }
    expect(episode.totalMwh).not.toBe(EXAMPLE.actual.totalMwh);
    expect(EXAMPLE.baselineCurtailmentMwh).toBe(EXAMPLE.actual.totalMwh);
    const avoidability = EXAMPLE.avoidability;
    expect(avoidability).not.toBeNull();
    if (avoidability === null) {
      throw new Error("asserted above");
    }
    expect(avoidability).toBeCloseTo(
      EXAMPLE.avoidedEnergyMwh / EXAMPLE.actual.totalMwh,
      3,
    );
    // And the same share taken over the episode would be a different number,
    // so the two readings are genuinely distinguishable here.
    expect(avoidability).not.toBeCloseTo(EXAMPLE.avoidedEnergyMwh / episode.totalMwh, 3);
  });

  it("the comparison rows read the day total, not the episode's", () => {
    // Asserted on the rows rather than on the file. This was a slice of the
    // screen between two `function` keywords, and it moved with a function
    // rather than with a denominator; `compareRows` is a value now, and
    // `replay-notes.test.ts` runs it against the published example, where the
    // day total and the episode total genuinely differ.
    //
    // What stays here is the absence: an episode's `total_mwh` is rendered on
    // the episode row it belongs to, which is the one honest use of it, and no
    // headline may reach for it.
    const screen = sourceWithoutComments(SCREEN);
    const replayed = screen.slice(
      screen.indexOf("function Replayed("),
      screen.indexOf("function ObservedOnly("),
    );
    expect(replayed).not.toContain("episode.totalMwh");
  });
});

describe("the honesty block is above the numbers, and cannot be put away", () => {
  it("it is rendered before the first figure on the replayed day", () => {
    const screen = sourceWithoutComments(SCREEN);
    const replayed = screen.slice(screen.indexOf("function Replayed("));
    const honesty = replayed.indexOf("<HonestyNote");
    const firstPanel = replayed.indexOf("<Panel");
    expect(honesty).toBeGreaterThan(-1);
    expect(firstPanel).toBeGreaterThan(-1);
    expect(honesty).toBeLessThan(firstPanel);
  });

  it("the block itself has no collapse affordance", () => {
    // A caveat behind an interaction is a caveat nobody reads, and these ones
    // change what the number means. Asserted on the component rather than on
    // the screen, because that is where a disclosure control would be added.
    const honesty = sourceWithoutComments(
      join(ROOT, "apps", "web", "src", "components", "app", "honesty.tsx"),
    );
    const block = honesty.slice(honesty.indexOf("export function HonestyNote("));
    expect(block).not.toContain("Pressable");
    expect(block).not.toContain("onPress");
    expect(block).not.toContain("collaps");
  });

  it("the provenance statement and the vintage statement are two, never merged", () => {
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("<ProvenanceBadge");
    expect(screen).toContain("<VintageBadge");
    // Two axes, neither derived from the other. They coincide today, which is
    // exactly the argument for keeping them apart: `fold_holdout` +
    // `point_in_time` becomes populated the moment F6 freezes.
    //
    // That both badges are on the screen is structural and stays here. That the
    // two sentences under them are genuinely two is a property of the strings,
    // and `replay-notes.test.ts` asserts it by rendering both — this file used
    // to assert it with `toContain("provenanceNote")`, which passed equally if
    // the two notes returned the same sentence.
  });

  it("the IN-SAMPLE branch is deleted, not left unreachable", () => {
    // Under this spec no replayable day is in-sample — a day no artifact held
    // out is refused rather than labelled — so the badge stops being a warning
    // and becomes a provenance statement. Dead code that says otherwise is a
    // claim the product does not make.
    const web = join(ROOT, "apps", "web", "src");
    const suspects = ["IN-SAMPLE", "inTrainingWindow", "MODEL_TRAINED_THROUGH"];
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const offenders: string[] = [];
    for (const relative of glob.scanSync(web)) {
      const text = sourceWithoutComments(join(web, relative));
      for (const suspect of suspects) {
        if (text.includes(suspect)) {
          offenders.push(`${relative}: ${suspect}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("one headline, the floor beside it, and no carbon anywhere", () => {
  it("absorbed, recovered and avoided are one number on the contract", () => {
    // Three names for one quantity, which is why the screen renders one
    // headline for it: `avoided_energy_mwh` at the top level is
    // `scored.observed.recovered_mwh` by construction.
    expect(EXAMPLE.avoidedEnergyMwh).toBe(EXAMPLE.scored.observed.recoveredMwh);
    expect(EXAMPLE.optimizedCurtailmentMwh).toBeCloseTo(
      EXAMPLE.actual.totalMwh - EXAMPLE.avoidedEnergyMwh,
      6,
    );
  });

  it("the floor is the P10 recovery, and the verdict travels with it", () => {
    expect(EXAMPLE.recoveredFloorMwh).toBe(EXAMPLE.scored.p10.recoveredMwh);
    expect(EXAMPLE.floorMet).toBe(EXAMPLE.avoidedEnergyMwh >= EXAMPLE.recoveredFloorMwh);
    expect(EXAMPLE.floorMarginMwh).toBeCloseTo(
      EXAMPLE.avoidedEnergyMwh - EXAMPLE.recoveredFloorMwh,
      6,
    );
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("replay.recoveredFloorMwh");
    expect(screen).toContain("replay.floorMet");
    expect(screen).toContain("replay.floorMarginMwh");
  });

  it("no carbon field exists on the contract and none is rendered", () => {
    // None is derivable from recovered renewable energy without a
    // marginal-emissions model, and none is offered. Asserted over the whole
    // payload and over both catalogues, because a claim nobody can support is
    // as easy to add in copy as in a field.
    const carbon = /\b(carbon|co2|co₂|emission|emissão|emissões|carbono)\b/i;
    expect(JSON.stringify(EXAMPLE)).not.toMatch(carbon);
    for (const catalogue of [EN.app.replay, PT.app.replay]) {
      const words = JSON.stringify(catalogue);
      // The one legitimate occurrence is the sentence that says no carbon claim
      // is made. Everything else would be one.
      const claims = catalogue.claimsNote;
      expect(claims).toMatch(carbon);
      expect(words.replace(JSON.stringify(claims).slice(1, -1), "")).not.toMatch(carbon);
    }
  });
});

describe("scheduled and executed are two series", () => {
  it("the contract carries both, and they are separate arrays", () => {
    expect(Array.isArray(EXAMPLE.dispatch)).toBe(true);
    expect(Array.isArray(EXAMPLE.executed)).toBe(true);
    expect(EXAMPLE.executionRule).toBe("follow_curtailment");
    expect(EXAMPLE.planningBasis).toBe("p50");
    // The plan is built on the P50 envelope and scored on what happened; the
    // field that says so is on the object because without it the two results
    // are a trap.
    expect(EXAMPLE.scoredOn).toBe("observed");
  });

  it("the screen hands both to the chart, and the chart takes both", () => {
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("scheduled={dispatchSeries(replay.dispatch)}");
    expect(screen).toContain("executed={dispatchSeries(replay.executed)}");
    const chart = sourceWithoutComments(
      join(ROOT, "apps", "web", "src", "components", "charts", "plan-vs-executed.tsx"),
    );
    expect(chart).toContain("scheduled: HourlyDispatch[]");
    expect(chart).toContain("executed: HourlyDispatch[]");
    // Three legend entries, so the two lines and the settled day are named
    // rather than left to be told apart by colour.
    for (const key of ["seriesActual", "seriesScheduled", "seriesExecuted"] as const) {
      expect(EN.app.replay[key].length).toBeGreaterThan(0);
      expect(PT.app.replay[key].length).toBeGreaterThan(0);
    }
  });
});

describe("the plan chart's axis is the settled day, not the dispatch", () => {
  it("does not drop the day off the plot when the dispatch is sparse", () => {
    // The defect: `slot = chartW / executed.length`. The contract's own example
    // carries one dispatch hour, which made one slot the whole plot and put
    // every settled bar after the first past its right edge — an empty chart
    // over a 612 MWh day, on /app/replay and /app/time-machine alike.
    const chart = sourceWithoutComments(
      join(ROOT, "apps", "web", "src", "components", "charts", "plan-vs-executed.tsx"),
    );
    expect(chart).toContain("chartW / Math.max(actualHours.length, 1)");
    expect(chart).not.toContain("chartW / executed.length");
    // Each dispatch point sits at its own hour, never at its array position.
    expect(chart).toContain("x(hour.hourLocal)");
    expect(EXAMPLE.dispatch.length).toBeLessThan(EXAMPLE.actual.hours.length);
  });
});

describe("perfect foresight is fenced, and labelled in the spec's own words", () => {
  it("the label is verbatim", () => {
    expect(EN.app.replay.foresightLabel).toBe(
      "The best any plan could have done knowing the answer",
    );
    // Translated rather than transliterated, and still the same claim: the
    // product is bilingual and a verbatim English string on a Portuguese page
    // would be the leak the hardcoded-copy guard exists to catch.
    expect(PT.app.replay.foresightLabel).not.toBe(EN.app.replay.foresightLabel);
    expect(PT.app.replay.foresightLabel.length).toBeGreaterThan(0);
  });

  it("no headline figure is populated from the bound", () => {
    // It lives under `upper_bound`, never in `avoided_energy_mwh` and never in
    // `scored`. On the published example it is strictly larger than what the
    // plan achieved, which is what makes the confusion possible and the fence
    // necessary.
    expect(EXAMPLE.upperBound.recoveredMwh).toBeGreaterThan(EXAMPLE.avoidedEnergyMwh);
    expect(EXAMPLE.upperBound.forecastValueGapMwh).toBeCloseTo(
      EXAMPLE.upperBound.recoveredMwh - EXAMPLE.avoidedEnergyMwh,
      6,
    );
    const screen = sourceWithoutComments(SCREEN);
    const headline = screen.slice(
      screen.indexOf("function Replayed("),
      screen.indexOf("function ObservedOnly("),
    );
    // The one place `upperBound` is read is the fenced block's props.
    const reads = headline.match(/replay\.upperBound\.[A-Za-z]+/g) ?? [];
    expect(reads.sort()).toEqual([
      "replay.upperBound.avoidability",
      "replay.upperBound.forecastValueGapMwh",
      "replay.upperBound.recoveredMwh",
    ]);
    expect(headline.indexOf("<PerfectForesight")).toBeGreaterThan(
      headline.indexOf("copy.app.replay.headlineRecovered"),
    );
  });
});

describe("an absence is rendered as an absence", () => {
  it("undefined avoidability reads as a dash with its reason", () => {
    // Zero would mean "nothing could be avoided". `null` means there was
    // nothing to avoid, which is a different statement, and the sentence beside
    // the dash names the threshold no hour of the day reached.
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("replay.avoidability === null");
    expect(screen).toContain("copy.app.replay.avoidabilityUndefined");
    for (const catalogue of [EN.app.replay, PT.app.replay]) {
      expect(catalogue.avoidabilityUndefined).toContain("{mw}");
    }
    // `Avoidability` is nullable on the contract, so the branch is reachable.
    expect(
      EXAMPLE.avoidability === null || typeof EXAMPLE.avoidability === "number",
    ).toBe(true);
  });

  it("every episode carries the threshold and the gap tolerance that made it", () => {
    for (const episode of EXAMPLE.episodes) {
      expect(typeof episode.thresholdMw).toBe("number");
      expect(typeof episode.maxGapHours).toBe("number");
    }
    /*
      **The panel carries them, which is where a per-panel constant belongs.**

      This asserted them on `episodeRow`, a one-sentence template that printed
      every field of every episode — including the threshold and the gap, which
      are identical on every line because they are parameters of the cut, not
      properties of an episode. A fortnight of episodes was therefore a wall in
      which the two figures that *do* differ between rows sat sixth and seventh
      in a sentence. The list is a table now and those two constants are printed
      once each: the threshold in the subtitle, the gap tolerance in the
      footnote.

      The invariant is unchanged and is the one `episode-list.tsx` states — a
      list must never be rendered beside a threshold it was not cut with. What
      moved is where the panel says it, not whether.
    */
    for (const catalogue of [EN.app.replay, PT.app.replay]) {
      expect(catalogue.episodesSubtitle).toContain("{mw}");
      expect(catalogue.episodeNote).toContain("{gap}");
    }
  });
});

describe("the fleet re-plans, and never re-forecasts", () => {
  it("the screen's only request is the replay, and it sends a scenario", () => {
    const hook = sourceWithoutComments(
      join(ROOT, "apps", "web", "src", "components", "app", "use-replay.ts"),
    );
    // Two calls, both on the replay surface. Nothing here loads a forecast,
    // because the forecast is a pinned historical row: that is what makes an
    // asset slider a re-plan rather than a new prediction.
    const calls = hook.match(/api\s*\n?\s*\.\s*([A-Za-z]+)\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(hook).toContain("api.replayObservedOnly(");
    expect(hook).not.toContain("forecastDayAhead");
    expect(sourceWithoutComments(SCREEN)).not.toContain("forecastDayAhead");
    // Keyed on the canonical scenario bytes, so an object React rebuilt with
    // identical contents is the same question and does not re-request.
    expect(hook).toContain("encodeScenario(scenario)");
  });

  it("the editors are the same ones Mitigate uses", () => {
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("<BatteryEditor");
    expect(screen).toContain("<LoadEditor");
    expect(screen).toContain("withBattery(scenario, next)");
    expect(screen).toContain("withLoad(scenario, next)");
  });
});

describe("every refusal renders in both locales from a typed code", () => {
  const CODES = [
    "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW",
    "REPLAY_DATE_OUT_OF_RANGE",
    "REPLAY_FORECAST_UNAVAILABLE",
    "REPLAY_OBSERVATION_INCOMPLETE",
    "REPLAY_INTEGRITY_VIOLATION",
  ] as const;

  it("all five have a sentence in both catalogues", () => {
    for (const code of CODES) {
      for (const catalogue of [EN.error, PT.error]) {
        const sentence: string = catalogue[code];
        expect(sentence.length).toBeGreaterThan(10);
        // A code rendered as itself is the failure this asserts against.
        expect(sentence).not.toContain(code);
      }
      expect(EN.error[code]).not.toBe(PT.error[code]);
    }
  });

  it("the screen renders the code and never the envelope's message", () => {
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("copy.error[code]");
    expect(screen).toContain("copy.error[view.refusal.code]");
    // `message` on the envelope is developer prose for a log. A screen that
    // rendered it would be a monolingual product with nothing failing.
    expect(screen).not.toContain("refusal.message");
  });
});

/**
 * The absence a static export ships, and the reason it now carries.
 *
 * `web.output` is `static`, so `bun run web:export` prerenders every route.
 * This screen's first render is `replaying` — it reads `GET /v1/replay`, and
 * the plan behind those boxes is scored by the one simulator, which is not in
 * a browser and is not going to be: replay 10 moved the screen off fixtures
 * for exactly that reason and `test/one-execution-rule.test.ts` keeps it
 * there. So the exported HTML is the "Replaying" note and nothing else, and a
 * reader who opens it with no gateway behind it has no way to tell a dead
 * screen from a slow one.
 *
 * The absence therefore states its own reason, which is the courtesy the data
 * side already extends with `band_unavailable_reason` and `UnmeasuredLeadTime`:
 * an absence with a reason is an answer, and an absence without one is a bug
 * report the reader has to write themselves.
 */
describe("the absence names the live API it is waiting for", () => {
  it("the replaying note carries the reason, in both locales", () => {
    for (const catalogue of [EN.app.replay, PT.app.replay]) {
      const sentence: string = catalogue.replayingLive;
      expect(sentence.length).toBeGreaterThan(40);
      // The endpoint, so the reader knows what is missing rather than that
      // "something" is.
      expect(sentence).toContain("/v1/replay");
      // And what it takes to see it: the build-time origin, and the command
      // that puts something at the other end of it.
      expect(sentence).toContain("EXPO_PUBLIC_API_URL");
      expect(sentence).toContain("bun run api");
    }
    // Translated, not copied.
    expect(EN.app.replay.replayingLive).not.toBe(PT.app.replay.replayingLive);
  });

  it("the screen renders it beside the note it explains", () => {
    const screen = sourceWithoutComments(SCREEN);
    expect(screen).toContain("copy.app.replay.replayingLive");
    // In the `replaying` branch — the state the export freezes on — and not
    // somewhere a reader of the exported build would never reach.
    const branch = screen.slice(screen.indexOf('state.status === "replaying"'));
    expect(branch.indexOf("copy.app.replay.replayingLive")).toBeGreaterThan(-1);
    expect(branch.indexOf("copy.app.replay.replayingLive")).toBeLessThan(
      branch.indexOf('state.status === "observedOnly"'),
    );
  });

  it("no fixture-scored plan came back with it", () => {
    const screen = sourceWithoutComments(SCREEN);
    // The absence is explained, never filled. A fixture behind these boxes
    // would be a second execution rule in a browser.
    for (const token of [
      "evaluatePlan",
      "planDispatch",
      "buildReplayDay",
      "replayFixture",
    ]) {
      expect(screen).not.toContain(token);
    }
    expect(screen).toContain("useReplay");
  });
});
