import { Elysia, t } from "elysia";
import { config } from "../config.js";
import { BusyError, UpstreamError } from "../errors.js";

/**
 * The gateway's edge onto the Python service.
 *
 * The architecture decision this implements: Expo talks only to Elysia, and
 * Elysia forwards anything model-shaped. Keeping that boundary in one small
 * module means the web app never learns the ML service exists, and the ML
 * service never grows a second public surface with its own CORS, rate limits
 * and error vocabulary to keep in step.
 *
 * The reason it is a module rather than three lines inline is the failure
 * mapping. A proxy that lets upstream statuses through unexamined reports an
 * ML outage as an API bug — the caller sees a 500 from WattSteer and has no
 * way to tell whose fault it is. Every branch below is about answering that
 * question honestly.
 */

/** Upstream statuses that mean "the ML service is up but cannot serve yet". */
const UNAVAILABLE = new Set([502, 503, 504]);

async function callMl(path: string, query: URLSearchParams): Promise<Response> {
  if (!config.mlUrl) {
    // Not configured is not the same as broken. Say so rather than dialling
    // `undefined` and reporting the resulting fetch error as an upstream fault.
    throw new UpstreamError("The forecasting service is not configured");
  }

  const url = `${config.mlUrl.replace(/\/$/, "")}${path}?${query.toString()}`;
  const signal = AbortSignal.timeout(config.mlTimeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    // A timeout is not the same failure as a refused connection: one says the
    // service is overloaded, the other that it is absent. 503 tells a caller
    // to retry; 502 tells them not to bother yet.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BusyError("The forecasting service did not answer in time");
    }
    throw new UpstreamError("The forecasting service is unreachable", { cause: error });
  }

  if (UNAVAILABLE.has(response.status)) {
    throw new BusyError("The forecasting service is not ready");
  }
  if (!response.ok) {
    throw new UpstreamError(`The forecasting service failed: HTTP ${response.status}`);
  }
  return response;
}

/**
 * `GET /forecast/day-ahead`.
 *
 * Returns the ML service's response verbatim. The gateway deliberately does
 * not reshape it: the forecast contract belongs to the service that computes
 * it, and a translation layer here would be a second place for the P10/P50/P90
 * shape to drift out of step with the model that produces it.
 */
export const mlProxy = new Elysia({ name: "ml-proxy" }).get(
  "/forecast/day-ahead",
  async ({ query }) => {
    const params = new URLSearchParams({ subsystem: query.subsystem });
    if (query.target_date) {
      params.set("target_date", query.target_date);
    }
    const response = await callMl("/v1/forecast/day-ahead", params);
    return response.json();
  },
  {
    query: t.Object({
      subsystem: t.Union([
        t.Literal("N"),
        t.Literal("NE"),
        t.Literal("S"),
        t.Literal("SE"),
      ]),
      target_date: t.Optional(t.String({ format: "date" })),
    }),
    detail: {
      summary: "Day-ahead curtailment forecast",
      description:
        "Proxied to the modelling service. Returns P10/P50/P90 per hour once the " +
        "forecaster is built; until then it returns the contract's shape with an " +
        "empty profile and a status saying so, never invented numbers.",
    },
  },
);
