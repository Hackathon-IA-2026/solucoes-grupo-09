import { type MlEndpoint, postMl } from "../api/ml-proxy.js";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import {
  type ForecastPublication,
  PublicationPayloadError,
  type PublicationWriteResult,
  parsePublication,
  writePublication,
} from "./publication.js";

/**
 * The publication itself: ask the modelling service, write what comes back.
 *
 * **Worker → modelling service, never gateway → modelling service.** This
 * module is called from the worker ten minutes after each gate; nothing a user
 * does reaches it, and `GET /v1/forecast/day-ahead` does not import it. The
 * direction is the whole point: the modelling service is read-only against
 * Postgres, so it computes the rows and this side writes them, which keeps the
 * read-only guarantee intact and keeps every write in the service that owns the
 * schema.
 *
 * **Ten minutes after the gate, not on it.** The gate is when the *inputs*
 * become knowable, not when the job may start. The row's `published_at` is the
 * gate regardless — it comes off the feature rows, which the database stamped
 * with `gate_at(target_date, gate_profile)` — so a job that runs late writes a
 * row that is still honest about when the forecast was decided.
 *
 * **A failure leaves the previous origin serving.** Nothing here deletes, and
 * nothing writes a partial publication: the transaction is inside
 * `writePublication`, and a refusal from the modelling service — no promoted
 * artifact, no feature rows — propagates as an error that the queue's existing
 * retry policy handles. What the reader sees in the meantime is yesterday's
 * forecast with its real age on the origin, which is the degradation the
 * boundary decision promises rather than a failure mode it forgot.
 *
 * The scheduling of it — two repeatable jobs at ten past each gate — belongs to
 * `api-surface` ticket 10, on the existing worker and the existing Redis. This
 * is the unit of work those jobs run, written so it is exercisable on its own
 * against a real Postgres and a stub service.
 */

/**
 * How long a publication may take.
 *
 * Not `mlTimeoutMs`, whose five seconds are sized for a 3 ms solve behind an
 * interactive slider. A publication is a joblib load, a feature build, a
 * mixture composition and a 500-member ensemble draw for four subsystems —
 * "far outside an interactive budget", which is the argument that put it on a
 * schedule in the first place. A background job that timed out at five seconds
 * would report a working model as an outage twice a day.
 */
export const PUBLISH_TIMEOUT_MS = 120_000;

/** The modelling service's private, worker-only publication route. */
export const PUBLISH_PATH = "/internal/publish/forecast";

export interface PublishForecastRequest {
  /** The lane directory name — `dessem_free_v1__gate_late__thr5`. */
  lane: string;
  /** The civil day to publish. The service defaults it to tomorrow in Brasília. */
  targetDate?: string;
  /**
   * The instant every row of this publication must carry — the caller's own
   * `gate_at(target_date, gate_profile)`.
   *
   * Checked between the parse and the write, so a disagreement costs nothing
   * and writes nothing. Absent means "trust the payload", which is what the
   * seam test does when it is asserting the round trip rather than the
   * schedule; the scheduled job always supplies it, because the publication
   * instant being the gate is an acceptance line rather than a convention, and
   * the two spellings of `gate_at` — the SQL one the feature rows were stamped
   * with and `forecast/gate.ts` — agreeing is exactly the seam this catches.
   */
  expectPublishedAt?: Date;
  /** Overridable so a test can point at a stub without a network. */
  endpoint?: MlEndpoint;
  /** Overridable so a test can place a publication at a chosen instant. */
  ingestedAt?: Date;
}

export interface PublishForecastResult extends PublicationWriteResult {
  lane: string;
  targetDate: string;
  artifactId: string;
  /** Which correction regime produced every row this run wrote. */
  correctionRegime: string;
  publishedAt: Date;
  subsystems: number;
}

/**
 * Publish one lane's day.
 *
 * The modelling service's refusals arrive as thrown `AppError`s through
 * `ml-proxy`'s mapping, which is why this function has no error branch of its
 * own: `MODEL_UNAVAILABLE` (no promoted artifact, with the lane state in its
 * details) and `FORECAST_UNAVAILABLE` (promoted, no feature rows) are both
 * codes in the closed enum, so they survive the crossing as themselves rather
 * than as a generic outage.
 */
export async function publishForecast(
  db: Database,
  request: PublishForecastRequest,
): Promise<PublishForecastResult> {
  const endpoint = request.endpoint ?? {
    baseUrl: config.mlUrl,
    timeoutMs: PUBLISH_TIMEOUT_MS,
  };
  const response = await postMl(
    PUBLISH_PATH,
    JSON.stringify({
      lane: request.lane,
      ...(request.targetDate === undefined ? {} : { target_date: request.targetDate }),
    }),
    endpoint,
  );
  const publication: ForecastPublication = parsePublication(await response.json());
  if (
    request.expectPublishedAt !== undefined &&
    publication.publishedAt.getTime() !== request.expectPublishedAt.getTime()
  ) {
    // Before the first insert, and a refusal rather than a correction: a row
    // stamped with anything but its gate makes the origin a lie, and this side
    // does not know which of the two clocks is wrong.
    throw new PublicationPayloadError(
      `${publication.lane}: ${publication.targetDate} came back published at ` +
        `${publication.publishedAt.toISOString()}, and the ` +
        `${publication.gateProfile} gate for that date is ` +
        `${request.expectPublishedAt.toISOString()}. A published row's ` +
        "publication instant is the gate exactly.",
    );
  }
  const written = await writePublication(db, publication, {
    ...(request.ingestedAt === undefined ? {} : { ingestedAt: request.ingestedAt }),
  });
  return {
    ...written,
    lane: publication.lane,
    targetDate: publication.targetDate,
    artifactId: publication.artifactId,
    correctionRegime: publication.correctionRegime,
    publishedAt: publication.publishedAt,
    subsystems: publication.days.length,
  };
}
