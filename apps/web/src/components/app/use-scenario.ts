/**
 * The React binding for the scenario in the URL.
 *
 * Split from `scenario.ts` for the reason `use-app-params.ts` is split from
 * `params.ts`: the rules worth testing — the canonical encoding, the refusal
 * table, the one-battery-one-load shape — stay importable without pulling in
 * expo-router and, through it, all of React Native. What is left here is the
 * three pieces of wiring that genuinely need a component:
 *
 *  1. **A draft, so a stepper is not laggy.** Presses land in local state
 *     immediately and reach the address bar on a trailing debounce. The URL is
 *     the storage; it is not the input buffer.
 *  2. **The URL wins when it changes from outside.** A back button, a pasted
 *     link or a fresh load supersedes anything half-stepped, so the scenario a
 *     reader is looking at is always the scenario the address bar says.
 *  3. **The address bar always carries one.** On a first visit with no `?s=`,
 *     the default scenario is written immediately rather than on the first
 *     edit, so the link is shareable before anything is touched.
 */

import type { TargetDateRule } from "@wattsteer/core";
import type { Scenario } from "@wattsteer/core/api";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debounce, SCENARIO_COMMIT_MS } from "@/lib/debounce";
import type { SubsystemCode } from "@/lib/fixtures";
import {
  defaultScenario,
  readScenario,
  refusalCode,
  SCENARIO_PARAM,
  type ScenarioReadout,
  withSubsystem,
  withTargetDate,
  writeScenario,
} from "./scenario";

export interface ScenarioBinding {
  /** What the address bar decodes to, or the code that refused it. */
  readout: ScenarioReadout;
  /** What to draw: the pending edit if there is one, else the decoded scenario. */
  scenario: Scenario | null;
  /** Edit. Lands in state now and in the URL after {@link SCENARIO_COMMIT_MS}. */
  update: (next: Scenario) => void;
  /** Edit and commit at once — for a control that is not dragged. */
  commit: (next: Scenario) => void;
  /** Back to `REFERENCE_FLEET`, immediately. The way out of a refused link. */
  reset: () => void;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What differs between the two screens that carry a scenario.
 *
 * Both defaults are Mitigate's, because Mitigate is the screen a `Scenario` was
 * designed for and the Time Machine is the one that reads the same document
 * with a different question in mind.
 */
export interface ScenarioOptions {
  /**
   * The `target_date` clause to validate under.
   *
   * `docs/specs/replay.md` seam 10 states the parity claim and its one
   * exception in the same breath — *"scenario validation parity with
   * `/v1/optimize` **minus its date clause**"* — because the two endpoints
   * cannot agree there: a 2024-06 target is a perfectly good planning date and
   * is refused by a replay as pre-F1, and tomorrow is a planning date and is
   * not a day that has happened. So the rule is a parameter, and it is
   * `@wattsteer/core`'s own — the same function the gateway runs, never a
   * second spelling of it on this side.
   */
  targetDate?: TargetDateRule;
  /**
   * Rewrite the blob when the selection's day moves.
   *
   * Off by default. On Mitigate the day is the day being planned and it does
   * not move; on the Time Machine it *is* the selection, so a reader picking
   * another day must not be left looking at a link that still names the
   * previous one — the same reasoning that already makes the subsystem follow
   * the selection bar.
   */
  followTargetDate?: boolean;
}

export function useScenario(
  subsystem: SubsystemCode,
  targetDate: string,
  options: ScenarioOptions = {},
): ScenarioBinding {
  const { targetDate: targetDateRule, followTargetDate = false } = options;
  const raw = first(useLocalSearchParams()[SCENARIO_PARAM]);
  const fallback = useMemo(
    () => defaultScenario(subsystem, targetDate),
    [subsystem, targetDate],
  );
  const readout = useMemo(
    () => readScenario(raw, fallback, { targetDate: targetDateRule }),
    [raw, fallback, targetDateRule],
  );

  const [draft, setDraft] = useState<Scenario | null>(null);
  const [writeRefusal, setWriteRefusal] = useState<ScenarioReadout | null>(null);

  // A blob that changed from outside supersedes a pending edit. Compared
  // against the last one seen rather than against the last one written, so a
  // back button that lands on a scenario this session happened to visit is
  // still honoured.
  const seen = useRef<string | undefined>(raw);
  useEffect(() => {
    if (seen.current !== raw) {
      seen.current = raw;
      setDraft(null);
      setWriteRefusal(null);
    }
  }, [raw]);

  const write = useCallback((next: Scenario) => {
    try {
      router.setParams({ [SCENARIO_PARAM]: writeScenario(next) });
      setWriteRefusal(null);
    } catch (cause) {
      // The one refusal an *edit* can produce: a scenario too large to be a
      // link. Refused here as well as on the way in, because a screen that
      // silently kept a fleet it could not share would be lying about the URL
      // being the storage.
      setWriteRefusal({ ok: false, code: refusalCode(cause) });
    }
  }, []);

  const debounced = useMemo(() => debounce(write, SCENARIO_COMMIT_MS), [write]);
  useEffect(() => debounced.cancel, [debounced]);

  const update = useCallback(
    (next: Scenario) => {
      setDraft(next);
      debounced.call(next);
    },
    [debounced],
  );

  const commit = useCallback(
    (next: Scenario) => {
      setDraft(next);
      debounced.cancel();
      write(next);
    },
    [debounced, write],
  );

  // The address bar carries a scenario from the first paint, and follows the
  // selection bar when the reader moves to another subsystem — one subsystem
  // per scenario is `SUBSYSTEM_MISMATCH`, so the assets move with it.
  useEffect(() => {
    if (raw === undefined) {
      write(fallback);
      return;
    }
    if (readout.ok && readout.scenario.subsystem !== subsystem) {
      write(withSubsystem(readout.scenario, subsystem));
      return;
    }
    if (followTargetDate && readout.ok && readout.scenario.targetDate !== targetDate) {
      write(withTargetDate(readout.scenario, targetDate));
    }
  }, [raw, readout, subsystem, targetDate, followTargetDate, fallback, write]);

  const reset = useCallback(() => {
    debounced.cancel();
    setDraft(null);
    write(fallback);
  }, [debounced, fallback, write]);

  const effective = writeRefusal ?? readout;
  return {
    readout: effective,
    scenario: draft ?? (effective.ok ? effective.scenario : null),
    update,
    commit,
    reset,
  };
}
