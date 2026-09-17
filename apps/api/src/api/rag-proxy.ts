/**
 * The one door to the evidence service, and the reason it is a module rather
 * than a `fetch` in a handler.
 *
 * `ml-boundary.test.ts` rejected the first draft of `evidence.ts` within a
 * minute: a route module that dials another service around the proxy is the
 * defect that whole file exists to catch, and the fact that the service on the
 * other end is `apps/rag` rather than `apps/ml` changes nothing about it. One
 * door means one place that knows the address, one timeout, one way a refusal
 * is shaped — and one place to look when the answer is wrong.
 *
 * What crosses here is narrower than what crosses to the modelling service:
 * **reads of rows a schedule wrote**, never a build. Building evidence runs a
 * language model, and `jobs/rag-evidence.ts` is where that belongs.
 */

import { config } from "../config.js";
import { CodedError } from "../errors.js";

/**
 * How long the gateway waits.
 *
 * Four seconds against the modelling service's five, and for a weaker reason
 * than that one has: this is a single indexed row read, so a slow answer means
 * the service is unwell rather than busy. The screen that asked has a reason to
 * show either way — a citation is an annotation on a card that is already
 * drawn.
 */
const TIMEOUT_MS = 4000;

export interface RagEndpoint {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
}

function configuredEndpoint(): RagEndpoint {
  if (!config.ragUrl) {
    /*
      `DATA_UNAVAILABLE`, an existing code with copy in both locales, rather
      than a new one. The closed enum is closed on purpose and "this deployment
      does not carry that data" is what the code already means — a deployment
      without the evidence service is a deployment without citations, exactly as
      one without `mlUrl` is a deployment without a forecast.
    */
    throw new CodedError(
      "DATA_UNAVAILABLE",
      "This deployment has no evidence service configured.",
    );
  }
  return { baseUrl: config.ragUrl, token: config.ragToken, timeoutMs: TIMEOUT_MS };
}

/** A stored read on the evidence service. Never a build. */
export async function readRag(
  path: string,
  query: URLSearchParams,
  endpoint: RagEndpoint = configuredEndpoint(),
): Promise<unknown> {
  const url = new URL(path, endpoint.baseUrl);
  url.search = query.toString();
  const response = await fetch(url, {
    headers: endpoint.token === undefined ? {} : { "x-access-token": endpoint.token },
    signal: AbortSignal.timeout(endpoint.timeoutMs),
  }).catch(() => null);

  if (response === null || !response.ok) {
    throw new CodedError("UPSTREAM_UNAVAILABLE", "The evidence service did not answer.");
  }
  return await response.json();
}
