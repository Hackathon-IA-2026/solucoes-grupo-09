import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { AppError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import type { ForecastGateProfile } from "../forecast/publication.js";

/**
 * A refusal the system declared, written down where a schedule can read it.
 *
 * `apps/ml` answers a diagnosis publication it cannot make with
 * `DIAGNOSIS_UNAVAILABLE` and a **typed condition** — one of
 * `wattsteer_ml.diagnosis.publish.REFUSAL_CONDITIONS`. That is the system
 * working: the forecast is fine, its explanation is not available, and the
 * repair is a retrain or a line of YAML rather than a retry. Before this module
 * the statement lived in a `console.warn` in a worker log, which is to say it
 * did not live anywhere a watch could read.
 *
 * Why that matters, and why this is a *ledger* rather than a log line: the
 * chained `publish_diagnosis` has two ways of leaving an attribution absent,
 * and they are opposites. A broken chain — never queued, never ran, or dead in
 * its retries — is the failure `forecast/publication-watch.ts` now alarms on. A
 * declared refusal is not a missed publication at all, and a watch that could
 * not tell them apart would fire on every legitimately unexplainable lane-day
 * until somebody switched it off.
 *
 * Everything here writes; nothing here is read by the request path. See the
 * table's own note in `database/schema.ts` for why
 * `/v1/diagnosis/day-ahead` still answers an absent attribution as its own
 * absence rather than reaching for a reason.
 */

/**
 * The conditions `apps/ml` distinguishes, as this side spells them.
 *
 * The authority is Python — `REFUSAL_CONDITIONS` in
 * `apps/ml/src/wattsteer_ml/diagnosis/publish.py` — and
 * `test/publication-watch.test.ts` parses that tuple out of the source and
 * fails if this list stops agreeing with it. So a fifth condition shipped
 * upstream lands as a failing test rather than as a refusal that this side
 * silently declines to record; and the table's CHECK, which is the same four,
 * refuses a row that named something else.
 *
 * `null_headline_feature` is not among them and was, until this wave. A NULL
 * headline feature is now a stated absence on the driver row — `observed` and
 * `typical` go `null` beside a reason code — and the ranking publishes, so a
 * whole day is no longer refused over a subtitle. It is named here so that
 * "there are four, and this is the one that left" is a fact rather than a
 * paragraph somebody has to remember.
 */
export const DIAGNOSIS_REFUSAL_CONDITIONS = [
  "no_base_fit_window",
  "no_matched_background",
  "contract_and_groups_disagree",
  "incomplete_day",
] as const;

export type DiagnosisRefusalCondition = (typeof DIAGNOSIS_REFUSAL_CONDITIONS)[number];

/** A refusal, as it comes back off the ledger. */
export interface DiagnosisRefusalRecord {
  targetDate: string;
  gateProfile: ForecastGateProfile;
  lane: string;
  condition: DiagnosisRefusalCondition;
  reason: string;
  /** The worker's clock at the attempt that was refused. */
  observedAt: Date;
}

export function isDiagnosisRefusalCondition(
  value: unknown,
): value is DiagnosisRefusalCondition {
  return (
    typeof value === "string" &&
    (DIAGNOSIS_REFUSAL_CONDITIONS as readonly string[]).includes(value)
  );
}

/**
 * The condition an error *declares*, or `null` for every other failure.
 *
 * Deliberately narrow on both halves. The code must be `DIAGNOSIS_UNAVAILABLE`
 * — the one `packages/core` reserves for "the forecast is fine and its
 * attribution is not" — and `details.condition` must be one of the four. A 503
 * from a modelling service that is down, a `SERVICE_BUSY` that ran out of
 * budget, a 404 with no code in it, or a `DIAGNOSIS_UNAVAILABLE` carrying a
 * condition nobody has heard of are all *not* declared refusals: they are the
 * chain failing, they must reach the watch as the alarm they are, and recording
 * them here would be the watch's own off switch.
 */
export function refusalCondition(error: unknown): DiagnosisRefusalCondition | null {
  if (!(error instanceof AppError) || error.code !== "DIAGNOSIS_UNAVAILABLE") {
    return null;
  }
  const condition = error.details?.condition;
  return isDiagnosisRefusalCondition(condition) ? condition : null;
}

/**
 * Write the refusal down, replacing whatever this lane-day said before.
 *
 * `expected_published_at` is `gate_at(target_date, gate_profile)`, called here
 * and checked again by the table: the refusal is stamped with the instant the
 * attribution it stands in place of would have carried, and no hour is spelled
 * out on this path.
 *
 * The upsert is the whole storage policy. One `(target_date, gate_profile,
 * lane)` has one current answer — the most recent time that chain was asked and
 * refused — because each of the queue's attempts refuses again and three rows
 * saying the same thing at ten-second intervals is not three refusals. What is
 * lost is the history, which the worker log keeps; what is needed is
 * `observed_at`, which is how a watch tells a refusal of *this* publication
 * from a stale statement about a previous vintage of the same day.
 */
export async function recordDiagnosisRefusal(
  db: Database,
  refusal: {
    targetDate: string;
    gateProfile: ForecastGateProfile;
    lane: string;
    condition: DiagnosisRefusalCondition;
    reason: string;
    observedAt: Date;
  },
): Promise<void> {
  const expectedPublishedAt = gateAt(refusal.targetDate, refusal.gateProfile);
  await db.execute(sql`
    insert into diagnosis_publication_refusal
      (target_date, gate_profile, lane, expected_published_at,
       condition, reason, observed_at)
    values (
      ${refusal.targetDate}::date,
      ${refusal.gateProfile}::forecast_gate_profile,
      ${refusal.lane},
      ${expectedPublishedAt.toISOString()}::timestamptz,
      ${refusal.condition},
      ${refusal.reason},
      ${refusal.observedAt.toISOString()}::timestamptz
    )
    on conflict on constraint diagnosis_publication_refusal_pk do update set
      expected_published_at = excluded.expected_published_at,
      condition = excluded.condition,
      reason = excluded.reason,
      observed_at = excluded.observed_at
  `);
}

/**
 * The refusals recorded for one gate's day, newest first.
 *
 * Every lane, not one: the payload's lane is a function of the gate profile
 * today (`PUBLICATION_LANES`), and a second lane per gate is a change this read
 * should survive rather than one that should quietly narrow it. The caller
 * decides what a refusal means; this returns what was said.
 *
 * Not a canonical read and not wrapped in the axes: the table carries no
 * `ingested_at` and no canonical view projects it, so there is no `as_of` to
 * apply. What the caller compares against instead is `observed_at`.
 */
export async function readDiagnosisRefusals(
  db: Database,
  where: { targetDate: string; gateProfile: ForecastGateProfile },
): Promise<DiagnosisRefusalRecord[]> {
  const rows = await db.execute<{
    target_date: string;
    gate_profile: string;
    lane: string;
    condition: string;
    reason: string;
    observed_at: string;
  }>(sql`
    select target_date, gate_profile, lane, condition, reason, observed_at
    from diagnosis_publication_refusal
    where target_date = ${where.targetDate}::date
      and gate_profile = ${where.gateProfile}::forecast_gate_profile
    order by observed_at desc
  `);
  return [...rows].map((row) => {
    if (!isDiagnosisRefusalCondition(row.condition)) {
      // Unreachable while the table's CHECK holds, and thrown rather than
      // filtered: a condition this side does not know is a refusal this side
      // cannot judge, and dropping it would report a refused publication as a
      // missed one.
      throw new Error(
        `diagnosis_publication_refusal holds condition "${row.condition}" for ` +
          `${row.target_date} ${row.gate_profile}, which is not one of ` +
          `${DIAGNOSIS_REFUSAL_CONDITIONS.join(", ")}`,
      );
    }
    return {
      targetDate: String(row.target_date).slice(0, 10),
      gateProfile: row.gate_profile as ForecastGateProfile,
      lane: row.lane,
      condition: row.condition,
      reason: row.reason,
      observedAt: new Date(row.observed_at),
    };
  });
}

/** Every refusal in the deployment, counted — the ledger's own census. */
export async function countDiagnosisRefusals(db: Database): Promise<number> {
  const rows = await db.execute<{ refusals: number }>(sql`
    select count(*)::int as refusals from diagnosis_publication_refusal
  `);
  return [...rows][0]?.refusals ?? 0;
}
