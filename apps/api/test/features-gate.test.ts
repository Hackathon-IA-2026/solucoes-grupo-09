import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_GENERATOR,
  CALENDAR_VERSION,
  FEATURE_ROW_COLUMNS,
  FEATURE_SETS,
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
 * Every hand-written migration that creates a feature function — **discovered,
 * not listed**.
 *
 * Ticket 01 read one file. That was right for one file and would be quietly
 * wrong for two: a ticket adding a block in a new migration would inherit none
 * of these assertions, and the one that matters — that a feature reads canonical
 * views and nothing else — is exactly the one a new block is most likely to
 * break. So the set is derived from the tree by asking which migrations declare
 * a `feature_` function, and it grows on its own as the twelve tickets land.
 *
 * The generated migrations are *not* in it, and must not be: a canonical view
 * names ingest tables by definition — that is what a view is for — and the
 * scans below are about what a **feature** may reach through them.
 */
const MIGRATION_DIRECTORY = join(import.meta.dir, "../drizzle");
const featureMigrations = (): string[] =>
  readdirSync(MIGRATION_DIRECTORY)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()
    .filter((name) =>
      readFileSync(join(MIGRATION_DIRECTORY, name), "utf8").includes(
        "CREATE OR REPLACE FUNCTION feature_",
      ),
    );

const MIGRATIONS = featureMigrations();
const RAW = MIGRATIONS.map((name) =>
  readFileSync(join(MIGRATION_DIRECTORY, name), "utf8"),
).join("\n");

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
const CODE = SQL.replace(/'[^']*'/g, "''")
  // `extract(hour from x)` is not a relation being read, and the scan below
  // matches on `from`. Blanking the field name keeps the scan about what the
  // statements touch rather than about SQL's one keyword with two jobs.
  .replace(/\bextract\s*\(\s*\w+\s+from\b/gi, "extract(");

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
  "labels",
  // Ticket 03's CTEs: the calendar and share blocks, and the four steps the
  // solar geometry is spelled out in.
  "calendar",
  "shares",
  "hours",
  "solar",
  "geometry",
  "sun_position",
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

  it("writes the read axes in three places, all of which derive the instant", () => {
    // A block that could be handed an instant is a block that could be handed
    // the wrong one. `feature_apply_gate` takes a target date and a profile;
    // `feature_apply_label_vintage` takes nothing at all.
    const writers = [...functionSegments()]
      .filter(([, body]) => body.includes("set_config"))
      .map(([name]) => name);

    expect(writers.toSorted()).toEqual([
      "feature_apply_gate",
      "feature_apply_label_vintage",
      "feature_release_axes",
    ]);

    const gate = functionSegments().get("feature_apply_gate") ?? "";
    expect(gate).toContain("gate_at(target_date, gate_profile)");
    expect(
      /FUNCTION\s+feature_apply_gate\(target_date date, gate_profile text\)/.test(gate),
    ).toBe(true);
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
    // Every definition of it, not the first: `feature_rows` is restated in full
    // by each migration that adds columns — a function body cannot be patched —
    // and a restatement is exactly where a parameter could be smuggled in.
    const definitions = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION feature_rows\(/g)];
    const signatures = definitions.map((match) => {
      const start = match.index ?? 0;
      return SQL.slice(start, SQL.indexOf("RETURNS SETOF feature_row", start));
    });
    expect(signatures.length).toBeGreaterThan(1);
    const signature = signatures.join("\n");
    expect(signature.length).toBeGreaterThan(0);

    // The five arguments the spec names, and not one more. `as_of`,
    // `published_at_or_before` and every other instant are absent because the
    // gate is derived per row from `target_date` — so training and serving
    // cannot differ in what they were allowed to see.
    for (const forbidden of ["timestamp", "as_of", "published_at", "cutoff", "gate_at"]) {
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
  });

  it("gives no feature block an instant to resolve against", () => {
    // The wall, restated for every block a later ticket adds. A block takes a
    // target date — and a gate profile where it reads something carrying a
    // vintage — and never a timestamp: there is no argument through which a
    // hand-chosen cut-off could arrive, so a feature that resolves against one
    // cannot be written, only imagined.
    //
    // `feature_vintage_fidelity` is not a block and is not covered here: it is
    // two timestamps and an inequality, it reads nothing, and both arguments
    // come from the row being stamped rather than from a caller.
    const blocks = [
      ...SQL.matchAll(/CREATE OR REPLACE FUNCTION (feature_\w*_block)\(([^)]*)\)/g),
    ];
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      const name = block[1] as string;
      const parameters = block[2] as string;
      for (const forbidden of ["timestamp", "as_of", "published_at", "cutoff"]) {
        expect({ name, forbidden, present: parameters.includes(forbidden) }).toEqual({
          name,
          forbidden,
          present: false,
        });
      }
      expect(parameters).toContain("target_date date");
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
    //
    // The declaration has two halves now and will have more: `CREATE TYPE` in
    // `0016`, then one `ALTER TYPE ... ADD ATTRIBUTE` per column each later
    // ticket adds. `ADD ATTRIBUTE` appends, so migration order *is* attribute
    // order — which is why the files are read in name order and the attributes
    // in the order they appear.
    const body = SQL.slice(
      SQL.indexOf("CREATE TYPE feature_row AS ("),
      SQL.indexOf("CREATE OR REPLACE FUNCTION feature_rows("),
    );
    const created = body
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]\w*\s/.test(line))
      .map((line) => line.split(/\s+/)[0] as string);
    const added = [...SQL.matchAll(/ALTER TYPE feature_row ADD ATTRIBUTE\s+(\w+)/g)].map(
      (match) => match[1] as string,
    );

    expect([...created, ...added]).toEqual([...FEATURE_ROW_COLUMNS]);
    // Non-vacuous: the row really did grow past ticket 01's declaration.
    expect(added.length).toBeGreaterThan(0);
  });

  it("names one calendar version, and the three copies of it agree", () => {
    // "Whichever calendar is newest" is exactly the silent restatement the
    // materialisation exists to prevent, so the SQL reads the table under a
    // literal. A literal in three languages is a constant that can drift, and
    // this is where it cannot: `calendar.ts` here, `calendar_generator.py` in
    // `apps/ml`, and the migration's own text.
    expect(SQL).toContain(`'${CALENDAR_VERSION}'`);
    const versions = new Set(
      [...SQL.matchAll(/'(br_calendar_v\d+)'/g)].map((match) => match[1] as string),
    );
    expect([...versions]).toEqual([CALENDAR_VERSION]);

    const python = readFileSync(
      join(import.meta.dir, "../../ml/src/wattsteer_ml/calendar_generator.py"),
      "utf8",
    );
    expect(python).toContain(`CALENDAR_VERSION = "${CALENDAR_VERSION}"`);
    expect(python).toContain(`GENERATOR = "${CALENDAR_GENERATOR}"`);
  });

  it("computes the calendar features in Brasília and the astronomy in UTC", () => {
    // The spec's timezone rule, in the one file that could break it: calendar
    // features come from the local rendering and everything else is UTC. The
    // sun does not observe civil time, so a solar hour angle built from the
    // local wall clock would be wrong by the offset — three hours, which is
    // 45 degrees of hour angle and the difference between noon and mid-morning.
    const calendar = functionSegments().get("feature_calendar_block") ?? "";
    expect(calendar).toContain("AT TIME ZONE 'America/Sao_Paulo'");
    expect(calendar).toContain("AT TIME ZONE 'UTC'");
    // 365.25, never 365: an encoding on a 365-day period leaves 29 February a
    // day out of phase with every other year in the window.
    expect(calendar).toContain("365.25");
  });

  it("keeps month and week_of_year out of the row", () => {
    // Dropped as redundant with the day-of-year encoding — a coarser
    // quantisation of the same axis, adding split points without information.
    // Asserted rather than trusted, because "available and redundant" is the
    // kind of decision a later session repairs helpfully.
    for (const column of FEATURE_ROW_COLUMNS) {
      expect(column).not.toBe("calendar_month");
      expect(column).not.toBe("calendar_week_of_year");
    }
    expect(SQL).not.toMatch(/\bweek_of_year\b/);
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
      "calendar_local_hour",
      "calendar_hour_sin",
      "calendar_hour_cos",
      "calendar_doy_sin",
      "calendar_doy_cos",
      "calendar_day_of_week",
      "calendar_is_weekend",
      "calendar_is_holiday_national",
      "calendar_holiday_state_share",
      "calendar_is_day_before_holiday",
      "calendar_is_bridge_day",
      "solar_zenith_cos",
      "solar_extraterrestrial_ghi",
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
