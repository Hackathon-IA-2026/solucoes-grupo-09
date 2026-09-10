import { civilDay } from "@wattsteer/core/scenario-validation";
import { GATES } from "@wattsteer/core/schedule";
import { sql } from "drizzle-orm";
import { readOnly } from "../contract/read-only.js";
import { applyAxes } from "../contract/scope.js";
import { canonicalForecastDay } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
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
