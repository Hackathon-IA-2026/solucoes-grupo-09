import { type MlEndpoint, postMl } from "../api/ml-proxy.js";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import type { ForecastGateProfile } from "../forecast/publication.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import {
  AttributionPayloadError,
  type AttributionPublication,
  type AttributionWriteResult,
  parseAttributionPublication,
  writeAttributionPublication,
} from "./publication.js";
import { type ReasonMix, reasonMixPayload } from "./reason-mix.js";

/**
 * The diagnosis publication: ask the modelling service, write what comes back.
 *
 * The exact shape of `forecast/publish.ts`, one grain over, and the same three
 * sentences hold for the same reasons:
 *
 * **Worker → modelling service, never gateway → modelling service.** This
 * module is called from the worker on the completion of a forecast publication;
 * nothing a user does reaches it and `GET /v1/diagnosis/day-ahead` does not
 * import it. The modelling service is read-only against Postgres, so it
 * computes the rows and this side writes them.
 *
 * **The publication instant is the gate**, and it is the *same* gate the
 * forecast rows carry — an attribution is published with the forecast it
 * explains. The caller supplies it and `writeAttributionPublication` refuses a
 * payload stamped with anything else before its first insert, exactly as the
 * forecast publisher does. Since `0042` the table refuses it too.
 *
 * **A failure leaves the forecast serving.** Nothing here deletes and nothing
 * writes a partial publication: the transaction is inside
 * `writeAttributionPublication`, and a refusal from the modelling service
 * propagates as an error the queue's existing retry policy handles. What the
 * reader sees in the meantime is a forecast with no explanation — which
 * `/v1/diagnosis/day-ahead` answers as its own absence — rather than an
 * explanation of nothing.
 *
 * ## What this module adds that the forecast publisher does not: `recent_reasons`
 *
 * `unmodelled_outage_regime` — the sharpest of the four shipping rules, and the
 * only one whose input is not on the attribution or the artifact — needs the
 * most recent settled day's reported reason mix for the subsystem. `diagnosis`
 * ticket 07 built the rule and left the read unbuilt, so it could not fire.
 * `reason-mix.ts` is the read, and this is where it is performed: the worker
 * holds the Postgres handle that owns the schema, the read is cut at
 * `actuals_cutoff` from the same target date and gate profile the publication
 * is for, and the shares travel to the modelling service on the request.
 *
 * They are read here rather than inside `apps/ml` deliberately. The rule's
 * input is then a value the *writer* stands behind and the same transaction's
 * vintage axis produced, rather than a second read of the same series at a
 * second instant — which is the "two producers of one quantity" this project
 * has ruled out at five layers.
 *
 * A subsystem with no qualifying settled day is **absent** from the map rather
 * than present with zeros. `RuleContext.recent_reasons` is `None` in that case
 * and the rule does not fire, which is the honest outcome: "nothing was
 * restricted" and "we cannot see yet" must not be the same input.
 */

/**
 * How long a diagnosis publication may take.
 *
 * The same budget as the forecast publication's, and for a strictly larger
 * reason: a grouped Shapley decomposition over eight players at 2⁸ coalitions,
 * for twenty-four hours and four subsystems, on top of the artifact load and
 * the matched background draw. Not `mlTimeoutMs`, whose five seconds are sized
 * for an interactive solve.
 */
export const PUBLISH_DIAGNOSIS_TIMEOUT_MS = 120_000;

/** The modelling service's private, worker-only attribution route. */
export const PUBLISH_DIAGNOSIS_PATH = "/internal/publish/diagnosis";

export interface PublishDiagnosisRequest {
  /** The lane directory name — `dessem_free_v1__gate_late__thr5`. */
  lane: string;
  /** The civil day to explain. Always supplied: see `jobs/diagnosis-publication.ts`. */
  targetDate: string;
  /**
   * The instant every row of this publication must carry — the caller's own
   * `gate_at(target_date, gate_profile)`, which is the instant the forecast
   * rows this explains already carry.
   */
  expectPublishedAt: Date;
  /**
   * The reason mix per subsystem, for `unmodelled_outage_regime`. A subsystem
   * with no qualifying settled day is absent from the map, never zeroed.
   */
  recentReasons?: Partial<Record<SubsystemCode, ReasonMix>>;
  /** Overridable so a test can point at a stub without a network. */
  endpoint?: MlEndpoint;
  /** Overridable so a test can place a publication at a chosen instant. */
  ingestedAt?: Date;
}

export interface PublishDiagnosisResult extends AttributionWriteResult {
  lane: string;
  targetDate: string;
  gateProfile: ForecastGateProfile;
  artifactId: string;
  publishedAt: Date;
  /** How many subsystems the publication explained. */
  subsystems: number;
  /** Which subsystems a reason mix was supplied for. */
  reasonsSuppliedFor: SubsystemCode[];
}

/**
 * Publish one lane's day of attributions.
 *
 * The modelling service's refusals arrive as thrown `AppError`s through
 * `ml-proxy`'s mapping, which is why this function has no error branch of its
 * own — the codes survive the crossing as themselves, and the job above is what
 * names them in an operator's vocabulary.
 */
export async function publishDiagnosis(
  db: Database,
  request: PublishDiagnosisRequest,
): Promise<PublishDiagnosisResult> {
  const endpoint = request.endpoint ?? {
    baseUrl: config.mlUrl,
    timeoutMs: PUBLISH_DIAGNOSIS_TIMEOUT_MS,
  };
  const supplied = Object.entries(request.recentReasons ?? {}).filter(
    ([, mix]) => mix !== undefined,
  ) as [SubsystemCode, ReasonMix][];
  const response = await postMl(
    PUBLISH_DIAGNOSIS_PATH,
    JSON.stringify({
      lane: request.lane,
      target_date: request.targetDate,
      // Absent subsystems are absent, not zeroed. `{}` when nothing was
      // readable, which the rule reads as "not available" for every subsystem.
      recent_reasons: Object.fromEntries(
        supplied.map(([subsystem, mix]) => [subsystem, reasonMixPayload(mix)]),
      ),
    }),
    endpoint,
  );
  const publication: AttributionPublication = parseAttributionPublication(
    await response.json(),
  );
  if (publication.publishedAt.getTime() !== request.expectPublishedAt.getTime()) {
    // Before the first insert, and a refusal rather than a correction — the
    // forecast publisher's argument, verbatim: a row stamped with anything but
    // its gate makes the origin a lie, and this side does not know which of the
    // two clocks is wrong. Unlike the forecast publisher's, this check is not
    // optional: there is no seam test that wants to trust the payload, because
    // an attribution is published with the forecast it explains and that
    // forecast's instant is already known here.
    throw new AttributionPayloadError(
      `${publication.lane}: ${publication.targetDate} came back published at ` +
        `${publication.publishedAt.toISOString()}, and the ` +
        `${publication.gateProfile} gate for that date is ` +
        `${request.expectPublishedAt.toISOString()}. An attribution is ` +
        "published with the forecast it explains, at its gate exactly.",
    );
  }
  if (publication.targetDate !== request.targetDate) {
    throw new AttributionPayloadError(
      `${publication.lane}: asked for ${request.targetDate} and got ` +
        `${publication.targetDate}. The day is pinned by the forecast ` +
        "publication that triggered this one and is never re-resolved here.",
    );
  }
  const written = await writeAttributionPublication(db, publication, {
    ...(request.ingestedAt === undefined ? {} : { ingestedAt: request.ingestedAt }),
  });
  return {
    ...written,
    lane: publication.lane,
    targetDate: publication.targetDate,
    gateProfile: publication.gateProfile,
    artifactId: publication.artifactId,
    publishedAt: publication.publishedAt,
    subsystems: publication.attributions.length,
    reasonsSuppliedFor: supplied.map(([subsystem]) => subsystem),
  };
}
