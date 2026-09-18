import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { validate } from "../../../packages/core/src/schema.js";
import { createGridRoutes } from "../src/api/grid.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { type ContextHourRow, summariseDay } from "../src/contract/grid-context.js";

/**
 * `/v1/grid/context` — what ONS planned beside what the grid did.
 *
 * The join itself needs real Postgres and belongs to the database suite. What
 * is provable here is the part that decides what a reader is told: **when the
 * day's deviation is allowed to exist**, and the refusals in front of the read.
 *
 * That is where this route can mislead. Both ONS series arrive at different
 * times — the programme on D−1, the settlement hours after the fact — so for
 * most of a day one side is present and the other is not, and a subtraction
 * over whichever hours happen to overlap would be published under a label that
 * says "the day".
 */

const routes = new Elysia().use(errorHandler).use(createGridRoutes({ db: undefined }));

const get = (query: string): Promise<Response> =>
  routes.handle(new Request(`http://localhost/v1/grid/context${query}`));

const HOUR_MS = 3_600_000;
const START = Date.UTC(2026, 8, 17, 3);

function hour(index: number, over: Partial<ContextHourRow> = {}): ContextHourRow {
  return {
    validTime: new Date(START + index * HOUR_MS),
    programmedLoadMwh: null,
    observedLoadMwh: null,
    observedWindMwh: null,
    observedSolarMwh: null,
    observedHydroMwh: null,
    observedThermalMwh: null,
    observedNetExchangeMwh: null,
    availableCapacityMw: null,
    ...over,
  };
}

describe("the day's deviation exists only where both series describe the day", () => {
  it("a whole day on both sides is a deviation, and it is a subtraction", () => {
    const hours = [
      hour(0, { programmedLoadMwh: 100, observedLoadMwh: 118 }),
      hour(1, { programmedLoadMwh: 200, observedLoadMwh: 181 }),
    ];
    const day = summariseDay(hours);
    expect(day.programmedLoadMwh).toBe(300);
    expect(day.observedLoadMwh).toBe(299);
    expect(day.deviationMwh).toBe(-1);
    expect(day.deviationUnavailableReason).toBeNull();
    expect(day.hoursCompared).toBe(2);
  });

  it("no programme is not a deviation of the whole settled day", () => {
    // The state of every day before its D−1. Reporting `observed − 0` here
    // would publish the day's entire load as a deviation from plan.
    const day = summariseDay([hour(0, { observedLoadMwh: 118 })]);
    expect(day.deviationMwh).toBeNull();
    expect(day.deviationUnavailableReason).toBe("no_programme_published");
    expect(day.observedLoadMwh).toBe(118);
  });

  it("an unsettled day is not a deviation either", () => {
    // Tomorrow, all day. The programme is published and nothing has happened
    // yet, which is the state this route is most often read in.
    const day = summariseDay([hour(0, { programmedLoadMwh: 100 })]);
    expect(day.deviationMwh).toBeNull();
    expect(day.deviationUnavailableReason).toBe("day_not_settled");
    expect(day.programmedLoadMwh).toBe(100);
  });

  it("a partial overlap is named, not silently measured over its overlap", () => {
    // Both sides exist; they do not describe the same hours. 118 − 100 = 18 is
    // a true statement about hour 0 and would be printed as the day's.
    const day = summariseDay([
      hour(0, { programmedLoadMwh: 100, observedLoadMwh: 118 }),
      hour(1, { programmedLoadMwh: 200 }),
    ]);
    expect(day.deviationMwh).toBeNull();
    expect(day.deviationUnavailableReason).toBe("partial_overlap");
    // The two totals still publish: each is a true sum over the hours it has.
    expect(day.programmedLoadMwh).toBe(300);
    expect(day.observedLoadMwh).toBe(118);
    expect(day.hoursCompared).toBe(1);
  });

  it("a day with neither series says so without pretending to a zero", () => {
    const day = summariseDay([hour(0)]);
    expect(day.programmedLoadMwh).toBeNull();
    expect(day.observedLoadMwh).toBeNull();
    expect(day.deviationMwh).toBeNull();
    expect(day.hoursCompared).toBe(0);
  });

  it("an hour settled at zero is a measurement and enters the sum", () => {
    // The distinction the nulls exist for, from the other side: a load of zero
    // is a fact and must not be read as "not settled".
    const day = summariseDay([hour(0, { programmedLoadMwh: 0, observedLoadMwh: 0 })]);
    expect(day.deviationMwh).toBe(0);
    expect(day.deviationUnavailableReason).toBeNull();
    expect(day.hoursCompared).toBe(1);
  });
});

describe("the route parses before it reads", () => {
  it("a malformed date is a 400, with no database behind it", async () => {
    // `BAD_INPUT`, the same code and status `/v1/curtailment/reasons` answers a
    // malformed civil date with — and reached with `db: undefined`, which is
    // the whole assertion: the parse happens before the read, so a caller
    // holding a bad request is told that rather than that the service is down.
    const response = await get("?subsystem=NE&date=17-09-2026");
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("BAD_INPUT");
  });

  it("a subsystem outside the enum is refused by the schema", async () => {
    expect((await get("?subsystem=SIN&date=2026-09-17")).status).toBe(422);
  });

  it("a well-formed request with no persistence is an absence, not a 500", async () => {
    const response = await get("?subsystem=NE&date=2026-09-17");
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("DATA_UNAVAILABLE");
  });
});

describe("the shape the wire promises", () => {
  it("an empty day validates — every field nullable is the point", () => {
    // The response for tomorrow morning, which is the common case and the one
    // a schema with non-nullable numbers would have made unrepresentable.
    const empty = {
      subsystem: "NE",
      date: "2026-09-19",
      as_of: "2026-09-18T04:00:00Z",
      hours: [],
      day: {
        programmed_load_mwh: null,
        observed_load_mwh: null,
        deviation_mwh: null,
        deviation_unavailable_reason: "no_programme_published",
        hours_compared: 0,
      },
      corridors: [],
    };
    expect(validate("grid-context.schema.json", empty).valid).toBe(true);
  });

  it("a deviation without a reason and without a number is unrepresentable", () => {
    const body = {
      subsystem: "NE",
      date: "2026-09-17",
      as_of: "2026-09-18T04:00:00Z",
      hours: [],
      day: {
        programmed_load_mwh: 100,
        observed_load_mwh: 118,
        deviation_mwh: null,
        // Missing `deviation_unavailable_reason`: a blank where a claim
        // belongs, which is the shape this product refuses everywhere.
        hours_compared: 1,
      },
      corridors: [],
    };
    expect(validate("grid-context.schema.json", body).valid).toBe(false);
  });
});

describe("availability is a power and is never summed over a day", () => {
  /*
    `val_disponibilidade` is MW. It adds across the reporting entities of one
    hour — powers add at an instant — and adding it across hours would produce
    twenty-four times a megawatt figure, which is not a quantity. The read
    therefore carries it per hour and the day block has no availability field
    at all, which is the version of this rule a schema can enforce.
  */
  it("the day block has nowhere to put an availability total", () => {
    const day = summariseDay([]);
    expect(Object.keys(day).sort()).toEqual([
      "deviationMwh",
      "deviationUnavailableReason",
      "hoursCompared",
      "observedLoadMwh",
      "programmedLoadMwh",
    ]);
  });

  it("the wire refuses one too", () => {
    const body = {
      subsystem: "NE",
      date: "2026-09-17",
      as_of: "2026-09-18T04:00:00Z",
      hours: [],
      day: {
        programmed_load_mwh: null,
        observed_load_mwh: null,
        deviation_mwh: null,
        deviation_unavailable_reason: "day_not_settled",
        hours_compared: 0,
        // The field somebody will reach for. `additionalProperties: false` is
        // what stops it becoming a number on a screen.
        available_capacity_mw: 4200,
      },
      corridors: [],
    };
    expect(validate("grid-context.schema.json", body).valid).toBe(false);
  });

  it("an hour with no entity reporting it is null, not zero", () => {
    // "Nobody reported availability" and "zero megawatts were available" are
    // different facts, and only the first is ever true here.
    const empty = {
      subsystem: "NE",
      date: "2026-09-17",
      as_of: "2026-09-18T04:00:00Z",
      hours: [
        {
          valid_time: "2026-09-17T03:00:00Z",
          programmed_load_mwh: 100,
          observed_load_mwh: null,
          observed_wind_mwh: null,
          observed_solar_mwh: null,
          observed_hydro_mwh: null,
          observed_thermal_mwh: null,
          observed_net_exchange_mwh: null,
          available_capacity_mw: null,
        },
      ],
      day: {
        programmed_load_mwh: 100,
        observed_load_mwh: null,
        deviation_mwh: null,
        deviation_unavailable_reason: "day_not_settled",
        hours_compared: 0,
      },
      corridors: [],
    };
    expect(validate("grid-context.schema.json", empty).valid).toBe(true);
  });
});
