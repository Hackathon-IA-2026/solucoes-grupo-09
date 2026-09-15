/**
 * The Explain screen's reading of the gateway, and the only place one happens.
 *
 * Like `lib/replay.ts` and `lib/network.ts`, this module computes nothing. It
 * has exactly one job the others do not: turning a wire `Driver` into the
 * `AttributedDriver` the bars draw, which is a narrower conversion than it
 * looks and has one honest gap in it.
 *
 * **The gap, stated rather than papered over.** The domain's `DriverReading` is
 * a sum type with three arms — a `quantity`, a `term` ("the day was a
 * weekend", "the subsystem was importing") and `none`. The reason the `term`
 * arm exists is written out in `packages/core/src/domain.ts`: `calendar_season`
 * declares `calendar_is_weekend` as its headline feature, and a numbers-only
 * model would force that onto the screen as `1`, which is a value the reader
 * cannot check against anything.
 *
 * **The wire has no `term` arm.** `Driver.observed` and `Driver.typical` are
 * `number | null` beside a `UnitCode`, so a response can express a quantity and
 * an absence and nothing else. Every reading mapped here is therefore a
 * `quantity` or a `none`, and `DriverTerm` is currently unreachable from a
 * response — a real contract gap between `docs/specs/diagnosis.md`'s reading
 * model and `common.schema.json`'s driver row, not a shortcut taken here. It is
 * not closed by guessing: special-casing `headline_feature ===
 * "calendar_is_weekend"` in this module would be the client inventing a
 * categorical reading the server never sent, under a label the server never
 * chose, which is a worse failure than printing the number the server did send.
 * It is reported as a gap and left for the contract to close.
 *
 * **An absent reading is absent and never zero.** `observed` and `typical` are
 * independently nullable and each carries its own reason from the closed set
 * `null_in_day` / `null_in_background`; three of the eight headline features
 * are in the weather block, which arrives from one model run and goes NULL
 * together, so this is the common case and not the odd one. `api-surface.md`
 * measured it: at a 5% row-level NULL rate, 99.2% of days hold at least one
 * NULL weather hour. The `none` arm makes the bars omit the pair line, which is
 * what the components already do for it.
 */

import type { AttributedDriver, DriverReading } from "@wattsteer/core";
import type { Driver, UnitCode } from "@wattsteer/core/api";

/**
 * How many digits a reading is printed to, by the unit it is in.
 *
 * A ratio at zero decimals is `1` and `1`, which is a bar whose caption says
 * the day was exactly typical when it was 42% above it. Energy and power at two
 * would be false precision on a figure whose band is hundreds of MWh wide. The
 * table is here rather than in a component because it is a property of the
 * quantity and not of the panel drawing it.
 */
const DECIMALS: Partial<Record<UnitCode, number>> = {
  ratio: 2,
  pct: 1,
  m_s: 1,
  hours: 1,
  mwh: 0,
  mw: 0,
  brl: 0,
  count: 0,
};

/**
 * Units that are appended to the number verbatim.
 *
 * `count` has no unit — "3" is three of whatever the feature counts, and a
 * suffix invented for it would be a word this module chose in one language.
 * `mwh`, `mw` and `m/s` read the same in both locales, which is why they are
 * appended at all rather than held in the dictionaries; `ratio` and `pct` are
 * notation the formatter already carries.
 */
const UNITS: Partial<Record<UnitCode, string>> = {
  mwh: "MWh",
  mw: "MW",
  m_s: "m/s",
  pct: "%",
  brl: "R$",
};

function reading(value: number | null, unit: UnitCode): DriverReading {
  if (value === null) {
    // An absence, carried as an absence. The row's own
    // `observed_absent_reason` says which kind it is and is not needed to draw
    // the bar — the pair line is omitted either way.
    return { kind: "none" };
  }
  return {
    kind: "quantity",
    value,
    decimals: DECIMALS[unit] ?? 1,
    unit: UNITS[unit],
  };
}

/**
 * One wire driver, with its headline readings attached.
 *
 * Everything else on the row travels untouched — `phi_mwh`, `share`,
 * `direction`, `hour_disagreement` and `demoted` are the server's and a client
 * may not move any of them. `lib/driver-rows.ts` applies the display cut and
 * the merge into `other` afterwards, which is where those rules live.
 */
export function attributedDriver(driver: Driver): AttributedDriver {
  return {
    ...driver,
    observed: reading(driver.observed, driver.unit),
    typical: reading(driver.typical, driver.unit),
  };
}

/** All eight groups, ranked as the gateway ranked them. */
export function attributedDrivers(drivers: readonly Driver[]): AttributedDriver[] {
  return drivers.map(attributedDriver);
}
