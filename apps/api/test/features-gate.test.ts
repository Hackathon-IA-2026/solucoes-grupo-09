import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURE_ROW_COLUMNS,
  FEATURE_SETS,
  featureGrain,
  GATE_PROFILES,
  isFeatureColumn,
  isLabelColumn,
  servingTargetDate,
} from "../src/features/index.js";

/**
 * The claims that hold before a database is involved.
 *
 * These are structural, and they are the ones that decide whether train/serve
 * skew is *inexpressible* rather than merely absent. A seam test proves that
 * today's rows agree; these prove that a future session cannot write a feature
 * that disagrees — which is the property this spine exists for, because the
 * twelve tickets behind it will each add features and none of them will
 * re-derive the gate.
 *
 * They read the migration's own text. That is unusual and it is deliberate: the
 * function is the artifact, `docs/specs/forecaster.md` hashes its definition
 * into a lane's identity, and there is nothing else to assert against without
 * standing a server up.
 */

/**
 * Every migration that defines part of the feature layer, in migration order.
 *
 * Discovered rather than listed. Ticket 01 wrote one file and the twelve
 * tickets behind it write more — this ticket's is
 * `0017_capacity_at_the_gate.sql` — and a test naming the one file it scans
 * would quietly stop covering the layer on the first one it was not told
 * about. The rule that decides membership is the one the layer is built on: a
 * file that declares a `feature_*` function is part of it.
 */
const FEATURE_MIGRATIONS = readdirSync(join(import.meta.dir, "../drizzle"))
  .filter((name) => name.endsWith(".sql"))
  .toSorted()
  .map((name) => ({
    name,
    text: readFileSync(join(import.meta.dir, "../drizzle", name), "utf8"),
  }))
  .filter((file) => /CREATE OR REPLACE FUNCTION\s+feature_/.test(file.text));

const RAW = FEATURE_MIGRATIONS.map((file) => file.text).join("\n");

/**
 * The SQL with every comment removed.
 *
 * The file is mostly prose — the reasoning is the point — and prose naming a
 * table is not the same event as SQL reading one. Stripping it first is what
 * keeps these assertions about the code.
 */
const SQL = RAW.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/**
 * The SQL with the string literals blanked out too.
 *
 * A `RAISE` message explaining that the gate is derived "from the target date"
 * is not a relation being read, and the scan below would have to believe it
 * was. Names and literals are asserted against `SQL`; what the statements
 * actually touch is asserted against this.
 */
const CODE = SQL.replace(/'[^']*'/g, "''");

/** The ingest tables. None of them may be reachable from a feature. */
const INGEST_TABLES = [
  "curtailment_report_hour",
  "plant_detail_hour",
  "subsystem_energy_balance_hour",
  "subsystem_exchange_hour",
  "dessem_balance_half_hour",
  "weather_forecast_hour",
  "programmed_load_half_hour",
  "generating_unit",
  "reporting_entity",
  "conjunto_membership",
  "centroid_point",
  "plant_geo",
  "siga_snapshot",
  "plant",
];

/**
 * Relations a feature function may name that are neither views nor its own.
 *
 * Two set-returning built-ins and the CTE names of the one query in the file.
 * Small on purpose: this list growing is exactly the review that should happen.
 */
const ALLOWED_RELATIONS = new Set([
  "unnest",
  "generate_series",
  "lateral",
  "spine",
  "weather",
  "capacity",
  "labels",
  // The two arrays the capacity block materialises its own reads into, so the
  // fleet at D and the fleet at D-28 cannot be evaluated under one another's
  // axes. They are local variables, not relations.
  "at_target",
  "at_minus_28",
]);

const functionSegments = (): Map<string, string> => {
  const segments = new Map<string, string>();
  const headers = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)/g)];
  headers.forEach((header, index) => {
    const start = header.index ?? 0;
    const end = headers[index + 1]?.index ?? SQL.length;
    segments.set(header[1] as string, SQL.slice(start, end));
  });
  return segments;
};

describe("the gate, structurally", () => {
  it("reads canonical views and nothing else", () => {
    const relations = [...CODE.matchAll(/\b(?:from|join)\s+([a-z_][\w]*)/gi)].map(
      (match) => (match[1] as string).toLowerCase(),
    );

    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) {
      const allowed =
        relation.startsWith("canonical_") ||
        relation.startsWith("feature_") ||
        ALLOWED_RELATIONS.has(relation);
      expect({ relation, allowed }).toEqual({ relation, allowed: true });
    }
    // Non-vacuous: it really does read the contract.
    expect(relations.some((relation) => relation.startsWith("canonical_"))).toBe(true);
  });

  it("names no ingest table anywhere", () => {
    // The feature function is the one place ONS's conventions would get
    // reimplemented, so it must not be able to see a padded code, an
    // average-power value or an end-of-interval timestamp in the first place.
    for (const table of INGEST_TABLES) {
      expect({ table, found: new RegExp(`\\b${table}\\b`).test(CODE) }).toEqual({
        table,
        found: false,
      });
    }
  });

  it("writes the read axes in four places, all of which derive the instant", () => {
    // A block that could be handed an instant is a block that could be handed
    // the wrong one. `feature_apply_gate` takes a target date and a profile;
    // `feature_apply_label_vintage` takes nothing at all.
    const writers = [...functionSegments()]
      .filter(([, body]) => body.includes("set_config"))
      .map(([name]) => name);

    expect(writers.toSorted()).toEqual([
      "feature_apply_gate",
      "feature_apply_gate_for_fleet_offset",
      "feature_apply_label_vintage",
      "feature_release_axes",
    ]);

    const gate = functionSegments().get("feature_apply_gate") ?? "";
    expect(gate).toContain("gate_at(target_date, gate_profile)");
    expect(
      /FUNCTION\s+feature_apply_gate\(target_date date, gate_profile text\)/.test(gate),
    ).toBe(true);

    // The second writer moves the *valid-time* axis and only that. It takes a
    // whole number of days back from the target date — never a fleet date and
    // never an instant — so the trailing window a capacity addition needs
    // cannot become a second cut-off.
    const offset = functionSegments().get("feature_apply_gate_for_fleet_offset") ?? "";
    expect(offset).toContain("gate_at(target_date, gate_profile)");
    expect(
      /FUNCTION\s+feature_apply_gate_for_fleet_offset\(\s*target_date date, gate_profile text, days_back int\s*\)/.test(
        offset,
      ),
    ).toBe(true);
    expect(offset).toContain("target_date - days_back");
  });

  it("writes every axis on every call, absent ones as the empty string", () => {
    // `contract/scope.ts` property 1, one layer up. A block that wrote only the
    // axes it cared about would inherit the previous block's gate — an answer
    // wrong in a way no test of that block alone could see.
    for (const [name, body] of functionSegments()) {
      if (!body.includes("set_config")) {
        continue;
      }
      for (const axis of [
        "wattsteer.as_of",
        "wattsteer.fleet_date",
        "wattsteer.published_at_or_before",
        "wattsteer.weather_run_cycle",
      ]) {
        expect({ name, axis, written: body.includes(axis) }).toEqual({
          name,
          axis,
          written: true,
        });
      }
    }
  });

  it("offers the caller nowhere to put a cut-off", () => {
    // Every definition of it. A composite type that gains attributes needs the
    // function returning it re-created, so `feature_rows` is written once per
    // ticket that adds a column — and each copy has to hold the same five
    // arguments and no sixth.
    const definitions = [
      ...SQL.matchAll(/CREATE OR REPLACE FUNCTION feature_rows\(/g),
    ].map((match) =>
      SQL.slice(
        match.index ?? 0,
        SQL.indexOf("RETURNS SETOF feature_row", match.index ?? 0),
      ),
    );
    expect(definitions.length).toBeGreaterThan(0);

    for (const signature of definitions) {
      expect(signature.length).toBeGreaterThan(0);

      // The five arguments the spec names, and not one more. `as_of`,
      // `published_at_or_before` and every other instant are absent because the
      // gate is derived per row from `target_date` — so training and serving
      // cannot differ in what they were allowed to see.
      for (const forbidden of [
        "timestamp",
        "as_of",
        "published_at",
        "cutoff",
        "gate_at",
      ]) {
        expect({ forbidden, present: signature.includes(forbidden) }).toEqual({
          forbidden,
          present: false,
        });
      }
      for (const parameter of [
        "target_from date",
        "target_to date",
        "gate_profile text",
        "feature_set text",
        "threshold_mw double precision",
      ]) {
        expect(signature).toContain(parameter);
      }
    }
  });

  it("fails closed on every unresolved argument", () => {
    // Ticket 016's posture, inherited: `canonical_as_of()` raises rather than
    // defaulting to `now()`, because a default turns a forgotten axis into a
    // latest-version read indistinguishable from a correct answer. An
    // unresolved gate is the same hazard one layer up.
    const raises = [...SQL.matchAll(/RAISE EXCEPTION/g)];
    expect(raises.length).toBeGreaterThanOrEqual(7);
    const errcodes = [...SQL.matchAll(/USING ERRCODE = '(\d+)'/g)].map((m) => m[1]);
    expect(new Set(errcodes)).toEqual(new Set(["22023"]));
    expect(errcodes.length).toBe(raises.length);
  });

  it("declares the row shape once, and TypeScript reads it rather than restating it", () => {
    // A second list of column names is a second dictionary. This is the check
    // that the one in `feature-rows.ts` is a copy and not an opinion.
    const body = SQL.slice(
      SQL.indexOf("CREATE TYPE feature_row AS ("),
      SQL.indexOf("CREATE OR REPLACE FUNCTION feature_rows("),
    );
    const declared = body
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]\w*\s/.test(line))
      .map((line) => line.split(/\s+/)[0] as string);

    // …plus what later migrations appended to the same declaration. `ALTER
    // TYPE ... ADD ATTRIBUTE` appends in file order, and that order is what a
    // positional read of the composite gets back.
    const appended = [
      ...SQL.matchAll(/ALTER TYPE feature_row ADD ATTRIBUTE\s+([a-z_]\w*)/g),
    ].map((match) => match[1] as string);

    expect([...declared, ...appended]).toEqual([...FEATURE_ROW_COLUMNS]);
    // Non-vacuous: a ticket really did add columns to the one declaration
    // rather than restating the shape.
    expect(appended.length).toBeGreaterThan(0);
  });

  it("knows both gate profiles and both feature sets, and no third of either", () => {
    for (const profile of GATE_PROFILES) {
      expect(SQL).toContain(`'${profile}'`);
    }
    for (const set of FEATURE_SETS) {
      expect(SQL).toContain(`'${set}'`);
    }
    // D-1 09:00 and D-1 19:00, Brasília, by full IANA name and never a fixed
    // offset: the fixed offset is right today and was wrong every summer
    // before 2019.
    expect(SQL).toContain("WHEN 'gate_early' THEN 9");
    expect(SQL).toContain("WHEN 'gate_late' THEN 19");
    expect(SQL).toContain("America/Sao_Paulo");
    expect(SQL).not.toContain("-03");
  });
});

describe("the feature/label partition", () => {
  it("puts every column in exactly one of the three categories", () => {
    for (const column of FEATURE_ROW_COLUMNS) {
      const categories = [isLabelColumn(column), isFeatureColumn(column)].filter(Boolean);
      // A stamp is neither; anything else is exactly one.
      expect(categories.length).toBeLessThanOrEqual(1);
    }
    // The partition is not vacuous in either direction.
    expect(FEATURE_ROW_COLUMNS.filter(isLabelColumn).length).toBeGreaterThan(0);
    expect(FEATURE_ROW_COLUMNS.filter(isFeatureColumn)).toEqual([
      "weather_temperature_2m",
      "capacity_wind_mw",
      "capacity_solar_mw",
      "capacity_wind_added_28d_mw",
      "capacity_solar_added_28d_mw",
    ]);
  });

  it("treats an unheard-of column as a feature, not as an exception", () => {
    // The gate-ablation seam covers columns it was never told about, which is
    // the only reason it can catch a leak nobody anticipated.
    expect(isFeatureColumn("dessem_residual_load_mwh")).toBe(true);
    expect(isFeatureColumn("observed_constrained_off_lag_168h")).toBe(true);
    expect(isFeatureColumn("y_something_new")).toBe(false);
  });
});

describe("the feature dictionary's grain marking", () => {
  it("marks the capacity columns day grain, and everything else hourly", () => {
    // A column constant within a day must not be read as an hourly signal, and
    // that is invisible in the data: twenty-four equal numbers look exactly
    // like a flat hourly series. The marking is the only thing that
    // distinguishes them.
    for (const column of FEATURE_ROW_COLUMNS) {
      expect({ column, grain: featureGrain(column) }).toEqual({
        column,
        grain: column.startsWith("capacity_") ? "day" : "hour",
      });
    }
    expect(
      FEATURE_ROW_COLUMNS.filter((column) => featureGrain(column) === "day"),
    ).toEqual([
      "capacity_wind_mw",
      "capacity_solar_mw",
      "capacity_wind_added_28d_mw",
      "capacity_solar_added_28d_mw",
    ]);
  });

  it("says so in the catalogue too, at the column itself", () => {
    // The copy that travels with the number. A caveat a modeller cannot find
    // from the column is a caveat nobody applies, so the day grain and the
    // `revision_optimistic` reason are stated in `COMMENT ON COLUMN` as well as
    // in the spec and in `featureGrain`.
    for (const column of ["capacity_wind_mw", "capacity_solar_mw"]) {
      const comment = RAW.slice(
        RAW.indexOf(`COMMENT ON COLUMN feature_row.${column} IS`),
      ).slice(0, 600);
      expect(comment).toContain("Day grain");
      expect(comment).toContain("revision_optimistic");
    }
    for (const column of ["capacity_wind_added_28d_mw", "capacity_solar_added_28d_mw"]) {
      const comment = RAW.slice(
        RAW.indexOf(`COMMENT ON COLUMN feature_row.${column} IS`),
      ).slice(0, 600);
      expect(comment).toContain("Day grain");
    }
  });
});

describe("servingTargetDate", () => {
  it("asks for tomorrow in Brasília, not tomorrow in UTC", () => {
    // 01:30Z on the 30th is 22:30 on the 29th in Brasília — inside gate_late's
    // working evening — so a UTC reading would serve the wrong day for three
    // hours every night.
    expect(servingTargetDate(new Date("2026-08-30T01:30:00.000Z"))).toBe("2026-08-30");
    expect(servingTargetDate(new Date("2026-08-29T15:00:00.000Z"))).toBe("2026-08-30");
  });

  it("renders the shape a date argument wants", () => {
    expect(servingTargetDate(new Date("2026-12-31T12:00:00.000Z"))).toBe("2027-01-01");
  });
});
