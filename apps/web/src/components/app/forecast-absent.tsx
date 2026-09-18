/**
 * The forecast is missing, and this says both halves of why.
 *
 * **Two facts, and neither alone is the answer.**
 *
 * The first is the **clause that refused**, from the closed enum, rendered as
 * `copy.error[code]` in the reader's locale — exactly as the Time Machine
 * renders `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`. Today that code is
 * `FORECAST_NOT_YET_PUBLISHED` before tonight's gate and `FORECAST_UNAVAILABLE`
 * after it, and both are true sentences: nothing was published for this day.
 *
 * The second is **why nothing was published**, which those codes cannot say.
 * `apps/api/src/api/forecast.ts` is explicit that it does not know — the route
 * resolves from Postgres and has no view of the artifact volume, and
 * `apps/api/test/forecast-day-ahead.test.ts` asserts it never answers
 * `MODEL_UNAVAILABLE`. Its message ends "See /v1/meta for the artifact lane
 * state", and this component is the screen doing that. Without it a reader is
 * told a publication is missing and left to guess between a gate that has not
 * struck, a job that failed, and a model that was refused — three situations
 * with three different answers to "should I wait?".
 *
 * **What the lane line does not carry.** `MetaLane.unusable_reason` is the
 * gate's own prose, in English, from the modelling service — "guardrails:
 * coverage_p10_in_band: 0.8114 against [0.85, 0.97] …". It is the most specific
 * sentence in the building and it is developer prose in the same status as an
 * error envelope's `message`: `apps/web/test/error-copy.test.ts` forbids a
 * screen rendering that, and printing an English paragraph to a Portuguese
 * reader is the failure the whole i18n rule exists to prevent. So the lane's
 * **condition** travels as a code and the dictionaries say the words; the
 * evidence stays on `/v1/meta`, for the operator it was written for.
 */

import type { ErrorCode } from "@wattsteer/core";
import { Badge, space, usePalette } from "@wattsteer/ui";
import { Platform, Text, View } from "react-native";
import { useCopy } from "@/i18n";
import { fill } from "@/i18n/format";
import { HonestyNote } from "./honesty";
import { useServing } from "./use-serving";

export function ForecastAbsent({
  code,
  title,
  note,
  lanes = true,
}: {
  /** The clause that refused, from the closed enum. */
  code: ErrorCode;
  title: string;
  /** What the screen is showing instead. The screen's own sentence. */
  note: string;
  /**
   * Whether to print the serving-lane directory under the sentence.
   *
   * It is a property of the **deployment**, not of this panel, and it was
   * rendered once per panel. On the unified `/app` that meant a reader in the
   * state production is in met the same fact five times before the fold:
   * the chrome badge, the lede, the run pills' disabled hint, and then two full
   * copies of the directory and its paragraph — Visão da rede's and Explicar's.
   *
   * Five statements of one fact teach a reader to skip all five, including the
   * one that will someday say something different. The same argument
   * `ObservedBadge` already won: a mark that is on everything carries what a
   * mark on nothing carries. Each section keeps its own one-line sentence,
   * which is the part that differs; the directory is printed once.
   */
  lanes?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const serving = useServing();

  return (
    <View style={{ gap: space.sm }}>
      <HonestyNote
        title={title}
        tone="warning"
        points={[
          // The typed code, in the reader's locale. The envelope's own
          // `message` is developer prose for a log and never reaches a screen.
          copy.error[code],
          note,
        ]}
      />
      {lanes && serving.status === "known" ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            {copy.app.lane.heading}
          </Text>
          {serving.lanes.length === 0 ? (
            <Text style={{ fontSize: 11, color: colors.inkFaint }}>
              {serving.modelReachable
                ? copy.app.lane.noLanes
                : copy.app.lane.modelUnreachable}
            </Text>
          ) : (
            serving.lanes.map((lane) => (
              <View
                key={lane.name}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  // The row must be allowed to give way: at 320 px this pair —
                  // a 31-character lane directory and its badge — ran 37 px past
                  // the viewport. react-native-web defaults `flexShrink` to 0,
                  // so without this the row keeps its content width whatever the
                  // box is (ADR-0001).
                  flexShrink: 1,
                  minWidth: 0,
                  gap: 6,
                }}
              >
                {/*
                  The lane directory name is data and travels untranslated — it
                  is the identifier an operator greps for, and a translated lane
                  name would match nothing on the volume.
                */}
                <Text
                  style={{
                    fontSize: 11,
                    color: colors.inkFaint,
                    fontVariant: ["tabular-nums"],
                    flexShrink: 1,
                    /*
                      `dessem_free_v1__gate_late__thr5` has no space in it, so a
                      narrow box cannot wrap it and it overflows instead. This is
                      the one place in the product where that is true, and the
                      name must stay whole: it is the identifier an operator
                      greps for on the volume, so it breaks across lines rather
                      than being cut.
                    */
                    ...(Platform.OS === "web"
                      ? ({ overflowWrap: "anywhere" } as object)
                      : null),
                  }}
                >
                  {lane.name}
                </Text>
                <Badge
                  label={copy.app.lane.condition[lane.condition]}
                  tone={lane.condition === "promoted" ? "accent" : "warning"}
                />
              </View>
            ))
          )}
        </View>
      ) : null}
      {lanes && serving.status === "known" && serving.lanes.length > 0 ? (
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          {fill(copy.app.lane.note, { count: String(serving.lanes.length) })}
        </Text>
      ) : null}
    </View>
  );
}
