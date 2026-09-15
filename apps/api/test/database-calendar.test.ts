import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import {
  CALENDAR_GENERATOR,
  CALENDAR_VERSION,
  CalendarImmutableError,
  calendarDigest,
  loadCalendar,
  loadCalendarArtifact,
  readCalendarGeneration,
  storedCalendarDigest,
} from "../src/features/index.js";

/**
 * Seam 3 and Seam 4, against a real Postgres.
 *
 * These are the tests `docs/specs/feature-engineering.md` §"Testing Decisions"
 * names for this block, and they are all of the same kind: **the cases where an
 * off-by-one is invisible.** An hour encoding that is wrong at 23→0 looks right
 * for twenty-three hours a day. A day-of-year encoding that is wrong across the
 * new year looks right for 364 days. A holiday calendar with Carnival on the
 * wrong Tuesday is indistinguishable from a correct one except on the two days
 * a year that move the load curve most.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * A single solar centroid, in the middle of the Bahia solar fleet.
 *
 * The astronomy is asserted against closed-form answers rather than against a
 * recorded run: at solar noon the zenith angle is |latitude − declination|, and
 * that is checkable with a calculator, which is the only kind of expected value
 * worth pinning for a formula this easy to transcribe subtly wrong.
 */
const SOLAR_LATITUDE = -9;
const SOLAR_LONGITUDE = -40;

interface CalendarHourRow {
  valid_time: string;
  calendar_local_hour: number;
  calendar_hour_sin: number;
  calendar_hour_cos: number;
  calendar_doy_sin: number;
  calendar_doy_cos: number;
  calendar_day_of_week: number;
  calendar_is_weekend: boolean;
  calendar_is_holiday_national: boolean | null;
  calendar_is_day_before_holiday: boolean | null;
  calendar_is_bridge_day: boolean | null;
  solar_zenith_cos: number | null;
  solar_extraterrestrial_ghi: number | null;
}

suite("the calendar and the astronomy (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;

  const calendarDay = async (target: string): Promise<CalendarHourRow[]> => {
    const rows = await db.execute<CalendarHourRow & Record<string, unknown>>(
      sql`select * from feature_calendar_block(${target}::date) order by valid_time`,
    );
    return [...rows];
  };

  const shares = async (target: string): Promise<Map<string, number | null>> => {
    const rows = await db.execute<{
      subsystem: string;
      calendar_holiday_state_share: number | null;
    }>(sql`select * from feature_holiday_share_block(${target}::date)`);
    return new Map(
      [...rows].map((row) => [
        row.subsystem,
        row.calendar_holiday_state_share === null
          ? null
          : Number(row.calendar_holiday_state_share),
      ]),
    );
  };

  beforeAll(async () => {
    await db.execute(sql`truncate table feature_calendar_day`);
    await db.execute(sql`truncate table feature_calendar_generation cascade`);
    await db.execute(sql`truncate table centroid_point`);
    await db.execute(sql`truncate table centroid_set cascade`);
    await db.execute(sql`truncate table plant cascade`);

    await loadCalendar(db, loadCalendarArtifact());

    // The frozen solar geometry. One point, so the capacity-weighted mean of the
    // set is that point and the expected zenith is closed-form.
    await db.execute(sql`
      insert into centroid_set (
        version, source, geometry_digest, centroid_count, represented_mw,
        registry_as_of, fleet_on, freeze_located_mw, freeze_plants, collision_check
      ) values (
        'centroid_set_v1', 'hand_transcribed', 'sha256:calendar-test', 1, 1000,
        now(), now(), 1000, 1, 'asserted'
      )
    `);
    await db.execute(sql`
      insert into centroid_point (
        set_version, centroid_id, label, latitude, longitude, technology,
        represented_mw, origin, municipalities, plants, merged_from
      ) values
        ('centroid_set_v1', 'CAL_S1', 'Solar', ${SOLAR_LATITUDE}, ${SOLAR_LONGITUDE},
         'SOLAR', 1000, 'hand_transcribed', '', 1, ''),
        -- A wind point of the same set, twice the capacity and far to the south:
        -- it must not move the solar centroid, because the geometry the solar
        -- zenith is asked at is the *solar* fleet's.
        ('centroid_set_v1', 'CAL_W1', 'Wind', -30, -53,
         'WIND', 2000, 'hand_transcribed', '', 1, '')
    `);

    // ONS's electrical assignment, three states in NE and one in SE. The share
    // is a count over these.
    await db.execute(sql`
      insert into plant (
        ceg_core, ceg_raw, name, subsystem, state_code, technology,
        operation_modality, owner_name, operator_name
      ) values
        ('CAL_BA', 'CAL_BA', 'Bahia', 'NE', 'BA', 'WIND', 'TIPO_I', 'o', 'o'),
        ('CAL_CE', 'CAL_CE', 'Ceara', 'NE', 'CE', 'WIND', 'TIPO_I', 'o', 'o'),
        ('CAL_PE', 'CAL_PE', 'Pernambuco', 'NE', 'PE', 'SOLAR', 'TIPO_I', 'o', 'o'),
        ('CAL_SP', 'CAL_SP', 'Sao Paulo', 'SE', 'SP', 'SOLAR', 'TIPO_I', 'o', 'o')
    `);
  });

  afterAll(() => handle.close());

  // ------------------------------------------------------ the materialisation
  it("stores the artifact the pinned generator produced, and says which one", async () => {
    const generation = await readCalendarGeneration(db);
    const artifact = loadCalendarArtifact();
    expect(generation?.version).toBe(CALENDAR_VERSION);
    expect(generation?.generator).toBe(CALENDAR_GENERATOR);
    expect(generation?.day_count).toBe(artifact.days.length);
    expect(generation?.digest).toBe(artifact.digest);
  });

  it("puts the artifact in the table, row for row", async () => {
    // Not the stored digest column — that is the loader's claim. This is the
    // digest of what the table actually holds, recomputed from the rows.
    expect(await storedCalendarDigest(db)).toBe(
      calendarDigest(loadCalendarArtifact().days),
    );
  });

  it("regenerating at the pinned version writes nothing", async () => {
    // The spec's acceptance condition, and the reason the calendar is data:
    // reloading an unchanged calendar is a no-op rather than a restatement.
    const again = await loadCalendar(db, loadCalendarArtifact());
    expect(again.loaded).toBe(false);
    expect(again.digest).toBe(loadCalendarArtifact().digest);
  });

  it("refuses a changed calendar under a version that is already loaded", async () => {
    // A `holidays` upgrade that moved Carnival by one day, arriving as an
    // overwrite, is exactly the silent restatement of three years of training
    // features this design exists to prevent. It has to be a new version and a
    // retrain, and the refusal is where that decision is forced.
    const artifact = loadCalendarArtifact();
    const moved = {
      ...artifact,
      days: artifact.days.map((day, index) =>
        index === 0 ? { ...day, day: "2023-01-02" } : day,
      ),
    };
    let refusal: unknown;
    try {
      await loadCalendar(db, moved);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CalendarImmutableError);
    expect((refusal as Error).message).toContain("retrain trigger");
    // And nothing moved: the stored calendar is still the artifact's.
    expect(await storedCalendarDigest(db)).toBe(artifact.digest);
  });

  // -------------------------------------------------------- the encodings
  it("encodes the hour so that 23 → 0 is one step and not twenty-three", async () => {
    const rows = await calendarDay("2025-05-14");
    expect(rows).toHaveLength(24);
    expect(rows.map((row) => row.calendar_local_hour)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
      23,
    ]);

    // Every consecutive pair, the 23 → 0 wrap included, is the same 15° step
    // around the circle. This is the whole reason the encoding is a pair of
    // trig functions rather than the integer.
    const angles = rows.map((row) =>
      Math.atan2(Number(row.calendar_hour_sin), Number(row.calendar_hour_cos)),
    );
    const step = (from: number, to: number): number => {
      const delta = to - from;
      return ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    };
    for (let hour = 0; hour < 24; hour += 1) {
      const next = angles[(hour + 1) % 24] as number;
      expect(step(angles[hour] as number, next)).toBeCloseTo((2 * Math.PI) / 24, 9);
    }
    // Hour 0 sits at angle zero, and hour 6 a quarter turn on: the encoding is
    // anchored, not merely evenly spaced.
    expect(Number(rows[0]?.calendar_hour_sin)).toBeCloseTo(0, 12);
    expect(Number(rows[0]?.calendar_hour_cos)).toBeCloseTo(1, 12);
    expect(Number(rows[6]?.calendar_hour_sin)).toBeCloseTo(1, 12);
  });

  it("encodes the day of year so that 365 → 1 does not jump a year", async () => {
    const dayAngle = async (target: string): Promise<number> => {
      const [row] = await calendarDay(target);
      return Math.atan2(Number(row?.calendar_doy_sin), Number(row?.calendar_doy_cos));
    };
    const forwardDays = (from: number, to: number): number => {
      const delta = ((to - from) % (2 * Math.PI)) + 2 * Math.PI;
      return ((delta % (2 * Math.PI)) * 365.25) / (2 * Math.PI);
    };

    // An ordinary consecutive pair is one day apart.
    expect(
      forwardDays(await dayAngle("2025-06-10"), await dayAngle("2025-06-11")),
    ).toBeCloseTo(1, 6);

    // The new year. The period is 365.25 rather than 365, so the wrap out of a
    // common year is a 1.25-day step and the wrap out of a leap year is 0.25 —
    // the quarter-day the period exists to carry. What matters is that neither
    // is a discontinuity: a 365-day period would leap a whole day out of phase
    // every leap year and never come back.
    const commonYearWrap = forwardDays(
      await dayAngle("2025-12-31"),
      await dayAngle("2026-01-01"),
    );
    const leapYearWrap = forwardDays(
      await dayAngle("2024-12-31"),
      await dayAngle("2025-01-01"),
    );
    expect(commonYearWrap).toBeCloseTo(1.25, 6);
    expect(leapYearWrap).toBeCloseTo(0.25, 6);
    // Four years of wraps average one day, which is the property that keeps the
    // encoding in phase with the season across the whole training window.
    expect((3 * commonYearWrap + leapYearWrap) / 4).toBeCloseTo(1, 6);
  });

  it("has a 29 February, and puts it between the 28th and 1 March", async () => {
    const days = ["2024-02-28", "2024-02-29", "2024-03-01"];
    const angles: number[] = [];
    for (const day of days) {
      const [row] = await calendarDay(day);
      expect(row).toBeDefined();
      angles.push(
        Math.atan2(Number(row?.calendar_doy_sin), Number(row?.calendar_doy_cos)),
      );
    }
    expect(angles[0]).toBeLessThan(angles[1] as number);
    expect(angles[1]).toBeLessThan(angles[2] as number);
  });

  it("computes the weekday and the weekend in Brasília, from the UTC instant", async () => {
    // 2026-08-29 is a Saturday in Brasília. Its 21:00–23:00 local hours are
    // 00:00–02:00 UTC on the *Sunday*, and a weekday read off the UTC instant
    // would call three hours of every Saturday a Sunday.
    const rows = await calendarDay("2026-08-29");
    expect(new Set(rows.map((row) => row.calendar_day_of_week))).toEqual(new Set([6]));
    expect(rows.every((row) => row.calendar_is_weekend)).toBe(true);
    expect(new Date(rows[23]?.valid_time as string).toISOString()).toBe(
      "2026-08-30T02:00:00.000Z",
    );

    const weekday = await calendarDay("2026-08-31");
    expect(new Set(weekday.map((row) => row.calendar_day_of_week))).toEqual(new Set([1]));
    expect(weekday.every((row) => row.calendar_is_weekend)).toBe(false);
  });

  // --------------------------------------------------------- the holidays
  it("pins known holidays, moveable feasts included, across several years", async () => {
    const national = async (target: string): Promise<boolean | null> =>
      (await calendarDay(target))[0]?.calendar_is_holiday_national ?? null;

    for (const day of [
      "2024-02-12", // Carnaval, Monday
      "2024-03-29", // Sexta-feira Santa
      "2024-05-30", // Corpus Christi
      "2025-03-03", // Carnaval, Monday
      "2025-04-18", // Sexta-feira Santa
      "2025-06-19", // Corpus Christi
      "2025-04-21", // Tiradentes
      "2026-02-16", // Carnaval, Monday
      "2026-04-03", // Sexta-feira Santa
      "2026-06-04", // Corpus Christi
      "2026-12-25", // Natal
    ]) {
      expect({ day, holiday: await national(day) }).toEqual({ day, holiday: true });
    }
    // Ordinary days, chosen next to the feasts above: the day after Tiradentes,
    // the day before Corpus Christi, and the Thursday after Carnival — 2026's
    // Ash Wednesday is the 18th and is itself a holiday in this calendar, which
    // is what `categories=(PUBLIC, OPTIONAL)` buys.
    for (const day of ["2025-04-22", "2025-06-18", "2026-02-19"]) {
      expect({ day, holiday: await national(day) }).toEqual({ day, holiday: false });
    }
  });

  it("derives the day before and the bridge day from the same table", async () => {
    const day = async (target: string): Promise<CalendarHourRow> =>
      (await calendarDay(target))[0] as CalendarHourRow;

    // Sunday before Tiradentes: day-before, not a bridge (it is a weekend).
    const eve = await day("2025-04-20");
    expect(eve.calendar_is_day_before_holiday).toBe(true);
    expect(eve.calendar_is_bridge_day).toBe(false);

    // Corpus Christi 2025 falls on a Thursday, so the Friday is the classic
    // *enforcado* — a weekday wedged between a national holiday and a weekend.
    const bridge = await day("2025-06-20");
    expect(bridge.calendar_is_bridge_day).toBe(true);
    expect(bridge.calendar_is_holiday_national).toBe(false);

    // Carnival Monday is a holiday and the day before Carnival Tuesday. It is
    // both, and it is not a bridge: a holiday is not a bridge to itself.
    const carnival = await day("2025-03-03");
    expect(carnival.calendar_is_holiday_national).toBe(true);
    expect(carnival.calendar_is_day_before_holiday).toBe(true);
    expect(carnival.calendar_is_bridge_day).toBe(false);

    // An ordinary Friday after an ordinary Thursday is nothing at all.
    const ordinary = await day("2025-08-15");
    expect(ordinary.calendar_is_bridge_day).toBe(false);
    expect(ordinary.calendar_is_day_before_holiday).toBe(false);
  });

  it("reports null outside the loaded calendar rather than a confident false", async () => {
    // The artifact opens on 2023-01-01, so 2022-12-25 is Christmas Day and the
    // table has never heard of it. "Not a holiday" would be a lie the model
    // could not distinguish from the truth.
    const [outside] = await calendarDay("2022-12-25");
    expect(outside?.calendar_is_holiday_national).toBeNull();
    expect(outside?.calendar_is_day_before_holiday).toBeNull();
    expect(outside?.calendar_is_bridge_day).toBeNull();
    // The deterministic half is still computed: the date's structure is known
    // whether or not the holiday table reaches it.
    expect(outside?.calendar_day_of_week).toBe(0);
    expect(outside?.solar_zenith_cos).not.toBeNull();

    expect(await shares("2022-12-25")).toEqual(new Map());
  });

  // -------------------------------------------- the regional share, a proxy
  it("counts the subsystem's observing states, and counts national holidays as none", async () => {
    // NE holds BA, CE and PE in this fixture; SE holds SP.
    const bahia = await shares("2025-07-02"); // Independência da Bahia
    expect(bahia.get("NE")).toBeCloseTo(1 / 3, 12);
    expect(bahia.get("SE")).toBe(0);

    const paulista = await shares("2025-07-09"); // Revolução Constitucionalista
    expect(paulista.get("NE")).toBe(0);
    expect(paulista.get("SE")).toBe(1);

    // A national holiday is a binary, and it is *not* counted here. If the
    // generator stored the national days under each UF as well, this would read
    // 1.0 on every Tiradentes and the regional signal would be a copy of the
    // national one.
    const tiradentes = await shares("2025-04-21");
    expect(tiradentes.get("NE")).toBe(0);
    expect(tiradentes.get("SE")).toBe(0);

    // A subsystem ONS assigns no plant to has no states, and therefore no share
    // — absent rather than zero, because zero would claim a measurement.
    expect(shares.length).toBeGreaterThan(0);
    expect((await shares("2025-07-02")).has("N")).toBe(false);
  });

  // --------------------------------------------------------- the astronomy
  it("puts the sun where it is at solar noon, and below the horizon at night", async () => {
    // Southern summer solstice: declination −23.44°, so at −9° latitude the
    // noon zenith is 14.44° and its cosine 0.9684. The hour is sampled at its
    // midpoint, so the peak sits a few minutes off exact noon and the tolerance
    // is a hundredth rather than a millionth.
    const summer = await calendarDay("2025-12-21");
    const summerPeak = Math.max(...summer.map((row) => Number(row.solar_zenith_cos)));
    expect(summerPeak).toBeCloseTo(Math.cos(((-9 + 23.44) * Math.PI) / 180), 2);

    // Southern winter solstice, the same place: zenith 32.44°, cosine 0.8438.
    const winter = await calendarDay("2025-06-21");
    const winterPeak = Math.max(...winter.map((row) => Number(row.solar_zenith_cos)));
    expect(winterPeak).toBeCloseTo(Math.cos(((-9 - 23.44) * Math.PI) / 180), 2);

    // Local midnight is the far side of the earth, and the cosine is signed
    // there rather than clamped: "how far below the horizon" is information at
    // dawn and dusk that a clamp would flatten into one long night.
    expect(Number(summer[0]?.solar_zenith_cos)).toBeLessThan(0);
  });

  it("makes extraterrestrial irradiance the denominator a clearness index can use", async () => {
    const summer = await calendarDay("2025-12-21");

    for (const row of summer) {
      const zenith = Number(row.solar_zenith_cos);
      const ghi = Number(row.solar_extraterrestrial_ghi);
      // Clamped at zero: a negative irradiance is not a darker night.
      expect(ghi).toBeGreaterThanOrEqual(0);
      if (zenith <= 0) {
        expect(ghi).toBe(0);
      } else {
        expect(ghi).toBeGreaterThan(0);
      }
    }

    // The solar constant times the eccentricity correction bounds it: 1361 W/m²
    // at a zenith of zero, and ~3.4% more in early January than the mean.
    const peak = Math.max(...summer.map((row) => Number(row.solar_extraterrestrial_ghi)));
    expect(peak).toBeGreaterThan(1300);
    expect(peak).toBeLessThan(1361 * 1.035);

    // Perihelion is in early January, so the top-of-atmosphere maximum is
    // higher in the southern summer than in the southern winter by more than
    // the geometry alone would give. Not a rounding term: the two solstices
    // differ by about 7% in the eccentricity factor.
    const winter = await calendarDay("2025-06-21");
    const winterPeak = Math.max(
      ...winter.map((row) => Number(row.solar_extraterrestrial_ghi)),
    );
    expect(peak).toBeGreaterThan(winterPeak);
  });

  it("reports no geometry at all when no centroid set is frozen", async () => {
    // `greatest(x, 0)` ignores NULLs, so a careless clamp would report a
    // confident 0 W/m² at every hour of every day — a perfectly plausible night
    // and completely wrong at noon. Both columns go null together or neither
    // does.
    let zenith: number | null = 0;
    let ghi: number | null = 0;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from centroid_point where set_version = 'centroid_set_v1'`,
        );
        const rows = await tx.execute<{
          solar_zenith_cos: number | null;
          solar_extraterrestrial_ghi: number | null;
        }>(sql`select * from feature_calendar_block('2025-12-21'::date) limit 1`);
        const [row] = [...rows];
        zenith = row?.solar_zenith_cos ?? null;
        ghi = row?.solar_extraterrestrial_ghi ?? null;
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(zenith).toBeNull();
    expect(ghi).toBeNull();
  });

  it("weights the geometry by solar capacity and ignores the wind fleet", async () => {
    // The fixture's wind point carries twice the MW and sits 2,300 km south. If
    // the centroid were the whole set's rather than the solar fleet's, the noon
    // zenith would be wrong by roughly fourteen degrees of latitude.
    const [point] = [
      ...(await db.execute<{ latitude: number; longitude: number }>(
        sql`select latitude, longitude from canonical_solar_centroid
            where set_version = 'centroid_set_v1'`,
      )),
    ];
    expect(Number(point?.latitude)).toBeCloseTo(SOLAR_LATITUDE, 9);
    expect(Number(point?.longitude)).toBeCloseTo(SOLAR_LONGITUDE, 9);
  });

  // ------------------------------------------------------------ the canary
  it("asserts exactly 24 distinct local hours, and fails loudly otherwise", async () => {
    // Brazil has observed no summer time since 2019 and the whole feature
    // window is DST-free, so no DST handling is built. Should it be reinstated,
    // the first affected target date fails here rather than silently carrying a
    // duplicated or a missing hour into every feature built for it.
    const sqlStateOf = (error: unknown): string | undefined => {
      let current: unknown = error;
      for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string" && /^\d{5}$/.test(code)) {
          return code;
        }
        current = (current as { cause?: unknown }).cause;
      }
    };

    for (const dstDay of ["2018-11-04", "2019-02-16"]) {
      const outcome = await db
        .execute(sql`select * from feature_calendar_block(${dstDay}::date)`)
        .then(
          () => "resolved",
          (error: unknown) => sqlStateOf(error),
        );
      expect({ dstDay, outcome }).toEqual({ dstDay, outcome: "22023" });
    }

    const rows = await calendarDay("2025-05-14");
    expect(new Set(rows.map((row) => row.calendar_local_hour)).size).toBe(24);
  });
});
