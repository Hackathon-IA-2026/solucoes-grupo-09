import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveKey,
  createDirectoryArchive,
  createPayloadArchive,
  type IngestTask,
  payloadSha256,
  periodLabelOf,
  planRefresh,
  REFRESH_CADENCE,
  sourceOf,
} from "../src/ingest/index.js";

// Seam — the refresh policy and the archive, both asserted without a database,
// a network or a queue. The tiering is the most consequential policy in the
// platform and `planRefresh` is a pure function of the clock precisely so that
// "closed history is swept" can be a fact about the policy rather than about a
// deployment nobody is watching.

/** A fixed instant, mid-month, so period arithmetic has nothing to hide behind. */
const NOW = new Date("2026-08-28T12:00:00.000Z");

const months = (tasks: IngestTask[], technology: "WIND" | "SOLAR"): string[] =>
  tasks
    .filter(
      (task) => task.kind === "constrained_off" && task.payload.technology === technology,
    )
    .map((task) => periodLabelOf(task) ?? "");

const years = (tasks: IngestTask[]): number[] =>
  tasks
    .filter((task) => task.kind === "energy_balance")
    .map((task) => (task.kind === "energy_balance" ? task.payload.year : 0))
    .sort((a, b) => a - b);

describe("refresh plan · tiers", () => {
  const live = planRefresh({ tier: "live", now: NOW });
  const recent = planRefresh({ tier: "recent", now: NOW });
  const history = planRefresh({ tier: "history", now: NOW });

  it("re-fetches the open periods every cycle", () => {
    expect(months(live, "WIND")).toEqual(["2026-08", "2026-07"]);
    expect(years(live)).toEqual([2025, 2026]);
    // The registry is overwritten twice a day and yesterday's cut is gone, so
    // it belongs in the tier that runs every cycle even with no period at all.
    expect(live.some((task) => task.kind === "plant_registry")).toBe(true);
  });

  it("sweeps recently closed periods on the weekly tier", () => {
    expect(months(recent, "WIND")).toEqual(["2026-06", "2026-05", "2026-04"]);
    expect(years(recent)).toEqual([2023, 2024]);
    expect(recent.some((task) => task.kind === "plant_registry")).toBe(false);
  });

  it("sweeps every closed month back to coverage start", () => {
    const wind = months(history, "WIND");
    // The month the research recorded as rewritten in May 2024, 2.5 years after
    // it closed. If the history sweep does not plan it, nothing ever catches
    // that campaign.
    expect(wind).toContain("2021-10");
    expect(wind[0]).toBe("2021-10");
    expect(wind.at(-1)).toBe("2026-03");
    expect(years(history)[0]).toBe(2000);
    expect(years(history).at(-1)).toBe(2022);
  });

  it("never plans a period before its dataset covers it", () => {
    // Solar constrained-off starts 2024-04; a plan that asked for 2021 would
    // spend a request per month to be told 404 for three years.
    expect(months(history, "SOLAR").every((month) => month >= "2024-04")).toBe(true);
    expect(months(history, "SOLAR")[0]).toBe("2024-04");
  });

  it("covers each period in exactly one tier", () => {
    const all = [
      ...months(live, "WIND"),
      ...months(recent, "WIND"),
      ...months(history, "WIND"),
    ];
    expect(new Set(all).size).toBe(all.length);
    const allYears = [...years(live), ...years(recent), ...years(history)];
    expect(new Set(allYears).size).toBe(allYears.length);
  });

  it("takes one rolling slice of carga history per pass", () => {
    // The one source with no cheap "nothing moved" probe: re-fetching a decade
    // of half-hourly load every month to learn that nothing moved is exactly
    // what the tiering exists to prevent.
    const slices = history.filter((task) => task.kind === "load");
    expect(slices).toHaveLength(2); // one per series
    expect(periodLabelOf(slices[0] as IngestTask)).toMatch(
      /^\d{4}-01-01\.\.\d{4}-12-31$/,
    );

    const first = periodLabelOf(
      planRefresh({ tier: "history", now: NOW, historySlice: 0 }).filter(
        (task) => task.kind === "load",
      )[0] as IngestTask,
    );
    const second = periodLabelOf(
      planRefresh({ tier: "history", now: NOW, historySlice: 1 }).filter(
        (task) => task.kind === "load",
      )[0] as IngestTask,
    );
    expect(first).not.toBe(second);
  });

  it("runs the slow tier slowest", () => {
    expect(REFRESH_CADENCE.live).toBe("17 * * * *");
    expect(REFRESH_CADENCE.recent.endsWith("* * 1")).toBe(true);
    expect(REFRESH_CADENCE.history.includes(" 1 * *")).toBe(true);
  });

  it("plans the SIGA snapshot exactly where the registry snapshot goes", () => {
    // SIGA is a daily extract overwritten in place with no upstream archive, so
    // it is the registry's twin: the every-cycle tier, and no period at all.
    expect(live.some((task) => task.kind === "siga")).toBe(true);
    expect(recent.some((task) => task.kind === "siga")).toBe(false);
    expect(history.some((task) => task.kind === "siga")).toBe(false);
    expect(periodLabelOf({ kind: "siga", payload: {} })).toBeNull();
    expect(sourceOf({ kind: "siga", payload: {} })).toBe("siga");
  });

  describe("weather · the tiers re-based from volatility to coverage", () => {
    const window = (tasks: IngestTask[]) => {
      const task = tasks.find((candidate) => candidate.kind === "weather");
      return task?.kind === "weather" ? task.payload : null;
    };

    it("takes the publication edge every cycle — today and tomorrow", () => {
      // Tomorrow is the point: its runs initialise *today*, so D+1 is the
      // newest day the archive can answer at all.
      expect(window(live)).toMatchObject({ from: "2026-08-28", to: "2026-08-29" });
      // Both cycles, always. 00Z buys notice and 12Z is measurably better; the
      // job stores them as two vintages of the same hours.
      expect(window(live)?.runCycles).toEqual(["00Z", "12Z"]);
    });

    it("re-asks the recent fortnight, where fallbacks and late runs cluster", () => {
      expect(window(recent)).toMatchObject({ from: "2026-08-14", to: "2026-08-27" });
    });

    it("takes a rolling slice of the bounded archive on the slow tier", () => {
      // The archive starts 2024-03-14 and a target day is served by D−1 runs,
      // so the first day that can be asked for is 2024-03-15. A pass that asked
      // earlier would spend two calls to be told the archive begins tomorrow.
      const first = window(planRefresh({ tier: "history", now: NOW, historySlice: 0 }));
      expect(first?.from).toBe("2024-03-15");
      expect(first?.to).toBe("2024-06-12");

      const second = window(planRefresh({ tier: "history", now: NOW, historySlice: 1 }));
      expect(second?.from).toBe("2024-06-13");
      expect(second?.from).not.toBe(first?.from);
    });

    it("leaves no day uncovered between the tiers", () => {
      // live starts the day after recent ends, and recent the day after the
      // last history slice. A gap here is a day nothing would ever backfill.
      expect(window(recent)?.to).toBe("2026-08-27");
      expect(window(live)?.from).toBe("2026-08-28");
      const lastSlice = window(
        planRefresh({ tier: "history", now: NOW, historySlice: 9 }),
      );
      expect(lastSlice?.to).toBe("2026-08-13");
    });

    it("labels the run by target day, and logs it against its own source", () => {
      const task = live.find((candidate) => candidate.kind === "weather") as IngestTask;
      expect(periodLabelOf(task)).toBe("2026-08-28..2026-08-29");
      expect(sourceOf(task)).toBe("weather");
    });
  });

  it("names the source a run is logged against, not the ingestor", () => {
    // Wind and solar share one ingestor; an operator watching for a source that
    // went quiet needs solar to be visibly quiet while wind is still running.
    expect(
      sourceOf({
        kind: "constrained_off",
        payload: { technology: "SOLAR", year: 2026, month: 8 },
      }),
    ).toBe("constrained_off_solar");
    expect(
      sourceOf({
        kind: "load",
        payload: { series: "PROGRAMMED", from: "2026-01-01", to: "2026-01-02" },
      }),
    ).toBe("programmed_load");
  });
});

describe("payload archive · custody of the bytes", () => {
  it("addresses a payload by its content, sharded", () => {
    const key = archiveKey({
      family: "bulk",
      datasetSlug: "restricao_coff_eolica_usi",
      contentSha256: "abcdef0123456789",
      extension: "csv",
    });
    expect(key).toBe("bulk/restricao_coff_eolica_usi/ab/abcdef0123456789.csv");
  });

  it("round-trips bytes and is idempotent under a repeated put", async () => {
    const root = await mkdtemp(join(tmpdir(), "wattsteer-archive-"));
    try {
      const archive = createDirectoryArchive(root);
      const bytes = new TextEncoder().encode("id_subsistema;val\nNE;1\n");
      const key = archiveKey({
        family: "bulk",
        datasetSlug: "demo",
        contentSha256: payloadSha256(bytes),
        extension: "csv",
      });

      await archive.put(key, bytes);
      await archive.put(key, bytes);
      const read = await archive.get(key);
      expect(read).not.toBeNull();
      expect(new TextDecoder().decode(read as Uint8Array)).toBe(
        "id_subsistema;val\nNE;1\n",
      );

      await archive.remove(key);
      expect(await archive.get(key)).toBeNull();
      // Retention re-runs over rows it has already purged; a second remove must
      // not be an error.
      await archive.remove(key);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a key that would escape the archive root", async () => {
    const root = await mkdtemp(join(tmpdir(), "wattsteer-archive-"));
    try {
      const archive = createDirectoryArchive(root);
      expect(archive.get("../../etc/passwd")).rejects.toThrow(/escapes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is undefined rather than silently discarding when unconfigured", () => {
    // A no-op archive would let a deployment believe for a year that it was the
    // custodian of its own history. The vintages it did not keep are gone from
    // ONS too, so the failure has to be visible at boot.
    expect(createPayloadArchive({})).toBeUndefined();
    expect(createPayloadArchive({ directory: "/tmp/wattsteer" })?.kind).toBe("directory");
  });
});
