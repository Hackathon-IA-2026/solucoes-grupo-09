import { Elysia } from "elysia";
import { toHttpError } from "../../errors.js";

/**
 * Consistent JSON error envelope for the whole API and the safety net for any
 * error a route didn't handle itself. Validation keeps Elysia's detailed 422;
 * domain errors map to their status; anything else is a 500 whose detail is
 * logged server-side but never leaked to the client.
 */
export const errorHandler = new Elysia({ name: "error-handler" })
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") {
      return; // keep Elysia's detailed 422
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }
    const { status, body } = toHttpError(error);
    if (status >= 500) {
      console.error("💥 Unhandled API error:", error);
    }
    set.status = status;
    return body;
  })
  .as("global");
