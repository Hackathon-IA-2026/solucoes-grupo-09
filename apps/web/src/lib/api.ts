/**
 * The one client the app talks to the gateway through.
 *
 * `@wattsteer/core`'s `ApiClient` is the only translator between the wire's
 * `snake_case` and this app's `camelCase`, and the only place an error envelope
 * becomes an `ApiError` carrying a code from the closed enum. A second `fetch`
 * anywhere in this app would be a second casing boundary and a second opinion
 * about what a failure is.
 *
 * One instance, module-level: `ApiClient` holds a base URL and nothing else,
 * so there is no per-screen state for a per-screen instance to keep.
 */

import { ApiClient } from "@wattsteer/core/client";
import { API_URL } from "./config";

export const api = new ApiClient({ baseUrl: API_URL });
