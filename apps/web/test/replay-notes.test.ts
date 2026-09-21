import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Replay } from "@wattsteer/core/api";
import { decodeWire } from "@wattsteer/core/wire";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { formattersFor } from "../src/i18n/format";
import {
  compareRows,
  dayLabel,
  provenanceNote,
  vintageExtent,
  vintageNote,
} from "../src/i18n/replay";
import {
  INGESTION_GO_LIVE,
  type ReplayCandidateDay,
  subsystemMeta,
} from "../src/lib/fixtures";

/**
 * What the Time Machine says about a replayed day, asserted as values.
 *
 * Every rule here used to be a grep. The functions lived in `app/replay.tsx`
 * and none of them was exported, so `replay-screen.test.ts` could only reach
 * them as source text: "the provenance statement and the vintage statement are
 * two, never merged" was `expect(screen).toContain("provenanceNote")`, which
 * passes whatever the function returns and passes equally if both notes render
 * the same sentence; "the denominator is the day, not the episode" was a slice
 * of the file between two `function` keywords, and it broke when a function was
 * moved rather than when a denominator changed.
 *
 * The greps that survive in that file are the ones that are honestly about
 * absences — the deleted `IN-SAMPLE` branch, the band that is never rebuilt.
 * These are about what a reader is told, so they are run rather than read.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const EXAMPLE: Replay = decodeWire(
  "Replay",
  JSON.parse(
    readFileSync(
      join(ROOT, "packages", "core", "fixtures", "spec-examples", "12-replay.json"),
      "utf8",
    ),
  ),
) as Replay;

const F = formattersFor("en");

/** The published example, with one branch of `integrity` swapped. */
function withIntegrity(over: Partial<Replay["integrity"]>): Replay {
  return { ...EXAMPLE, integrity: { ...EXAMPLE.integrity, ...over } };
}

describe("the provenance sentence names the artifact that held the day out", () => {
  it("a served day cites the publication instant and no fold", () => {
    // `held_out_by: null` is the contract's own shape here rather than a
    // missing value: a forecast published before the day began needs no fold
    // to make it a counterfactual.
    const note = provenanceNote(withIntegrity({ heldOutBy: null }), EN, F);
    expect(note).toContain(F.dateTime(EXAMPLE.forecastOrigin.publishedAt));
    expect(note).not.toContain("{");
  });

  it("a fold-holdout day names the fold, the artifact and BOTH windows", () => {
    // The calibration window is where the isotonic fit and the two conformal
    // scalars were fitted, so a day inside it would have shaped the interval
    // this screen promises a floor from. Naming only the training block would
    // be a true sentence that leaves out the half that matters.
    const heldOut = {
      fold: "f3",
      artifactId: "dessem_free_v1__gate_early__thr5@f3",
      trainWindow: ["2025-01-01", "2025-06-30"] as [string, string],
      calibrationWindow: ["2025-07-01", "2025-07-31"] as [string, string],
    };
    const note = provenanceNote(withIntegrity({ heldOutBy: heldOut }), EN, F);
    expect(note).toContain("f3");
    expect(note).toContain(heldOut.artifactId);
    expect(note).toContain(F.date("2025-01-01"));
    expect(note).toContain(F.date("2025-06-30"));
    expect(note).toContain(F.date("2025-07-01"));
    expect(note).toContain(F.date("2025-07-31"));
    expect(note).not.toContain("{");
  });

  it("there is no third branch, and no in-sample wording in either", () => {
    for (const copy of [EN, PT]) {
      for (const heldOutBy of [
        null,
        {
          fold: "f1",
          artifactId: "a",
          trainWindow: ["2025-01-01", "2025-02-01"] as [string, string],
          calibrationWindow: ["2025-02-02", "2025-02-28"] as [string, string],
        },
      ]) {
        expect(provenanceNote(withIntegrity({ heldOutBy }), copy, F)).not.toMatch(
          /in.?sample|na.?amostra/i,
        );
      }
    }
  });
});

describe("provenance and vintage are two statements, neither derived from the other", () => {
  it("they coincide on the published example and are still different sentences", () => {
    // The whole argument for keeping them apart: `fold_holdout` +
    // `point_in_time` becomes populated the moment F6 freezes, and a screen
    // that had collapsed them would have to grow the branch back.
    const provenance = provenanceNote(EXAMPLE, EN, F);
    const vintage = vintageNote(EXAMPLE.vintageFidelity, EN, F);
    expect(provenance).not.toBe(vintage);
    expect(provenance.length).toBeGreaterThan(0);
    expect(vintage.length).toBeGreaterThan(0);
  });

  it("the vintage sentence turns on go-live and names it", () => {
    const optimistic = vintageNote("revision_optimistic", EN, F);
    const pointInTime = vintageNote("point_in_time", EN, F);
    expect(optimistic).not.toBe(pointInTime);
    for (const note of [optimistic, pointInTime]) {
      expect(note).toContain(F.date(INGESTION_GO_LIVE));
      expect(note).not.toContain("{");
    }
  });
});

describe("the size of the vintage caveat is stated, never implied", () => {
  it("an unmeasured premium is the word, never a zero", () => {
    // A caveat whose size is not stated reads as a caveat that is small, and a
    // `0` would read as no caveat at all.
    const lines = vintageExtent(
      withIntegrity({
        vintageFidelity: "revision_optimistic",
        revisionPremiumRecoveredMwh: null,
      }).integrity,
      EN,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(EN.app.replay.revisionPremiumUnmeasured);
    expect(lines[1]).not.toMatch(/\b0\b/);
  });

  it("a measured premium carries its number", () => {
    const lines = vintageExtent(
      withIntegrity({
        vintageFidelity: "revision_optimistic",
        revisionPremiumRecoveredMwh: 12.5,
      }).integrity,
      EN,
    );
    expect(lines[1]).toContain("12.5");
  });

  it("a point-in-time day gets nothing at all", () => {
    // Not an empty caveat, and not a sentence saying there is none: a
    // reassurance printed beside the honest case makes it look qualified.
    expect(
      vintageExtent(withIntegrity({ vintageFidelity: "point_in_time" }).integrity, EN),
    ).toEqual([]);
  });

  it("the parts are spelled from the response, and an unknown one falls through", () => {
    // `vintage_affects` is the service's list. This map only spells it, so a
    // part the service stops claiming stops being named without an edit here —
    // and a part it starts claiming appears as its code rather than vanishing.
    const lines = vintageExtent(
      withIntegrity({
        vintageFidelity: "revision_optimistic",
        vintageAffects: ["settled_actuals", "a_part_nobody_has_translated"],
        vintageExempt: ["weather_run"],
      }).integrity,
      EN,
    );
    expect(lines[0]).toContain(EN.app.replay.vintagePart.settled_actuals);
    expect(lines[0]).toContain("a_part_nobody_has_translated");
    expect(lines[0]).toContain(EN.app.replay.vintagePart.weather_run);
  });
});

describe("the comparison rows read the day, never the episode", () => {
  const rows = compareRows(EXAMPLE, EN, F);

  it("three rows, in the order the argument is made", () => {
    expect(rows.map((row) => row.key)).toEqual(["actual", "forecast", "remaining"]);
  });

  it("the actual is the whole local day, not the episode above the threshold", () => {
    // They differ in the published example, which is why this is worth a test:
    // a share taken over the episode would improve simply for having drawn the
    // episode more tightly.
    const episode = EXAMPLE.episodes[0];
    expect(episode).toBeDefined();
    expect(rows[0]?.value).toBe(EXAMPLE.actual.totalMwh);
    expect(rows[0]?.value).not.toBe(episode?.totalMwh);
  });

  it("the forecast row carries the joint band and no value of its own", () => {
    // `forecast.day_total` off the payload. Adding 24 hourly P90s assumes every
    // hour lands at its 90th percentile together, which describes a far worse
    // day; `test/no-summed-bands.test.ts` is the repository-wide guard and this
    // is the local one, on the value rather than on the source.
    expect(rows[1]?.band).toEqual(EXAMPLE.forecast.dayTotal);
    expect(rows[1]?.value).toBeUndefined();
  });

  it("the remaining row is what the contract says is left, not a subtraction", () => {
    expect(rows[2]?.value).toBe(EXAMPLE.optimizedCurtailmentMwh);
  });

  it("the actual's note describes the episode, and is omitted when there is none", () => {
    // The one honest use of an episode total is on the episode, and the note is
    // where it belongs. A day with no episode gets no note rather than a note
    // about a zero-hour one.
    expect(rows[0]?.note).toBeDefined();
    const noEpisodes = compareRows({ ...EXAMPLE, episodes: [] }, EN, F);
    expect(noEpisodes[0]?.note).toBeUndefined();
    expect(noEpisodes[0]?.value).toBe(EXAMPLE.actual.totalMwh);
  });

  it("every row resolves in both catalogues, with no placeholder left", () => {
    for (const copy of [EN, PT]) {
      for (const row of compareRows(EXAMPLE, copy, F)) {
        expect(row.label).not.toContain("{");
        expect(row.note ?? "").not.toContain("{");
      }
    }
  });
});

describe("a replayed day's name is a date and a subsystem, and nothing else", () => {
  it("no technology, because the forecast behind the day does not make that division", () => {
    const day = { date: "2025-09-14", subsystem: "NE" } as ReplayCandidateDay;
    const label = dayLabel(day, EN, F);
    expect(label).toContain(F.date("2025-09-14"));
    // ONS's own spelling of its own subsystem, read off the map rather than
    // retyped: the label is the operator's vocabulary, not ours.
    expect(label).toContain(subsystemMeta("NE").onsDisplayName);
    expect(label).not.toMatch(/wind|solar|eólic|eolic/i);
    expect(label).not.toContain("{");
  });
});
