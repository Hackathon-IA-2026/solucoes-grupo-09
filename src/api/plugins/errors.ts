import { Elysia } from "elysia";

/**
 * Consistent JSON error envelope for the whole API. Validation errors keep
 * Elysia's detailed 422; everything else is normalized so internal failures
 * never leak a stack trace to clients.
 */
export const errorHandler = new Elysia({ name: "error-handler" })
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") return; // keep Elysia's detailed 422
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }
    console.error("💥 Unhandled API error:", error);
    set.status = 500;
    return { error: "Internal server error" };
  })
  .as("global");
