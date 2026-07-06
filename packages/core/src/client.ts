import type { AppInfoResult, JobRecord, ScrapeRequest } from "./types";

/** Error carrying the API's HTTP status and safe message. */
export class ApiError extends Error {
  readonly status: number;
  /** Transient statuses (429/5xx/network) are worth retrying. */
  readonly retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // non-JSON error body — keep the status-based message
  }
  return new ApiError(res.status, message);
}

/**
 * Minimal typed client for the noviq API. Deliberately fetch-based (no SDK
 * dependency) so it runs identically on web, iOS, and Android.
 */
export class NoviqClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(0, "Could not reach the server. Check your connection.");
    }
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  /** Fetch app metadata only (fast preview — no review pagination). */
  appInfo(
    params: Pick<ScrapeRequest, "appId" | "store" | "country">,
    signal?: AbortSignal,
  ): Promise<AppInfoResult> {
    const query = new URLSearchParams({ appId: params.appId });
    if (params.store) query.set("store", params.store);
    if (params.country) query.set("country", params.country);
    return this.get<AppInfoResult>(`/app?${query}`, signal);
  }

  /** Submit an async scrape job; resolves to the job id. */
  async submitJob(request: ScrapeRequest, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/reviews/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(0, "Could not reach the server. Check your connection.");
    }
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  /** Fetch a job's current status/result. */
  jobStatus(id: string, signal?: AbortSignal): Promise<JobRecord> {
    return this.get<JobRecord>(`/reviews/jobs/${encodeURIComponent(id)}`, signal);
  }
}

/**
 * Polling cadence: fast at first (a small scrape can finish in seconds —
 * Doherty: show the result the moment it exists), backing off to spare the
 * server on long jobs. Pure function of the attempt number for testability.
 */
export function pollDelayMs(attempt: number): number {
  if (attempt < 5) return 1_000;
  if (attempt < 15) return 2_000;
  return 5_000;
}
