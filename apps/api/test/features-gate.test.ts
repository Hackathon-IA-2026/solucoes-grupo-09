import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_GENERATOR,
  CALENDAR_VERSION,
  FEATURE_ROW_COLUMNS,
  FEATURE_SETS,
  featureGrain,
  GATE_PROFILES,
  isFeatureColumn,
  isLabelColumn,
  servingTargetDate,
} from "../src/features/index.js";
import { PROGRAMME_PUBLICATION_HOUR_BRT } from "../src/ingest/ons/load.js";
import { CENTROID_SET_VERSION } from "../src/ingest/weather/centroids.js";

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
  "capacity",
  "labels",
  // The two arrays the capacity block materialises its own reads into, so the
  // fleet at D and the fleet at D-28 cannot be evaluated under one another's
  // axes. They are local variables, not relations.
  "at_target",
  "at_minus_28",
  // Ticket 03's CTEs: the calendar and share blocks, and the four steps the
  // solar geometry is spelled out in.
  "calendar",
  "shares",
  "hours",
  "solar",
  "geometry",
  "sun_position",
  // Ticket 05's CTEs: the class-`K` block, and the seven windows it reads the
  // three observation series through. Every one of them is bounded by
  // `actuals_cutoff`, which is what the ablation seam checks and what these
  // names exist to keep in one place.
  "lagged",
  "curtailment_hours",
  "curtailment_same_hour",
  "curtailment_window",
  "reason_shares",
  "context_hours",
  "context_window",
  "exchange_hours",
  "fleet_capacity",
  // Ticket 06's CTEs: the class-`P` block reads the day-ahead programme once
  // and derives every shape feature from that one read, so there are two.
  "programmed",
  "profile",
  "shaped",
  // Ticket 07's CTEs: the class-`D` block reads the balance once, names the
  // identities once in `derived`, and derives the two cross-subsystem terms
  // from that same read rather than from a second one.
  "dessem",
  "derived",
  "system_hour",
  "absorber",
  // Ticket 08's CTEs: the class-`W` block reads the weight vectors once
  // (`basis`), the run profile once (`points`) over a widened hour set
  // (`profile_hours`), crosses the two into a spine that exists before the
  // weather is joined (`hour_spine`), and then derives the weighted means
  // (`aggregated`), the two conversions (`converted`) and the profile shapes
  // (`shaped`, shared with the two blocks above) from that one read.
  // `extraterrestrial` is the clearness index's denominator, read back through
  // the block that owns it rather than recomputed here.
  "basis",
  "profile_hours",
  "points",
  "hour_spine",
  "aggregated",
  "converted",
  "extraterrestrial",
  // Ticket 09's CTEs: the proxy block joins the three terms once (`terms`) and
  // derives the reconstruction, the two ratios, the surplus and the profile
  // shapes (`shaped`, shared with the three blocks above) from that one join.
  // `proxy` is its CTE in `feature_rows`. There is no read here to allow: the
  // block composes two blocks and names no view at all.
  "terms",
  "proxy",
  // Ticket 10's CTEs. The estimator reads the trailing year once
  // (`trailing_year`), unfolds each stored link into both directions
  // (`directed`) and quantiles them (`estimated`); the block reads the seven-day
  // window once (`exchange_window`), unfolds it the same way (`directed_hours`)
  // and derives the subsystem's export (`export_hours`) and the three ratios
  // (`subsystem_capability`, `export_utilisation`, `corridor_utilisation`) from
  // that one read. `corridor` is the set of directed corridors that have an
  // estimate, and everything joins through it so a short sample contributes to
  // no numerator and to no denominator. `utilisation` is its CTE in
  // `feature_rows`.
  "trailing_year",
  "directed",
  "estimated",
  "corridor",
  "subsystem_capability",
  "exchange_window",
  "directed_hours",
  "export_hours",
  "export_utilisation",
  "corridor_utilisation",
  "utilisation",
  // Ticket 11's two, and the only catalogue reads in the tree. The dictionary
  // is *derived* from `feature_row` rather than hand-listed — the names, the
  // order, the SQL types and the prose all come from `pg_attribute` and
  // `col_description` — so it has to read the catalogue to exist at all. These
  // two are allowed for that one function and are the reason this list is
  // reviewed rather than assumed: a feature *value* read out of `pg_catalog`
  // would be a very different event, and there is none.
  "pg_attribute",
  "pg_type",
  // Data-platform 20's catalogue walk, and the second — and last — reason this
  // list has catalogue relations in it. `canonical_read_source()` derives which
  // base table each canonical read reads under an ingestion axis from
  // `pg_depend` over each view's `pg_rewrite` rule, and
  // `feature_source_go_live()` narrows that to the views the `feature_%`
  // functions' own source names, which is what `pg_proc` is for. Both live in a
  // migration that also creates feature functions, so this scan sees them.
  //
  // They are allowed for the same reason `pg_attribute` and `pg_type` are: the
  // set of reads is *derived* rather than listed, and a rule that finds the
  // reads has to be able to look. A feature **value** read out of `pg_catalog`
  // would be a very different event, and there is still none: every relation
  // below is read to answer "which tables exist and who reads them", never
  // "what did that table say".
  "pg_class",
  "pg_depend",
  "pg_proc",
  "pg_rewrite",
  // The CTEs of that walk.
  "canonical_view",
  "edge",
  "reach",
]);

/**
 * The five read axes, and the whole of what a "writer" is.
 *
 * Named here because two tests filter on them and because ticket 15 made the
 * distinction load-bearing: `wattsteer.feature_ingestion_history_from` is a
 * transaction-local **memo** for a catalogue walk and an unindexed `min()` per
 * source, not a cut anybody reads a row through, and a guard that counted
 * `set_config` calls could not tell the two apart.
 *
 * `partial_reference_days` (data-platform 29) is the fifth, and the reason it
 * belongs in this list is the feature layer specifically: it admits reference
 * days ONS published short into `canonical_day_ahead_balance`, and
 * `feature_rows` minimises and ranks over the whole day that view hands it. A
 * feature build must therefore write the axis empty rather than inherit an ask
 * from a read earlier in the same transaction.
 */
const AXES = [
  "wattsteer.as_of",
  "wattsteer.fleet_date",
  "wattsteer.published_at_or_before",
  "wattsteer.weather_run_cycle",
  "wattsteer.partial_reference_days",
];

/**
 * Whether a function *writes* an axis, as opposed to naming one.
 *
 * `COMMENT ON FUNCTION` text is part of a segment and is not stripped —
 * literals are only blanked out of `CODE`, and these two tests assert against
 * `SQL` — so `feature_as_of`, whose comment explains which axis it feeds,
 * would otherwise count as a writer of it.
 */
const writesAxis = (body: string, axis: string): boolean =>
  body.includes(`set_config('${axis}'`);

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
    //
    // The filter is on the **axes** rather than on `set_config`. Ticket 15
    // added a transaction-local memo — `wattsteer.feature_ingestion_history_from`,
    // the instant by which every source the feature layer reads had begun —
    // cached because the set behind it is a catalogue walk and an unindexed
    // `min()` per source, and it is asked once per block per target date. A
    // memo is not a cut. Counting `set_config` calls
    // would have made this test refuse it while saying nothing about the
    // property it exists to hold, which is that the four axes are written in
    // four places and every one of them derives its own instant.
    const writers = [...functionSegments()]
      .filter(([, body]) => AXES.some((axis) => writesAxis(body, axis)))
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
      if (!AXES.some((axis) => writesAxis(body, axis))) {
        continue;
      }
      for (const axis of AXES) {
        expect({ name, axis, written: writesAxis(body, axis) }).toEqual({
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
    // Every definition of it, not the first: `feature_rows` is restated in full
    // by each migration that adds columns — a function body cannot be patched —
    // and a restatement is exactly where a parameter could be smuggled in.
    const signatures = [
      ...SQL.matchAll(/CREATE OR REPLACE FUNCTION feature_rows\(/g),
    ].map((match) => {
      const start = match.index ?? 0;
      return SQL.slice(start, SQL.indexOf("RETURNS SETOF feature_row", start));
    });
    expect(signatures.length).toBeGreaterThan(1);

    for (const signature of signatures) {
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
    // Non-vacuous: later tickets really did append to ticket 01's declaration
    // rather than restating the shape.
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
    // Against the code, not against the text. Ticket 11's dictionary *records*
    // the drop — `feature_dropped_feature` carries "month, week_of_year" with
    // `calendar_doy_sin`/`_cos` named as the replacement — and a string literal
    // saying a feature was dropped is the opposite of the event this guards
    // against. `CODE` is the SQL with the literals blanked out, so a column
    // named `week_of_year`, or any expression computing one, still fails here.
    expect(CODE).not.toMatch(/\bweek_of_year\b/);
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

describe("the actuals cutoff, structurally", () => {
  it("derives the gate rather than accepting one", () => {
    // The spec writes the rule as `actuals_cutoff(gate, dataset)`. A `gate
    // timestamptz` parameter would be a door into the feature layer through
    // which a hand-chosen instant could arrive, and ticket 01's first property
    // is that there is no such door — so the gate is derived here exactly as
    // `feature_apply_gate` derives it, and the caller chooses a date and a
    // profile or nothing at all.
    const cutoff = functionSegments().get("actuals_cutoff") ?? "";
    expect(cutoff).toContain("gate_at(target_date, gate_profile)");
    expect(
      /FUNCTION\s+actuals_cutoff\(\s*target_date date, gate_profile text, dataset text\s*\)/.test(
        cutoff,
      ),
    ).toBe(true);
    for (const forbidden of ["timestamp", "as_of", "published_at"]) {
      const signature = cutoff.slice(0, cutoff.indexOf("RETURNS"));
      expect({ forbidden, present: signature.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  it("takes the lag from the configured table and never from a literal", () => {
    // A number spelled in a function is a number a reviewer cannot find and a
    // migration cannot show moving. `publication_lag_hours` is a table, the
    // cutoff reads it, and an unknown dataset raises rather than defaulting to
    // zero hours — because a default of zero is an *unfiltered* observation read
    // that looks exactly like a correct answer.
    const cutoff = functionSegments().get("actuals_cutoff") ?? "";
    expect(cutoff).toContain("feature_publication_lag");
    expect(cutoff).toContain("USING ERRCODE = '22023'");
    // No lag spelled in the body — the defaults live in the seeded table and
    // nowhere else, so moving one is a migration and shows up as a diff.
    const body = cutoff.slice(0, cutoff.indexOf("END $$"));
    expect(body).not.toMatch(/\b(?:40|24|6)\b/);
  });

  it("pins the conservative defaults, so loosening one is a visible diff", () => {
    // These may only ever be loosened *by measurement*, and loosening one moves
    // the cutoff, which moves every lag and trailing window behind it, which
    // changes the feature distribution: a retrain trigger, not a config tweak.
    // Pinned here so the retrain trigger cannot be pulled quietly.
    const seed = SQL.slice(SQL.indexOf("INSERT INTO feature_publication_lag"));
    for (const [dataset, hours] of [
      ["balanco-energia-subsistema", 40],
      ["intercambio-nacional", 40],
      ["restricao-coff", 40],
      ["restricao-coff-detalhe", 40],
      ["carga-verificada", 6],
      ["capacidade-geracao", 24],
    ] as const) {
      const row = new RegExp(`'${dataset}',\\s*'[a-z-]+',\\s*${hours},`);
      expect({ dataset, configured: row.test(seed) }).toEqual({
        dataset,
        configured: true,
      });
    }
  });

  it("bounds every observation read on valid_time, once per read", () => {
    // The whole ticket in one assertion. `AsOf(gate)` filters `ingested_at` and
    // over the backfill window filters *nothing*, so an observation read that
    // relied on it would be unfiltered and look correct. Each of the three
    // series is therefore cut on its own dataset's cutoff, and the count has to
    // match the number of reads — a second read added without a bound is
    // exactly the failure this catches.
    const block = functionSegments().get("feature_lagged_actuals_block") ?? "";
    const occurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;

    for (const [view, cut] of [
      ["canonical_curtailment_by_reporting_entity", "cut_curtailment"],
      ["canonical_system_context", "cut_context"],
      ["canonical_system_exchange", "cut_exchange"],
    ] as const) {
      const reads = occurrences(block, `FROM ${view}`);
      expect({ view, reads: reads > 0 }).toEqual({ view, reads: true });
      expect({ view, bounded: occurrences(block, `valid_time <= ${cut}`) }).toEqual({
        view,
        bounded: reads,
      });
    }
  });

  it("builds no difference, no ramp and no window that reaches the target hour", () => {
    // Last-known-value substitution is honest for a level and dishonest for a
    // local difference: a ramp reconstructed from one last-observed value is one
    // number broadcast across 24 hours, and a tree model will read it as
    // intraday shape. So the dropped class is dropped *here* too — not merely
    // unimplemented — and the replacements are forecast-side.
    const block = functionSegments().get("feature_lagged_actuals_block") ?? "";
    for (const forbidden of ["CURRENT ROW", "lag(", "lead(", "FOLLOWING"]) {
      expect({ forbidden, present: block.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
    for (const column of FEATURE_ROW_COLUMNS) {
      if (!column.startsWith("observed_")) {
        continue;
      }
      expect(column).not.toContain("ramp");
      expect(column).not.toContain("_diff");
    }
    // The two utilisation ratios ticket 05 deferred are levels-over-a-constant
    // and belong to the same class, but they live in ticket 10's block beside
    // the estimate they divide by — so this block still holds none of them.
    expect(block).not.toContain("utilisation");
  });

  it("keeps PAR out of the reason-share set", () => {
    // A live enum member with zero observations. A share column for a class that
    // has never occurred is a column of zeroes a model spends split points on —
    // and `PAR` stays in the *denominator*, so the day it first appears the
    // three shares stop summing to one. That is the monitoring signal.
    for (const column of FEATURE_ROW_COLUMNS) {
      expect(column).not.toBe("observed_reason_share_par_7d");
    }
    expect(SQL).not.toMatch(/'PAR'/);
    for (const reason of ["ENE", "CNF", "REL"]) {
      expect(SQL).toContain(`'${reason}'`);
    }
  });
});

describe("the day-ahead programme, structurally", () => {
  it("cuts on publication, and never on the actuals cutoff", () => {
    // The class this block belongs to is decided by what kind of fact it reads,
    // not by which ticket built it. `carga-energia-programada` is a `Forecast`,
    // so its D−1 availability is *genuine* — `published_at` is a publication
    // instant — and the gate alone is the right cut. Reaching for
    // `actuals_cutoff` here would move a forecast onto the enforced axis that
    // exists because observations have no honest publication stamp, which is a
    // category error that would look conservative and be meaningless.
    const block = functionSegments().get("feature_programmed_load_block") ?? "";
    expect(block).toContain("feature_apply_gate(target_date, gate_profile)");
    expect(block).toContain("canonical_programmed_load");
    expect(block).not.toContain("actuals_cutoff");
    expect(block).not.toContain("feature_publication_lag");
  });

  it("never lets a ramp or a centred window span a gap in the profile", () => {
    // `lag()` returns the previous *row*, which is the previous *hour* only
    // while the profile is complete. Without the adjacency check a column named
    // `_ramp_1h` would silently be a two-hour difference in exactly the rows
    // where the programme was already thin — the same failure as a lag that
    // slides, which ticket 05 refused on the actuals side.
    const block = functionSegments().get("feature_programmed_load_block") ?? "";
    const guards = block.split("previous_hour = shaped.valid_time - interval").length - 1;
    expect(guards).toBe(2);
    expect(block).toContain("next_hour = shaped.valid_time + interval");
  });

  it("refuses a day-grain summary of a partial day", () => {
    // A minimum over nineteen hours is the minimum of a different day, and a
    // rank among nineteen is not the rank the column name promises. Both are
    // NULL rather than computed over what happens to be there.
    const block = functionSegments().get("feature_programmed_load_block") ?? "";
    expect(block.split("hours_in_day = 24").length - 1).toBe(2);
  });

  it("keeps the publication decision at the adapter, in one place", () => {
    // The instant a programme row carries is a property of the fact, so it is
    // written at ingest and the feature layer has no opinion about it. A second
    // copy of the hour spelled in SQL would be a second definition of
    // "published", reachable only from the database — and it would make the
    // ablation seam unable to see a leak it had itself caused.
    expect(PROGRAMME_PUBLICATION_HOUR_BRT).toBe(15);
    const adapter = readFileSync(
      join(import.meta.dir, "../src/ingest/ons/load.ts"),
      "utf8",
    );
    expect(adapter).toContain("export const PROGRAMME_PUBLICATION_HOUR_BRT = 15;");
    // The migration points at the adapter rather than restating the rule.
    expect(RAW).toContain("programmePublishedAt");
    // The body itself, not the catalogue comments that follow it: those name
    // the hour precisely so a modeller reading the column can find it, which is
    // the opposite of a second definition.
    const segment = functionSegments().get("feature_programmed_load_block") ?? "";
    const body = segment.slice(0, segment.indexOf("END $$"));
    expect(body).not.toContain("15:00");
    expect(body).not.toMatch(/published_at/);
  });
});

describe("DESSEM and the feature-set argument, structurally", () => {
  it("gates the block on the feature set, and refuses the early gate twice", () => {
    // The acceptance claim, as a property of the SQL rather than of a fixture.
    // `feature_rows` has refused `dessem_augmented_v1` at `gate_early` since
    // ticket 01; ticket 07 puts the same refusal in the block, so it survives a
    // future caller that reaches `feature_dessem_block` another way. And
    // `dessem_free_v1` produces **no rows at all** rather than rows a filter
    // then empties — which is what makes "the DESSEM-free set contains no
    // DESSEM-sourced value" a property of the function producing them.
    const block = functionSegments().get("feature_dessem_block") ?? "";
    expect(block).toContain("feature_apply_gate(target_date, gate_profile)");
    expect(block).toContain("canonical_day_ahead_balance");
    expect(
      /FUNCTION\s+feature_dessem_block\(\s*target_date date, gate_profile text, feature_set text\s*\)/.test(
        block,
      ),
    ).toBe(true);
    // Set A: nothing, at either gate. The `RETURN` is before any read.
    const setA = block.indexOf("IF feature_set = 'dessem_free_v1' THEN");
    expect(setA).toBeGreaterThan(-1);
    expect(setA).toBeLessThan(block.indexOf("canonical_day_ahead_balance"));
    // Set B: gate_late or nothing, and it raises rather than returning NULLs.
    // Two walls, not one — the block's own and `feature_rows`' — so the rule
    // survives a caller that reaches the block another way. `feature_rows` is
    // restated in full by every migration that adds a column, so its copy of
    // the refusal appears once per restatement and the count below is over the
    // *distinct functions* that raise it rather than over the text.
    const raisers = [...functionSegments()]
      .filter(([, body]) => body.includes("dessem_augmented_v1 exists only at gate_late"))
      .map(([name]) => name);
    expect(raisers.toSorted()).toEqual(["feature_dessem_block", "feature_rows"]);
  });

  it("cuts on publication, and never on the actuals cutoff", () => {
    // A `Forecast` with a genuine publication instant — the DESSEM file's own
    // creation — so the gate alone is the right cut. Reaching for
    // `actuals_cutoff` here would move a forecast onto the enforced axis that
    // exists because observations have no honest publication stamp.
    const block = functionSegments().get("feature_dessem_block") ?? "";
    expect(block).not.toContain("actuals_cutoff");
    expect(block).not.toContain("feature_publication_lag");
  });

  it("averages the two half hours rather than summing them", () => {
    // The opposite of `canonical_programmed_load`, and right for the opposite
    // reason: the programme is already MWh per half hour, DESSEM publishes
    // instantaneous MW. A sum here would publish every DESSEM quantity at twice
    // its true size — which looks exactly like a busy day.
    const block = functionSegments().get("feature_dessem_block") ?? "";
    expect(block).toContain("avg(b.demand_mw)");
    expect(block).not.toMatch(/sum\(b\./);
    // And a half-empty hour is a hole, not a half-sized one.
    expect(block).toContain("HAVING count(*) = 2");
  });

  it("never lets a ramp span a gap in the profile, and refuses a partial day", () => {
    // The class-`P` guards, on the class-`D` block. `lag()` returns the
    // previous *row*, which is the previous *hour* only while the profile is
    // complete; a minimum over nineteen hours is the minimum of a different day.
    const block = functionSegments().get("feature_dessem_block") ?? "";
    expect(block.split("previous_hour = shaped.valid_time - interval").length - 1).toBe(
      3,
    );
    expect(block.split("hours_in_day = 24").length - 1).toBe(2);
  });

  it("derives the national total as a sum over the four, and only over four", () => {
    // `SIN` is not a Subsystem (`docs/domain-model.md` §2). A national total is
    // a derived sum over the four or it does not exist — and a sum over three
    // is the residual load of a different system, so it is NULL rather than
    // quietly smaller.
    const block = functionSegments().get("feature_dessem_block") ?? "";
    expect(block).toContain("HAVING count(*) = 4");
    expect(SQL).not.toMatch(/'SIN'/);
  });

  it("carries all 22 names, the last of them once a denominator existed", () => {
    // The spec names 22 `dessem_*` features across 21 table rows. Ticket 07
    // shipped twenty-one and left `dessem_export_utilisation` out rather than
    // invent a denominator for it; ticket 10 estimated one and closed it. The
    // ratio is *not* in the class-`D` block, though — it is in the utilisation
    // block, beside the estimate it divides by, so that the augmented set
    // cannot grow a second disagreeing estimate of the same quantity.
    const dessem = FEATURE_ROW_COLUMNS.filter((column) => column.startsWith("dessem_"));
    expect(dessem).toHaveLength(22);
    expect(dessem).toContain("dessem_export_utilisation");
    const segment = functionSegments().get("feature_dessem_block") ?? "";
    expect(segment.slice(0, segment.indexOf("END $$"))).not.toContain("utilisation");
  });

  it("states the lost notice beside the shorter window, at `gate_at`'s own gap", () => {
    // The augmented set's *second* cost, and the one a metric table hides. The
    // spec records it where the trade is stated, not only where the gate is
    // described, because a comparison that reports only the metric is reporting
    // half the trade.
    //
    // **This assertion used to read `toContain("eleven hours")` and was
    // pinning a false number into the spec.** `gate_at` is the authority and it
    // is arithmetic: `gate_early` is local hour 9 and `gate_late` is 19, so the
    // interval is *ten* hours, and `feature-engineering.md` said eleven in five
    // places — including a table row reading "09:00 BRT … eleven hours later …
    // 19:00 BRT". api-surface 27 corrected the spec, and the number is derived
    // here rather than restated, so this test cannot pin the next wrong one.
    const gapHours = 19 - 9;
    const early = /WHEN 'gate_early' THEN (\d+)/.exec(RAW);
    const late = /WHEN 'gate_late' THEN (\d+)/.exec(RAW);
    // Only `0016` defines `gate_at`, so a null here means the SQL moved and the
    // derivation below would otherwise be comparing against nothing.
    expect(early?.[1]).toBeDefined();
    expect(late?.[1]).toBeDefined();
    expect(Number(late?.[1]) - Number(early?.[1])).toBe(gapHours);

    const spec = readFileSync(
      join(import.meta.dir, "../../../docs/specs/feature-engineering.md"),
      "utf8",
    );
    const table = spec.slice(spec.indexOf("### The two feature sets"));
    expect(table.slice(0, 2400)).toContain("ten hours of lost");

    // The migrations keep the eleven, and are not edited to remove it: `0025`
    // spells out where it came from — "ten fewer hours of notice … eleven,
    // counting from the 08:00 BRT dispatch desk" — which is the desk-to-gate
    // wait rather than the notice one set gives up relative to the other. The
    // spec's correction note names both quantities. A landed migration is
    // never rewritten, so the disagreement is recorded rather than hidden.
    expect(RAW).toContain("08:00 BRT dispatch desk");
  });
});

describe("the weather block, structurally", () => {
  it("weights every variable, and never on the wrong fleet's vector", () => {
    // The split is the block's whole reason to exist: NE wind is the Bahia
    // interior and the RN/CE coast, more than half of SE solar is three
    // municipality clusters in northern Minas Gerais, and one shared vector
    // would put solar weight on wind's coast. Asserted per variable, because a
    // basis is one identifier and getting one wrong is invisible in review.
    const block = functionSegments().get("feature_weather_block") ?? "";
    expect(block).not.toBe("");
    for (const [variable, weight] of [
      ["wind_speed100m_kmh", "wind_weight"],
      ["wind_speed120m_kmh", "wind_weight"],
      ["wind_direction120m_deg", "wind_weight"],
      ["wind_gusts10m_kmh", "wind_weight"],
      ["temperature2m_c", "vre_weight"],
      ["surface_pressure_hpa", "vre_weight"],
      ["relative_humidity2m_pct", "vre_weight"],
      ["precipitation_mm", "vre_weight"],
      ["shortwave_radiation_wm2", "solar_weight"],
      ["direct_normal_irradiance_wm2", "solar_weight"],
      ["diffuse_radiation_wm2", "solar_weight"],
      ["cloud_cover_pct", "solar_weight"],
    ] as const) {
      const weighted = new RegExp(
        `p\\.${variable}\\s*\\)*\\s*\\*\\s*basis\\.${weight}`,
      ).test(block.replace(/\s+/g, " "));
      expect({ variable, weight, weighted }).toEqual({
        variable,
        weight,
        weighted: true,
      });
    }
  });

  it("renormalises over the reporters rather than dividing by the full mass", () => {
    // A hole in the sample is not calm weather. Dividing by the full weight
    // mass would pull every mean toward zero in proportion to the hole and
    // produce a number that looks like weather; the size of the hole belongs on
    // `weather_centroid_coverage`, which is the column the serve path refuses on.
    const block = (functionSegments().get("feature_weather_block") ?? "").replace(
      /\s+/g,
      " ",
    );
    const denominators =
      block.split(/nullif\(\s*sum\(basis\.\w+_weight\)\s*FILTER \(WHERE p\./).length - 1;
    // Eleven scalar means and the power curve: every one renormalised.
    expect(denominators).toBe(12);
  });

  it("reports coverage as weight mass and never as a count of centroids", () => {
    // Losing a 426 MW point and losing a 4,172 MW point are the same fraction
    // of points and are not remotely the same event.
    const block = (functionSegments().get("feature_weather_block") ?? "").replace(
      /\s+/g,
      " ",
    );
    expect(block).toContain("sum(basis.vre_weight) FILTER (WHERE p.centroid_id IS NOT");
    expect(block).not.toMatch(/count\(\s*p\.centroid_id\s*\)/);
  });

  it("writes the power curve's three parameters down at the feature", () => {
    // Cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s — the curve the lead-time
    // research passes both sides of the train/serve comparison through, and a
    // proxy rather than the Brazilian fleet's. A curve whose numbers live only
    // in a comment is a curve nobody can check.
    const curve = functionSegments().get("feature_wind_power_curve_cf") ?? "";
    expect(curve).not.toBe("");
    for (const parameter of ["3.0", "12.0", "25.0"]) {
      expect(curve).toContain(parameter);
    }
    // Applied per centroid and then weighted, never to the weighted mean speed:
    // the curve is nonlinear, so the two differ.
    const block = (functionSegments().get("feature_weather_block") ?? "").replace(
      /\s+/g,
      " ",
    );
    expect(block).toContain(
      "feature_wind_power_curve_cf(p.wind_speed120m_kmh / 3.6) * basis.wind_weight",
    );
  });

  it("names one centroid set version, and the two copies of it agree", () => {
    // "Whichever set happens to be loaded" is the silent restatement freezing
    // the geometry exists to prevent, so the weight view reads `centroid_point`
    // under a literal — the same shape as the calendar's `br_calendar_v1`, and
    // the same hazard: a literal in two languages is a constant that can drift.
    const views = readFileSync(
      join(import.meta.dir, "../src/database/canonical-views.ts"),
      "utf8",
    );
    expect(views).toContain(`'${CENTROID_SET_VERSION}'`);
    const versions = new Set(
      [...views.matchAll(/'(centroid_set_v\d+)'/g)].map((match) => match[1] as string),
    );
    expect([...versions]).toEqual([CENTROID_SET_VERSION]);
  });

  it("takes the fleet before the weather, so no read inherits the D−28 axes", () => {
    // `feature_capacity_block` leaves the read axes at the D−28 fleet date,
    // because the last thing it does is the second of its two as-of reads. The
    // expected-generation denominator is therefore materialised first and
    // `feature_apply_gate` is called afterwards. Reading the weather or the
    // weights first would work today and would break silently the day someone
    // reorders the CTEs in `feature_rows`.
    const block = functionSegments().get("feature_weather_block") ?? "";
    const fleet = block.indexOf("feature_capacity_block");
    const gate = block.indexOf("PERFORM feature_apply_gate");
    const weights = block.indexOf("canonical_capacity_weight");
    const weather = block.indexOf("canonical_weather_forecast");
    expect(fleet).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(fleet);
    expect(weights).toBeGreaterThan(gate);
    expect(weather).toBeGreaterThan(gate);
  });
});

describe("the proxy residual load, structurally", () => {
  const proxyBlock = () =>
    functionSegments().get("feature_proxy_residual_load_block") ?? "";

  it("composes the two blocks rather than re-reading what they read", () => {
    // The whole reason this block exists in this shape. A third place that
    // re-derived the programme or the two conversions would be a third
    // definition of them, and `proxy_residual_load_mwh` could then disagree with
    // `programmed_load_mwh` and `weather_expected_wind_mwh` **in its own row**.
    // So the block reads no view at all: it names the two blocks and nothing
    // else, which is also why it has no vintage to write.
    const block = proxyBlock();
    // The segment runs to the next function header, which is `feature_rows` —
    // so the body alone, or the catalogue comments beneath it would be read as
    // code.
    const body = block.slice(0, block.indexOf("END $$"));
    expect(body).toContain("feature_programmed_load_block(target_date, gate_profile)");
    expect(body).toContain("feature_weather_block(target_date, gate_profile)");
    expect(body).not.toContain("canonical_");
    expect(body).not.toContain("set_config");
  });

  it("takes every term or none, and coalesces nothing to zero", () => {
    // "The registry places no VRE here at this gate" and "the fleet is forecast
    // to generate nothing" are different statements, and only one of them is a
    // number. A coalesce to zero would turn the first into the second and
    // publish a *load* forecast under a residual load's name — in exactly the
    // rows where the fleet read had failed.
    const body = proxyBlock();
    expect(body).not.toContain("coalesce(p.");
    expect(body).not.toContain("coalesce(w.");
    expect(body).toContain("p.programmed_load_mwh IS NOT NULL");
    expect(body).toContain("w.weather_expected_wind_mwh IS NOT NULL");
    expect(body).toContain("w.weather_expected_solar_mwh IS NOT NULL");
  });

  it("reaches for no earlier publication hour to fill the early gate", () => {
    // The finding this ticket inherits, as a property of the SQL. Every column
    // here is NULL at `gate_early` because the programme it subtracts from is,
    // and the repair — an earlier assumed publication, or a load forecast of our
    // own — is the leak the spec exists to prevent. The block cannot express
    // either: it has no publication instant, and its only load term is the one
    // the class-`P` block returns.
    const body = proxyBlock();
    for (const forbidden of ["published_at", "gate_at(", "actuals_cutoff", "15:00"]) {
      expect({ forbidden, present: body.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  it("never lets a ramp span a gap, and refuses a day-grain summary of a partial day", () => {
    // The same two rules as `0024` and `0025`, and for the same reasons: a
    // neighbouring row is not a neighbouring hour once a term went missing, and
    // a rank among nineteen is not the rank the column's name promises.
    const body = proxyBlock();
    expect(body.split("previous_hour = shaped.valid_time - interval").length - 1).toBe(1);
    expect(body.split("hours_in_day = 24").length - 1).toBe(2);
  });

  it("keeps both views of residual load, in both feature sets", () => {
    // The augmented set is set A plus the DESSEM block, so it carries the
    // rebuilt residual load *and* DESSEM's own — which is what makes the A/B a
    // comparison of two views rather than of two disjoint sets. The block is
    // therefore not handed the feature set: there is no argument through which
    // one set could be given the family and the other refused it.
    const header =
      /CREATE OR REPLACE FUNCTION feature_proxy_residual_load_block\(\s*target_date date, gate_profile text\s*\)/;
    expect(header.test(SQL)).toBe(true);
    expect(proxyBlock()).not.toContain("feature_set");

    const proxy = FEATURE_ROW_COLUMNS.filter((column) => column.startsWith("proxy_"));
    const dessem = FEATURE_ROW_COLUMNS.filter((column) => column.startsWith("dessem_"));
    expect(proxy).toHaveLength(7);
    expect(dessem).toHaveLength(22);
    // The pair the A/B compares, both in the one row type.
    expect(proxy).toContain("proxy_residual_load_mwh");
    expect(dessem).toContain("dessem_residual_load_mwh");
  });

  it("records the classification of every input at the column", () => {
    // Class `P`+`W`+`T` is the claim the ticket asks to be recorded, and the
    // place a modeller can find it is the catalogue comment that travels with
    // the number. Nothing else in the row can tell them that no term here is an
    // actual and no term is a model output.
    for (const column of FEATURE_ROW_COLUMNS) {
      if (!column.startsWith("proxy_")) {
        continue;
      }
      const comment = RAW.slice(
        RAW.indexOf(`COMMENT ON COLUMN feature_row.${column} IS`),
      ).slice(0, 1200);
      expect({ column, classified: comment.includes("Class P+W+T") }).toEqual({
        column,
        classified: true,
      });
    }
    const headline = RAW.slice(
      RAW.indexOf("COMMENT ON COLUMN feature_row.proxy_residual_load_mwh IS"),
    ).slice(0, 1200);
    expect(headline).toContain("No input is a day-D actual");
    expect(headline).toContain("no input is a model output");
    expect(headline).toContain("gate_early");
  });
});

describe("the interchange utilisation proxy, structurally", () => {
  const estimator = () =>
    functionSegments().get("feature_export_capability_estimate") ?? "";
  const block = () =>
    functionSegments().get("feature_interchange_utilisation_block") ?? "";

  it("states the absence of any published limit rather than working around it", () => {
    // The ticket's first acceptance claim, and it is a claim about *prose* on
    // purpose: a modeller who finds this column has to be able to find out,
    // from the column, that its denominator was never published by anybody.
    // So the finding is in the migration, in the function comment and in all
    // three column comments — not only in the spec, which is not what travels
    // with the number.
    expect(RAW).toContain("transfer-limit dataset at any grain");
    expect(SQL).toContain("No ONS dataset publishes a transfer limit at any grain");
    const catalogue = functionSegments().get("feature_export_capability_estimate") ?? "";
    expect(catalogue).toContain("ESTIMATE");
    for (const column of FEATURE_ROW_COLUMNS) {
      if (!column.includes("utilisation")) {
        continue;
      }
      const comment = RAW.slice(
        RAW.indexOf(`COMMENT ON COLUMN feature_row.${column} IS`),
      ).slice(0, 1400);
      expect({ column, labelled: comment.includes("ESTIMATE") }).toEqual({
        column,
        labelled: true,
      });
    }
  });

  it("is a high quantile over a trailing gate-bounded year, with a minimum sample", () => {
    // Each number is load-bearing and each is spelled in the one place the
    // estimator lives. A maximum would let one outlier hour define a year of
    // denominators; a whole-history window would leak a 2026 record flow into a
    // 2024 feature; a P99.5 over a dozen observations is a maximum wearing a
    // quantile's name.
    const body = estimator().slice(0, estimator().indexOf("END $$"));
    expect(body).toContain("percentile_cont(0.995)");
    expect(body).toContain("interval '365 days'");
    expect(body).toContain("sample_hours >= 300");
    // Not a maximum, anywhere in the estimator.
    expect(body).not.toMatch(/\bmax\s*\(/i);
  });

  it("bounds the denominator on the cutoff, and derives the gate rather than taking one", () => {
    // The leak this column would otherwise be. A denominator is as capable of
    // seeing the future as a numerator, and it is *less* likely to be reviewed
    // — so the estimator is cut on `valid_time <= actuals_cutoff` like every
    // other observation read, and there is no argument through which a
    // hand-chosen window could arrive.
    expect(
      /FUNCTION\s+feature_export_capability_estimate\(\s*target_date date, gate_profile text\s*\)/.test(
        estimator(),
      ),
    ).toBe(true);
    const signature = estimator().slice(0, estimator().indexOf("RETURNS"));
    for (const forbidden of ["timestamp", "as_of", "published_at", "cutoff"]) {
      expect({ forbidden, present: signature.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
    const occurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;
    for (const segment of [estimator(), block()]) {
      const reads = occurrences(segment, "FROM canonical_system_exchange");
      expect(reads).toBe(1);
      expect(occurrences(segment, "valid_time <= cut_exchange")).toBe(reads);
    }
  });

  it("publishes the estimate per directed corridor with its sample size", () => {
    // A capability is a property of a direction, not of a link — NE→SE and
    // SE→NE are different limits — and the view stores one row per undirected
    // pair, so the reverse direction is the stored flow negated. The sample
    // size travels with the estimate because it is what distinguishes an
    // estimate from a measurement to whoever reads it.
    expect(SQL).toContain("CREATE TYPE feature_export_capability_corridor AS (");
    const type = SQL.slice(
      SQL.indexOf("CREATE TYPE feature_export_capability_corridor AS ("),
    ).slice(0, 400);
    expect(type).toContain("from_subsystem subsystem_code");
    expect(type).toContain("to_subsystem subsystem_code");
    expect(type).toContain("export_capability_mwh double precision");
    expect(type).toContain("sample_hours integer");
    // The sign flip that makes both directions available from one stored row.
    expect(estimator()).toContain("-t.verified_exchange_mwh");
  });

  it("has exactly one estimate, and every ratio reaches it", () => {
    // The reason the DESSEM ratio and the two observed ratios land in one
    // ticket. Split across two, each would have grown a denominator of its own
    // and the augmented set would carry two disagreeing estimates of the same
    // physical quantity in one row.
    expect([...SQL.matchAll(/percentile_cont/g)]).toHaveLength(1);
    const owners = [...functionSegments()]
      .filter(([, body]) => body.includes("percentile_cont"))
      .map(([name]) => name);
    expect(owners).toEqual(["feature_export_capability_estimate"]);
    // And the block that publishes the three ratios reads the estimate rather
    // than computing one.
    expect(block()).toContain(
      "feature_export_capability_estimate(target_date, gate_profile)",
    );
  });

  it("composes the DESSEM block rather than re-reading the balance", () => {
    // `0030`'s rule. The numerator of `dessem_export_utilisation` is the class-`D`
    // block's own `dessem_implied_net_export_mwh`, so the ratio and the quantity
    // it divides are the same number in the same row and cannot disagree — and
    // at `dessem_free_v1` the ratio is NULL because that block returns no rows,
    // by the same mechanism as the other twenty-one `dessem_*` columns.
    const body = block().slice(0, block().indexOf("END $$"));
    expect(body).toContain("feature_dessem_block(");
    expect(body).not.toContain("canonical_day_ahead_balance");
    expect(body).toContain("balance_hour.dessem_implied_net_export_mwh");
    // One view of its own, and it is the exchange series.
    expect(body).toContain("canonical_system_exchange");
  });

  it("refuses a denominator it cannot stand behind, rather than falling back", () => {
    // Two refusals, both NULL and neither repaired: too few hours in the
    // trailing year, and a direction that never carried energy. A `coalesce` to
    // a nearby corridor's estimate, or to a whole-history maximum, would make
    // the column non-null by asserting something nothing measured.
    const body = estimator().slice(0, estimator().indexOf("END $$"));
    expect(body).toContain("estimated.p995 > 0");
    expect(body).not.toContain("coalesce(estimated");
    // And the block joins every numerator through the corridors that *have* an
    // estimate, so a short sample contributes to no ratio rather than to a
    // numerator alone.
    expect(block()).toContain("WHERE c.export_capability_mwh IS NOT NULL");
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
      "observed_actual_lag_hours",
      "observed_constrained_off_lag_168h",
      "observed_constrained_off_wind_lag_168h",
      "observed_constrained_off_solar_lag_168h",
      "observed_constrained_off_lag_48h",
      "observed_constrained_off_same_hour_mean_7d",
      "observed_constrained_off_hours_above_threshold_7d",
      "observed_constrained_off_total_7d_mwh",
      "observed_load_lag_168h",
      "observed_wind_generation_lag_168h",
      "observed_solar_generation_lag_168h",
      "observed_wind_capacity_factor_mean_7d",
      "observed_solar_capacity_factor_mean_7d",
      "observed_net_exchange_lag_168h",
      "observed_net_exchange_mean_24h_to_cutoff",
      "observed_corridor_flow_ne_se_lag_168h",
      "observed_corridor_flow_n_ne_lag_168h",
      "observed_reason_share_ene_7d",
      "observed_reason_share_cnf_7d",
      "observed_reason_share_rel_7d",
      "programmed_load_mwh",
      "programmed_load_ramp_1h",
      "programmed_load_mean_3h",
      "programmed_load_daily_min_mwh",
      "programmed_load_rank_in_day",
      "dessem_demand_mwh",
      "dessem_wind_mwh",
      "dessem_solar_mwh",
      "dessem_mmgd_mwh",
      "dessem_hydro_mwh",
      "dessem_thermal_mwh",
      "dessem_pumping_mwh",
      "dessem_residual_load_mwh",
      "dessem_renewable_load_ratio",
      "dessem_vre_surplus_mwh",
      "dessem_inflexible_share",
      "dessem_implied_net_export_mwh",
      "dessem_demand_ramp_1h",
      "dessem_residual_load_ramp_1h",
      "dessem_vre_ramp_1h",
      "dessem_residual_load_min_of_day",
      "dessem_residual_load_rank_in_day",
      "dessem_wind_capacity_factor",
      "dessem_solar_capacity_factor",
      "dessem_sin_residual_load_mwh",
      "dessem_absorber_residual_load_mwh",
      "weather_wind_speed_100m",
      "weather_wind_speed_120m",
      "weather_wind_direction_120m_sin",
      "weather_wind_direction_120m_cos",
      "weather_wind_gusts_10m",
      "weather_surface_pressure",
      "weather_relative_humidity_2m",
      "weather_precipitation",
      "weather_shortwave_radiation",
      "weather_direct_normal_irradiance",
      "weather_diffuse_radiation",
      "weather_cloud_cover",
      "weather_clearness_index",
      "weather_wind_power_curve_cf",
      "weather_expected_wind_mwh",
      "weather_expected_solar_mwh",
      "weather_wind_speed_120m_ramp_1h",
      "weather_shortwave_radiation_ramp_1h",
      "weather_expected_vre_ramp_1h",
      "weather_wind_speed_120m_mean_3h",
      "weather_wind_speed_120m_std_6h",
      "weather_shortwave_radiation_mean_3h",
      "weather_run_age_hours",
      "weather_centroid_coverage",
      "proxy_residual_load_mwh",
      "proxy_residual_load_ratio",
      "proxy_renewable_load_ratio",
      "proxy_vre_surplus_mwh",
      "proxy_residual_load_ramp_1h",
      "proxy_residual_load_min_of_day",
      "proxy_residual_load_rank_in_day",
      "observed_export_utilisation_mean_24h_to_cutoff",
      "observed_corridor_utilisation_ne_se_max_7d",
      "dessem_export_utilisation",
      "observed_constrained_off_same_hour_exceedance_7d",
    ]);
  });

  it("keeps lead time out of the row, and the collinearity argument in it", () => {
    // Within a fixed run cycle `weather_lead_hours` is perfectly collinear with
    // `calendar_local_hour`: from a D−1 12Z run the lead is exactly
    // `15 + local_hour`. Asserted rather than trusted, because "available and
    // redundant" is the kind of decision a later session repairs helpfully.
    for (const column of FEATURE_ROW_COLUMNS) {
      expect(column).not.toBe("weather_lead_hours");
    }
    expect(RAW).toContain("weather_lead_hours");
    expect(RAW).toContain("collinear");
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
  it("marks every cutoff-anchored column day grain, and everything else hourly", () => {
    // A column constant within a day must not be read as an hourly signal, and
    // that is invisible in the data: twenty-four equal numbers look exactly
    // like a flat hourly series. The marking is the only thing that
    // distinguishes them.
    //
    // Two families are day grain and for two different reasons. Capacity is a
    // fact about a day. Ticket 05's trailing windows are anchored to
    // `actuals_cutoff` rather than to the target hour, so the window is the same
    // window for all twenty-four rows — which is *more* confusable than
    // capacity, because it sits in the row beside lagged levels that really are
    // hourly.
    const day = FEATURE_ROW_COLUMNS.filter((column) => featureGrain(column) === "day");
    expect(day).toEqual([
      "capacity_wind_mw",
      "capacity_solar_mw",
      "capacity_wind_added_28d_mw",
      "capacity_solar_added_28d_mw",
      "observed_constrained_off_hours_above_threshold_7d",
      "observed_constrained_off_total_7d_mwh",
      "observed_wind_capacity_factor_mean_7d",
      "observed_solar_capacity_factor_mean_7d",
      "observed_net_exchange_mean_24h_to_cutoff",
      "observed_reason_share_ene_7d",
      "observed_reason_share_cnf_7d",
      "observed_reason_share_rel_7d",
      "programmed_load_daily_min_mwh",
      "dessem_residual_load_min_of_day",
      "proxy_residual_load_min_of_day",
      "observed_export_utilisation_mean_24h_to_cutoff",
      "observed_corridor_utilisation_ne_se_max_7d",
    ]);
    for (const column of FEATURE_ROW_COLUMNS) {
      expect({ column, grain: featureGrain(column) }).toEqual({
        column,
        grain: day.includes(column) ? "day" : "hour",
      });
    }
    // The same-hour mean is deliberately *not* day grain: its window ends at
    // the cutoff, but which seven hours it averages is chosen by the target
    // row's local hour, so it genuinely varies across the day.
    expect(featureGrain("observed_constrained_off_same_hour_mean_7d")).toBe("hour");
    // Nor is the staleness: it is a distance from this hour to the cutoff.
    expect(featureGrain("observed_actual_lag_hours")).toBe("hour");
    // Nor is the system-wide residual load, which is constant across the four
    // subsystems of an hour and varies across the 24 hours of the day. This
    // marking is about the time axis only; "constant across subsystems" is a
    // different property with no column here to record it.
    expect(featureGrain("dessem_sin_residual_load_mwh")).toBe("hour");
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

describe("the feature dictionary, structurally", () => {
  /** The dictionary's own migration, read whole — prose, seed and all. */
  const DICTIONARY = readFileSync(
    join(MIGRATION_DIRECTORY, "0033_both_feature_sets_and_the_dictionary.sql"),
    "utf8",
  );

  /**
   * Every migration that seeds a dictionary entry, in tree order.
   *
   * Derived rather than listed, for the reason `featureMigrations()` above is:
   * `0033` seeded the first 111 and `0036` appends the 112th, and a later block
   * will append more. A test naming the migrations it reads is a test that
   * stops covering the ones it does not — which is the shape of mistake this
   * whole describe block is about.
   */
  const DICTIONARY_SEEDS = readdirSync(MIGRATION_DIRECTORY)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()
    .map((name) => readFileSync(join(MIGRATION_DIRECTORY, name), "utf8"))
    .filter((text) => text.includes("INSERT INTO feature_dictionary_entry ("));

  /** One seed statement's text, from its INSERT to its terminating semicolon. */
  const seedStatement = (text: string): string => {
    const start = text.indexOf("INSERT INTO feature_dictionary_entry (");
    return text.slice(start, text.indexOf(";", start));
  };

  /** The `column_name` of every seeded entry, in the order the tree writes it. */
  const seededEntries = (): string[] => {
    expect(DICTIONARY_SEEDS.length).toBeGreaterThan(0);
    return DICTIONARY_SEEDS.flatMap((text) =>
      [...seedStatement(text).matchAll(/^ {2}\('(\w+)',/gm)].map(
        (match) => match[1] as string,
      ),
    );
  };

  it("takes the columns from the type and never from a list of its own", () => {
    // The whole design, asserted at the one function that could betray it. A
    // dictionary that named its columns would be a second place the feature set
    // is written down — which is exactly what `ordered_features.yaml` is, and
    // why it already disagrees with its own authority.
    const body = DICTIONARY.slice(
      DICTIONARY.indexOf("CREATE OR REPLACE FUNCTION feature_dictionary()"),
      DICTIONARY.indexOf("COMMENT ON FUNCTION feature_dictionary()"),
    );
    expect(body.length).toBeGreaterThan(0);

    // Names, order, type and prose: all four come from the catalogue.
    expect(body).toContain("pg_attribute");
    expect(body).toContain("'feature_row'::regtype");
    expect(body).toContain("format_type(a.atttypid, a.atttypmod)");
    expect(body).toContain("col_description(attrs, a.attnum::integer)");
    expect(body).toContain("ORDER BY a.attnum");

    // And no column name is spelled inside it. The function mentions
    // `feature_row` and its own columns; it must not mention a *feature*.
    for (const column of FEATURE_ROW_COLUMNS) {
      if (column === "subsystem" || column === "feature_set") {
        continue; // `subsystem` and the set are the dictionary's own vocabulary.
      }
      expect({ column, spelled: body.includes(column) }).toEqual({
        column,
        spelled: false,
      });
    }
  });

  it("classifies every attribute the tree declares, and nothing else", () => {
    // The seed is checked against the *type's* attribute list rather than
    // against itself. A ticket that appends an attribute and forgets the entry
    // fails here without a database, and fails again at the function with one.
    expect(seededEntries()).toEqual([...FEATURE_ROW_COLUMNS]);
    expect(seededEntries()).toHaveLength(112);
  });

  it("refuses the whole answer rather than returning a gap in it", () => {
    // Three raises, and they are total in both directions: an attribute with no
    // entry, an entry with no attribute, and an attribute with no prose. A
    // dictionary with one unclassified column in it still reads like a
    // dictionary, and that column is exactly the one a reader will assume
    // somebody classified.
    const body = DICTIONARY.slice(
      DICTIONARY.indexOf("CREATE OR REPLACE FUNCTION feature_dictionary()"),
      DICTIONARY.indexOf("COMMENT ON FUNCTION feature_dictionary()"),
    );
    expect([...body.matchAll(/RAISE EXCEPTION/g)]).toHaveLength(3);
    expect(body).toContain("carry no dictionary entry");
    expect(body).toContain("name no feature_row attribute");
    expect(body).toContain("carry no catalogue comment");
    expect(body).toContain("Unclassified is not an option");
  });

  it("writes the prose once, at the column, for all 112 of them", () => {
    // The dictionary reads `col_description`, so a comment is not decoration —
    // it is the description column. Ticket 11 completed the thirty-five that
    // `0016`, `0019` and `0021` declared before the habit set in.
    const commented = new Set(
      [...RAW.matchAll(/COMMENT ON COLUMN feature_row\.(\w+) IS/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect([...FEATURE_ROW_COLUMNS].filter((column) => !commented.has(column))).toEqual(
      [],
    );
  });

  it("keeps the dropped features out of the type and their replacements in it", () => {
    // The sixth class. A dropped feature has no attribute — giving it a
    // dictionary row would break the derivation — so it lives in its own table,
    // and every replacement it names is checked against the type at runtime.
    const start = DICTIONARY.indexOf("INSERT INTO feature_dropped_feature (");
    const seed = DICTIONARY.slice(start, DICTIONARY.indexOf(";\n--> statement", start));
    expect(start).toBeGreaterThan(-1);

    const dropped = [...seed.matchAll(/^ {2}\('([^']+(?:''[^']*)*)',$/gm)];
    expect(dropped).toHaveLength(11);

    // Exactly one has no replacement column, and it is the one that is excluded
    // rather than replaced: a series richer at serve time than in training.
    expect([...seed.matchAll(/'\{\}'::text\[\]/g)]).toHaveLength(1);
    expect(seed).toContain("val_intercambioprogmwmed");

    // Every replacement named is a real attribute. The function raises on this
    // too; here it is checked without standing a server up.
    const replacements = new Set(
      [...seed.matchAll(/array\[([^\]]*)\]::text\[\]/g)].flatMap((match) =>
        [...(match[1] as string).matchAll(/'(\w+)'/g)].map((m) => m[1] as string),
      ),
    );
    expect(replacements.size).toBeGreaterThan(0);
    for (const column of replacements) {
      expect({ column, exists: FEATURE_ROW_COLUMNS.includes(column) }).toEqual({
        column,
        exists: true,
      });
    }
    // Non-vacuous on the point of the table: residual load was rebuilt in both
    // sets rather than abandoned, which is what keeps the product.
    expect(replacements.has("proxy_residual_load_mwh")).toBe(true);
    expect(replacements.has("dessem_residual_load_mwh")).toBe(true);
  });

  it("records the early-gate hole rather than repairing it", () => {
    // The finding ticket 06 made and ticket 09 inherited, carried into the
    // dictionary as data. `programmed_*` and every `proxy_*` column is NULL at
    // `gate_early` because the programme for day D is stamped D-1 15:00 BRT,
    // six hours after that gate — and reaching for an earlier hour would claim
    // an availability nothing has measured.
    // The six trailing booleans of a seed row, in the order the INSERT names
    // them: in_free, in_augmented, available_at_gate_early, is_proxy,
    // justifies_dessem_trade, model_input.
    const flags = DICTIONARY_SEEDS.flatMap((text) =>
      [
        ...text.matchAll(
          /^ {2}\('(\w+)',.*?, (true|false), (true|false), (true|false), (true|false), (true|false), (true|false)\)[,;]$/gm,
        ),
      ].map((match) => ({
        column: match[1] as string,
        inFree: match[2] === "true",
        availableEarly: match[4] === "true",
      })),
    );
    expect(flags).toHaveLength(112);

    const absentEarly = flags
      .filter((entry) => !entry.availableEarly)
      .map((entry) => entry.column)
      .toSorted();
    expect(absentEarly).toEqual(
      FEATURE_ROW_COLUMNS.filter(
        (column) =>
          column.startsWith("programmed_") ||
          column.startsWith("proxy_") ||
          column.startsWith("dessem_"),
      ).toSorted(),
    );
    // Five programmed, seven proxy, twenty-two DESSEM. The first twelve are
    // the ones set A loses at the early gate, and they are its spine.
    expect(absentEarly).toHaveLength(34);
    expect(absentEarly.filter((column) => !column.startsWith("dessem_"))).toHaveLength(
      12,
    );

    // Class `D` is the augmented set and nothing else: 22 names, none of them
    // in set A. The table's own CHECK makes the opposite unrepresentable; this
    // asserts the seed does not merely happen to comply.
    const dessemOnly = flags
      .filter((entry) => !entry.inFree)
      .map((entry) => entry.column);
    expect(dessemOnly).toHaveLength(22);
    expect(dessemOnly.every((column) => column.startsWith("dessem_"))).toBe(true);
  });

  it("expresses the A/B as three argument tuples and not as a second function", () => {
    // "All three configurations are expressible as arguments to the one
    // function; none needs a second code path." The check that no second path
    // was written is that this migration defines no row-building function at
    // all — it adds no attribute, restates no `feature_rows`, and changes no
    // value.
    expect(DICTIONARY).not.toContain("ALTER TYPE feature_row ADD ATTRIBUTE");
    expect(DICTIONARY).not.toContain("CREATE OR REPLACE FUNCTION feature_rows(");

    const start = DICTIONARY.indexOf("INSERT INTO feature_ab_configuration (");
    const seed = DICTIONARY.slice(start, DICTIONARY.indexOf(";\n--> statement", start));
    expect(start).toBeGreaterThan(-1);
    for (const run of ["A-full", "A-common", "B-common"]) {
      expect(seed).toContain(`('${run}'`);
    }
    // Two would confound feature content with window length, which is the whole
    // reason there are three.
    expect([...seed.matchAll(/^ {2}\('/gm)]).toHaveLength(3);
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
