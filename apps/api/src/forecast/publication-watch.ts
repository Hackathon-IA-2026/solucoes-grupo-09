import { civilDay } from "@wattsteer/core/scenario-validation";
import { GATES } from "@wattsteer/core/schedule";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { readOnly } from "../contract/read-only.js";
import { applyAxes } from "../contract/scope.js";
import {
  canonicalDiagnosisAttribution,
  canonicalForecastDay,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import { PUBLISH_DIAGNOSIS_TIMEOUT_MS } from "../diagnosis/publish.js";
import {
  type DiagnosisRefusalRecord,
  readDiagnosisRefusals,
} from "../diagnosis/refusal.js";
import { gateAt } from "./gate.js";
import type { ForecastGateProfile } from "./publication.js";
import { type PublishedOrigin, readLatestPublished } from "./reads.js";

/**
 * The publication that did not happen — the one failure `/v1/meta` shows and
 * nobody sees.
 *
 * `drizzle/0041` made a *mis-stamped* publication unrepresentable. This module
 * is about the other half: the publication that never ran at all. The spec
 * carries it as a named weakness — "a publication failure is product-visible
 * with no automatic recovery beyond the retry, and the only monitoring is the
 * meta endpoint and the response's age" — and `forecast_origin.age_hours`
 * makes it *visible* without making it *noticed*.
 *
 * Nothing here is a new alerting product. It is the same shape as the three
 * scheduled suites this repo already runs: a question about the **world**
 * rather than about a commit, asked on a schedule, whose failing run is the
 * alarm. `test/publication-watch.test.ts` is the suite and
 * `.github/workflows/publication-watch.yml` is when it asks.
 *
 * ### Three verdicts, not two
 *
 * A two-state alarm — "there is a publication for the last gate, or there is
 * not" — is an alarm that screams from the day the database is created until
 * the day the first artifact is promoted, and an alarm that screams is an
 * alarm that gets switched off. So the census is read alongside the origins:
 *
 * - **`never_published`** — no `served` day row exists anywhere. This
 *   deployment has not published once, so no publication is *late*; there is
 *   nothing that stopped. Reported loudly and passed, because "we have never
 *   had data" is a true and different sentence from "we stopped having data".
 * - **`late`** — the deployment *has* published before, and the most recent
 *   gate whose margin has elapsed has no origin behind it. This is the alarm.
 * - **`published`** — that gate has an origin, stamped at the gate instant.
 *
 * The discriminator is deliberately the table's own census rather than a
 * configured "go-live" date: a date would have to be maintained by hand, and
 * the day it is wrong is the day the alarm is either silent or screaming.
 *
 * ### Two halves of one chain
 *
 * The first version of this module watched the forecast publication only, and
 * said so in its ticket: "the chained `publish_diagnosis` has its own way of
 * having failed". It does, and it is the same product-visible silence — a
 * forecast publishes perfectly, the chained diagnosis dies, and a watch over
 * the forecast half reports a healthy system. The second half of this file
 * closes that, in the same idiom and behind the same two crons; its own header,
 * below, is where the chained due time and the two extra verdicts are argued.
 */

/**
 * The margin. Stated once, here, and defended by two derived bounds rather
 * than by assertion — `test/publication-watch.test.ts` § "the margin" computes
 * both and fails if either stops holding.
 *
 * **Above the automatic-recovery window.** Nothing recovers a publication
 * after the queue gives up, and the whole of that window is computable: the
 * job is submitted at the gate plus its cron's offset (`FORECAST_PUBLICATIONS`
 * against `GATES`), each attempt is bounded by `PUBLISH_TIMEOUT_MS`, there are
 * `config.jobAttempts` of them, and `config.jobBackoffMs` spaces them
 * exponentially. Below that window an alarm reports a job that is still trying.
 *
 * **Below the shortest interval between consecutive gates.** The gates are ten
 * and fourteen hours apart; a margin at or above ten hours would let a missed
 * early publication be masked by the late one that supersedes it, which is the
 * exact failure this exists to catch — the day was served by yesterday's
 * origin and nobody noticed.
 *
 * Two hours sits an order of magnitude above the first bound and a fifth of
 * the way to the second. It is not derived from anything, because there is
 * nothing to derive it from: it is the answer to "how long would you let a
 * publication be missing before you want to be told", and the bounds are what
 * keep it honest when a gate hour or a retry policy moves.
 */
export const PUBLICATION_GRACE_MS = 2 * 3_600_000;

/** A gate whose margin has elapsed, so its publication is answerable for. */
export interface DuePublication {
  /** The civil day the publication is *for*. */
  targetDate: string;
  gateProfile: ForecastGateProfile;
  /** `gate_at(target_date, gate_profile)` — never restated, always called. */
  gateAt: Date;
  /** `gateAt` plus the margin: the instant this became answerable for. */
  dueAt: Date;
}

/** The next civil date after `date`. ISO dates compare lexicographically. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The most recent gate whose margin has already elapsed at `now`.
 *
 * Today and yesterday are both considered, for `nextPublication`'s reason in
 * reverse: after midnight the last elapsed gate belongs to the previous civil
 * date, which in a zone with a transition is not simply "minus five hours".
 *
 * The gate instant comes back from `gateAt`, so this function knows a profile
 * and a date and never an hour. That is the point — `forecast/gate.ts` already
 * says a fourth spelling of the two gate hours is worth avoiding, and an alarm
 * that restated them could fire two hours early against a schedule that moved.
 */
export function mostRecentDuePublication(
  now: Date,
  graceMs: number = PUBLICATION_GRACE_MS,
): DuePublication {
  const today = civilDay(now);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const elapsed = [yesterday, today]
    .flatMap((date) =>
      GATES.map((gate) => {
        const targetDate = nextDay(date);
        const at = gateAt(targetDate, gate.profile as ForecastGateProfile);
        return {
          targetDate,
          gateProfile: gate.profile as ForecastGateProfile,
          gateAt: at,
          dueAt: new Date(at.getTime() + graceMs),
        };
      }),
    )
    .filter((candidate) => candidate.dueAt.getTime() <= now.getTime())
    .sort((a, b) => b.gateAt.getTime() - a.gateAt.getTime());
  const due = elapsed[0];
  if (due === undefined) {
    // Unreachable while `GATES` is non-empty and `graceMs` is under a day:
    // yesterday's gates are always more than a margin behind. Thrown rather
    // than defaulted, because a watch that invented a gate would report a
    // publication missing that was never owed.
    throw new RangeError(
      `No gate is more than ${graceMs} ms behind ${now.toISOString()}`,
    );
  }
  return due;
}

/** What the watch read out of the database, before any verdict is drawn. */
export interface PublicationWatchInputs {
  /**
   * Every `served` day-grain row in the deployment, counted.
   *
   * The reason an empty answer cannot read as a healthy one: zero here is
   * `never_published`, and any query that returns nothing at all is
   * distinguishable from one that returned rows and matched none of them.
   */
  servedDayRows: number;
  /** The most recent origins, newest first — `/v1/meta`'s own read. */
  origins: readonly PublishedOrigin[];
}

export type PublicationWatchVerdict = "published" | "late" | "never_published";

export interface PublicationWatchReport {
  verdict: PublicationWatchVerdict;
  due: DuePublication;
  /** The origin that satisfied the gate, when one did. */
  matched: PublishedOrigin | null;
  /** How long past the margin, in hours, when `late`. */
  hoursPastDue: number | null;
  /** The census, carried onto the report so a passing run prints it too. */
  servedDayRows: number;
  /** What actually happened, in prose an operator can act on. */
  observed: string;
}

const hours = (ms: number): number => Math.round((ms / 3_600_000) * 10) / 10;

/**
 * Draw the verdict. Pure, so the alarm can be shown firing and staying quiet
 * without a database and without waiting for a gate to pass.
 */
export function classifyPublicationWatch(
  due: DuePublication,
  inputs: PublicationWatchInputs,
  now: Date,
): PublicationWatchReport {
  if (inputs.servedDayRows < 0) {
    throw new RangeError(`A census of ${inputs.servedDayRows} served rows is not one`);
  }
  if (inputs.servedDayRows === 0 && inputs.origins.length > 0) {
    // The two halves come off the same table through the same axes. If they
    // disagree the read is broken, and a broken read must not be allowed to
    // resolve to any of the three verdicts — "no rows" would report a live
    // deployment as never live, which is the alarm's own off switch.
    throw new Error(
      `The census says no served day rows exist and ${inputs.origins.length} origins ` +
        "came back from the same view. The watch read is incoherent; no verdict " +
        "is drawn from it.",
    );
  }
  if (inputs.servedDayRows === 0) {
    return {
      verdict: "never_published",
      due,
      matched: null,
      hoursPastDue: null,
      servedDayRows: 0,
      observed:
        "no served forecast day row exists in this deployment, at any gate for " +
        "any date, so no publication is late — this system has never published. " +
        `The first one owed is ${due.gateProfile} for ${due.targetDate}, whose ` +
        `gate passed at ${due.gateAt.toISOString()}.`,
    };
  }
  const matched =
    inputs.origins.find(
      (origin) =>
        origin.targetDate === due.targetDate &&
        origin.gateProfile === due.gateProfile &&
        origin.publishedAt.getTime() === due.gateAt.getTime(),
    ) ?? null;
  if (matched !== null) {
    return {
      verdict: "published",
      due,
      matched,
      hoursPastDue: null,
      servedDayRows: inputs.servedDayRows,
      observed:
        `${due.gateProfile} for ${due.targetDate} was published at ` +
        `${matched.publishedAt.toISOString()}, covering ` +
        `${matched.subsystems.join(", ")}. The census holds ` +
        `${inputs.servedDayRows} served day rows.`,
    };
  }
  const newest = inputs.origins[0];
  return {
    verdict: "late",
    due,
    matched: null,
    hoursPastDue: hours(now.getTime() - due.dueAt.getTime()),
    servedDayRows: inputs.servedDayRows,
    observed:
      `${due.gateProfile} for ${due.targetDate} has no served origin ` +
      `${hours(now.getTime() - due.gateAt.getTime())} h after its gate at ` +
      `${due.gateAt.toISOString()}, which is ` +
      `${hours(now.getTime() - due.dueAt.getTime())} h past the margin. ` +
      (newest === undefined
        ? "No origin came back at all."
        : `The newest origin this deployment holds is ${newest.gateProfile} for ` +
          `${newest.targetDate}, published ${newest.publishedAt.toISOString()} ` +
          `(${hours(now.getTime() - newest.publishedAt.getTime())} h ago), so the ` +
          "day is being served by an older vintage. ") +
      `The census holds ${inputs.servedDayRows} served day rows, so this ` +
      "deployment has published before and stopped.",
  };
}

/**
 * Read both halves the verdict needs, in one read-only transaction at one
 * `as_of`, so the census and the origins cannot describe two different
 * instants of the table.
 */
export async function readPublicationWatch(
  db: Database,
  options: { asOf: Date; limit?: number },
): Promise<PublicationWatchInputs> {
  const origins = await readLatestPublished(db, {
    asOf: options.asOf,
    limit: options.limit ?? 8,
  });
  const servedDayRows = await readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: options.asOf });
    const rows = await tx.execute<{ served: number }>(sql`
      select count(*)::int as served
      from ${canonicalForecastDay}
      where origin_kind = 'served'::forecast_origin_kind
    `);
    return [...rows][0]?.served ?? 0;
  });
  return { servedDayRows, origins };
}

/** The whole question, from a handle to a verdict. */
export async function watchPublications(
  db: Database,
  options: { now: Date; graceMs?: number },
): Promise<PublicationWatchReport> {
  const graceMs = options.graceMs ?? PUBLICATION_GRACE_MS;
  const due = mostRecentDuePublication(options.now, graceMs);
  const inputs = await readPublicationWatch(db, { asOf: options.now });
  return classifyPublicationWatch(due, inputs, options.now);
}

// ---------------------------------------------------------------------------
// The other half of the chain — the diagnosis publication that did not happen.
//
// The forecast watch above named this as what it does not do: "it watches the
// **forecast** publication only: the chained `publish_diagnosis` has its own way
// of having failed". The two are chained — a finished `publish_forecast`
// submits a `publish_diagnosis` carrying the day it wrote — so a forecast can
// publish perfectly, the chained half can die, and everything above says the
// system is healthy. It is: one grain of it.
//
// Three things make this not a copy of the section above.
//
// ## 1. The due time is not a gate plus a margin
//
// `publish_diagnosis` has no cron. `docs/specs/api-surface.md`'s job table gives
// it the trigger "on completion of each above", which is the one row in the
// table that is not a pattern. So the instant it becomes answerable for is
// measured from the forecast publication it chains off, and the forecast rows
// record that instant: `ingested_at` is the `AsOf` axis — the wall clock at the
// write — while `published_at` is the gate. The chain starts when the forecast
// publication committed, which is `ingested_at`, and from there the diagnosis
// task has its own retry budget: `config.jobAttempts` attempts at
// `PUBLISH_DIAGNOSIS_TIMEOUT_MS`, spaced by `config.jobBackoffMs`
// exponentially. Below that, an alarm reports a job still trying.
//
//     dueAt = max(gateAt + PUBLICATION_GRACE_MS,
//                 forecast.ingestedAt + diagnosisRecoveryWindowMs())
//
// The first term is why this needs no second cron and no second margin: in the
// ordinary case the forecast publishes minutes after its gate and the chained
// half finishes minutes after that, so the shared margin has already covered
// the whole chain by the time the workflow asks — a bound
// `test/publication-watch.test.ts` § "the chain" computes rather than assumes.
// The second term is what keeps the watch honest when the ordinary case does
// not hold: a forecast published by hand three hours late starts its chain
// three hours late, and a diagnosis is not owed before the forecast it explains.
//
// No hour appears in any of it. `gateAt` is called, exactly as above.
//
// ## 2. There is a fourth honest verdict: the refusal
//
// `apps/ml` can *correctly* decline a diagnosis publication, with a typed
// condition out of its own closed tuple — `no_matched_background`,
// `no_base_fit_window`, `contract_and_groups_disagree`, `incomplete_day`. (Not
// `null_headline_feature`: that was a refusal until this wave and is now a
// stated absence on the driver row, so the ranking publishes.) A declared
// refusal is not a missed publication. It is a retrain- or a YAML-shaped
// problem, the forecast is unaffected, and an alarm that fired on it would fire
// on correct behaviour — which is the alarm's own off switch.
//
// A refusal used to be a `console.warn` in a worker log, so this could not be
// asked. `drizzle/0044` is the ledger and `diagnosis/refusal.ts` writes it, and
// the freshness test is `observed_at >= forecast.ingested_at`: a refusal older
// than the forecast publication now serving is a statement about a previous
// vintage of that day and does not silence anything.
//
// ## 3. "Never" has two meanings here, and one of them belongs to the other half
//
// A gate whose *forecast* never published owes no diagnosis at all — the
// section above is the alarm for that, and this one must not double-report it.
// And a deployment that has never written an attribution row is the state this
// repository is in today (`apps/ml`'s half of the chain landed this wave, and
// the database holds zero ingested rows), so it is reported loudly and passed,
// for the same reason `never_published` is.
// ---------------------------------------------------------------------------

/**
 * The chained task's own automatic-recovery window: every attempt at its
 * timeout, plus the exponential waits between them.
 *
 * No cron offset term, unlike the forecast publication's: this task is
 * submitted on a completion rather than at a pattern, so the window starts when
 * the forecast publication committed and the offset is already in that instant.
 *
 * Derived from `config` and from `PUBLISH_DIAGNOSIS_TIMEOUT_MS` rather than
 * stated, so raising the attempts or the timeout moves the due time with them —
 * and `test/publication-watch.test.ts` § "the chain" fails if they are ever
 * raised far enough that the whole chain no longer fits inside the margin the
 * workflow asks at.
 */
export function diagnosisRecoveryWindowMs(
  attempts: number = config.jobAttempts,
  backoffMs: number = config.jobBackoffMs,
): number {
  const waits = Array.from(
    { length: Math.max(0, attempts - 1) },
    (_value, index) => backoffMs * 2 ** index,
  ).reduce((total, wait) => total + wait, 0);
  return attempts * PUBLISH_DIAGNOSIS_TIMEOUT_MS + waits;
}

/** What the watch read about the chained half, before any verdict is drawn. */
export interface DiagnosisWatchInputs {
  /**
   * Every served attribution row in the deployment, counted.
   *
   * The `never_diagnosed` discriminator, and the reason an empty answer cannot
   * read as a healthy one: zero here is "this deployment has never explained a
   * day", which is a different sentence from "it stopped explaining them".
   */
  attributionRows: number;
  /**
   * When the forecast publication behind the due gate committed — its
   * `ingested_at`, the instant the chain was submitted at. `null` when that
   * gate has no served forecast publication at all, in which case no diagnosis
   * was owed and the forecast half of this watch is the one that speaks.
   */
  forecastIngestedAt: Date | null;
  /** The subsystems that have an attribution stamped at the due gate's instant. */
  attributedSubsystems: readonly string[];
  /** Refusals recorded for that lane-day, newest first. */
  refusals: readonly DiagnosisRefusalRecord[];
}

export type DiagnosisWatchVerdict =
  /** An attribution is stamped at the due gate. */
  | "published"
  /** `apps/ml` declared a typed refusal for this publication. Not a miss. */
  | "refused"
  /** The chain is still inside its own retry budget. Not yet answerable. */
  | "not_yet_due"
  /** No forecast published at this gate, so no diagnosis was owed. */
  | "forecast_absent"
  /** This deployment has never written an attribution row. */
  | "never_diagnosed"
  /** The forecast published, the chain had its budget, and nothing arrived. */
  | "late";

export interface DiagnosisWatchReport {
  verdict: DiagnosisWatchVerdict;
  /** The gate whose forecast publication this diagnosis chains off. */
  due: DuePublication;
  /** `forecast.ingestedAt` — when the chain was submitted. */
  chainStartedAt: Date | null;
  /** The derived instant the diagnosis became answerable for. Never a gate hour. */
  answerableAt: Date | null;
  /** How long past that instant, in hours, when `late`. */
  hoursPastDue: number | null;
  /** The refusal that explains the absence, when one does. */
  refusal: DiagnosisRefusalRecord | null;
  /** The census, carried on so a passing run prints it too. */
  attributionRows: number;
  attributedSubsystems: readonly string[];
  observed: string;
}

/**
 * The instant the chained publication becomes answerable for.
 *
 * `max` of the shared margin past the gate and the chain's own recovery window
 * past the forecast publication that started it. Both terms are derived; the
 * second is what makes this a chained question rather than a scheduled one.
 */
export function diagnosisAnswerableAt(
  due: DuePublication,
  forecastIngestedAt: Date,
  recoveryMs: number = diagnosisRecoveryWindowMs(),
): Date {
  return new Date(
    Math.max(due.dueAt.getTime(), forecastIngestedAt.getTime() + recoveryMs),
  );
}

/**
 * Draw the chained verdict. Pure, so every one of the six states can be shown
 * without a database and without waiting for a gate to pass.
 */
export function classifyDiagnosisWatch(
  due: DuePublication,
  inputs: DiagnosisWatchInputs,
  now: Date,
  recoveryMs: number = diagnosisRecoveryWindowMs(),
): DiagnosisWatchReport {
  if (inputs.attributionRows < 0) {
    throw new RangeError(
      `A census of ${inputs.attributionRows} attribution rows is not one`,
    );
  }
  if (inputs.attributionRows === 0 && inputs.attributedSubsystems.length > 0) {
    // The one way an empty answer could pass as a healthy one, in the shape the
    // forecast half already refuses: the census and the gate's own rows come
    // off the same view through the same axes, so if they disagree the read is
    // broken and no verdict may be drawn from it.
    throw new Error(
      "The census says no served attribution rows exist and " +
        `${inputs.attributedSubsystems.length} came back for ${due.gateProfile} ` +
        `${due.targetDate} from the same view. The watch read is incoherent; no ` +
        "verdict is drawn from it.",
    );
  }
  if (inputs.attributedSubsystems.length > 0 && inputs.forecastIngestedAt === null) {
    // An attribution stamped at a gate whose forecast publication is not there.
    // `0041` makes the instant right and nothing makes the *pair* right, so it
    // is checked here rather than assumed: reporting this as `published` would
    // report an explanation of a forecast this deployment does not hold.
    throw new Error(
      `${due.gateProfile} for ${due.targetDate} has ` +
        `${inputs.attributedSubsystems.length} attribution rows and no served ` +
        "forecast publication behind them. The watch read is incoherent; no " +
        "verdict is drawn from it.",
    );
  }
  const base = {
    due,
    chainStartedAt: inputs.forecastIngestedAt,
    attributionRows: inputs.attributionRows,
    attributedSubsystems: inputs.attributedSubsystems,
  };
  if (inputs.forecastIngestedAt === null) {
    return {
      ...base,
      verdict: "forecast_absent",
      answerableAt: null,
      hoursPastDue: null,
      refusal: null,
      observed:
        `${due.gateProfile} for ${due.targetDate} has no served forecast ` +
        "publication, so no diagnosis publication was owed for it — the chain " +
        "is triggered by a forecast publication's completion and there was " +
        "none to complete. Whether *that* is a missed publication or a " +
        "deployment that has never published is the forecast half of this " +
        `watch, not this one. The census holds ${inputs.attributionRows} ` +
        "served attribution rows.",
    };
  }
  const answerableAt = diagnosisAnswerableAt(due, inputs.forecastIngestedAt, recoveryMs);
  if (inputs.attributedSubsystems.length > 0) {
    return {
      ...base,
      verdict: "published",
      answerableAt,
      hoursPastDue: null,
      refusal: null,
      observed:
        `${due.gateProfile} for ${due.targetDate} was explained at ` +
        `${due.gateAt.toISOString()}, covering ` +
        `${[...inputs.attributedSubsystems].join(", ")}. The forecast it ` +
        `explains committed at ${inputs.forecastIngestedAt.toISOString()}. The ` +
        `census holds ${inputs.attributionRows} served attribution rows.`,
    };
  }
  if (now.getTime() < answerableAt.getTime()) {
    return {
      ...base,
      verdict: "not_yet_due",
      answerableAt,
      hoursPastDue: null,
      refusal: null,
      observed:
        `${due.gateProfile} for ${due.targetDate} has no attribution yet, and ` +
        "none is owed: the forecast publication committed at " +
        `${inputs.forecastIngestedAt.toISOString()} and the chained task's own ` +
        `retry budget runs to ${answerableAt.toISOString()}. Alarming here ` +
        "would alarm on a job that is still allowed to be running.",
    };
  }
  const refusal =
    inputs.refusals.find(
      (candidate) =>
        inputs.forecastIngestedAt !== null &&
        candidate.observedAt.getTime() >= inputs.forecastIngestedAt.getTime(),
    ) ?? null;
  if (refusal !== null) {
    return {
      ...base,
      verdict: "refused",
      answerableAt,
      hoursPastDue: null,
      refusal,
      observed:
        `${due.gateProfile} for ${due.targetDate} has no attribution because ` +
        `the modelling service refused one: ${refusal.condition}, observed at ` +
        `${refusal.observedAt.toISOString()} on lane ${refusal.lane} — ` +
        `"${refusal.reason}". That is a declared refusal rather than a missed ` +
        "publication: the forecast is serving and unaffected, and the repair " +
        "is a retrain or a driver-group change rather than a retry. The census " +
        `holds ${inputs.attributionRows} served attribution rows.`,
    };
  }
  const stale = inputs.refusals[0];
  if (inputs.attributionRows === 0) {
    return {
      ...base,
      verdict: "never_diagnosed",
      answerableAt,
      hoursPastDue: null,
      refusal: null,
      observed:
        "no served attribution row exists in this deployment, at any gate for " +
        "any date, and no refusal was recorded for this one either — so no " +
        "diagnosis publication is late; this system has never explained a day. " +
        `The first one owed is ${due.gateProfile} for ${due.targetDate}, whose ` +
        `forecast committed at ${inputs.forecastIngestedAt.toISOString()} and ` +
        `whose explanation became answerable at ${answerableAt.toISOString()}.`,
    };
  }
  return {
    ...base,
    verdict: "late",
    answerableAt,
    hoursPastDue: hours(now.getTime() - answerableAt.getTime()),
    refusal: null,
    observed:
      `${due.gateProfile} for ${due.targetDate} published a forecast at ` +
      `${inputs.forecastIngestedAt.toISOString()} and has no attribution ` +
      `stamped at its gate ${due.gateAt.toISOString()}. That is ` +
      `${hours(now.getTime() - answerableAt.getTime())} h past the instant the ` +
      "chained publication became answerable for " +
      `(${answerableAt.toISOString()}), and no refusal was declared for it. ` +
      (stale === undefined
        ? "The ledger holds no refusal for this lane-day at all, so the chain " +
          "was not asked and answered — it did not run, or it died in its " +
          "retries, or it was never queued."
        : "The newest refusal for this lane-day was observed at " +
          `${stale.observedAt.toISOString()} (${stale.condition}), which is ` +
          "older than the forecast publication now serving, so it is a " +
          "statement about a previous vintage rather than about this one. ") +
      ` The census holds ${inputs.attributionRows} served attribution rows, so ` +
      "this deployment has explained days before and stopped: the forecast is " +
      "serving with no explanation beside it and /v1/diagnosis/day-ahead is " +
      "answering its own absence.",
  };
}

/**
 * Read what the chained verdict needs, in one read-only transaction at one
 * `as_of` — the census, the gate's own rows, the forecast publication behind
 * them and the refusal ledger cannot describe four different instants.
 */
export async function readDiagnosisWatch(
  db: Database,
  options: { due: DuePublication; asOf: Date },
): Promise<DiagnosisWatchInputs> {
  const { due } = options;
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: options.asOf });
    const forecast = await tx.execute<{ ingested_at: string | null }>(sql`
      select max(ingested_at) as ingested_at
      from ${canonicalForecastDay}
      where origin_kind = 'served'::forecast_origin_kind
        and target_date = ${due.targetDate}::date
        and gate_profile = ${due.gateProfile}::forecast_gate_profile
    `);
    const ingestedAt = [...forecast][0]?.ingested_at ?? null;
    const attributed = await tx.execute<{ subsystem: string }>(sql`
      select distinct subsystem::text as subsystem
      from ${canonicalDiagnosisAttribution}
      where origin_kind = 'served'::forecast_origin_kind
        and target_date = ${due.targetDate}::date
        and gate_profile = ${due.gateProfile}::forecast_gate_profile
        and published_at = ${due.gateAt.toISOString()}::timestamptz
      order by subsystem::text
    `);
    const census = await tx.execute<{ attributions: number }>(sql`
      select count(*)::int as attributions
      from ${canonicalDiagnosisAttribution}
      where origin_kind = 'served'::forecast_origin_kind
    `);
    const refusals = await readDiagnosisRefusals(tx, {
      targetDate: due.targetDate,
      gateProfile: due.gateProfile,
    });
    return {
      attributionRows: [...census][0]?.attributions ?? 0,
      forecastIngestedAt: ingestedAt === null ? null : new Date(ingestedAt),
      attributedSubsystems: [...attributed].map((row) => row.subsystem),
      refusals,
    };
  });
}

/** The chained question, from a handle to a verdict. */
export async function watchDiagnosisPublications(
  db: Database,
  options: { now: Date; graceMs?: number },
): Promise<DiagnosisWatchReport> {
  const graceMs = options.graceMs ?? PUBLICATION_GRACE_MS;
  const due = mostRecentDuePublication(options.now, graceMs);
  const inputs = await readDiagnosisWatch(db, { due, asOf: options.now });
  return classifyDiagnosisWatch(due, inputs, options.now);
}
