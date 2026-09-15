import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loggableError } from "../src/errors.js";

/**
 * A Redis password reached a deployment log once. This is the guard that stops
 * the next one.
 *
 * ioredis hangs the failed command off the error object — `err.command` is
 * `{ name: "auth", args: ["default", "<the password>"] }` — and Bun's console
 * prints an `Error`'s own properties verbatim. So `console.error("…", err)` is
 * not a logging style, it is an exfiltration path that only fires on the day
 * the password is wrong, which is the day somebody is watching the logs.
 *
 * `redactedRedisError` was written when that happened and applied to **one** of
 * the two Redis handlers. The other, in `api/jobs-dashboard.ts`, kept logging
 * the object for months — and it is the more exposed of the two, because it
 * only runs when `WATTSTEER_DASHBOARD` is on, which is the configuration most
 * likely to be switched on by hand against a password somebody has just typed.
 * Five process-level sinks could receive the same object through an unhandled
 * rejection and none of them were narrowed either.
 *
 * So the rule is structural rather than per-site: **nothing in `src/` passes a
 * bare caught value to a console.** The narrowing is `loggableError`, which
 * keeps the stack — an uncaught exception with no frames is an incident with no
 * lead — and drops own-properties by construction rather than by redaction.
 */

const SRC = join(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Source with comments stripped, so a rule cannot match its own explanation. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("no console call can carry an error's attached properties", () => {
  it("finds console calls at all, so the sweep below means something", () => {
    // Non-vacuity. If the matcher stopped matching, every assertion here would
    // pass against an empty set — which is exactly how a guard rots.
    const total = sourceFiles(SRC).filter((path) =>
      /console\.(error|warn|log)\(/.test(codeOf(path)),
    );
    expect(total.length).toBeGreaterThan(5);
  });

  it("passes no bare caught value to a console", () => {
    // The shapes that leak: `console.error("…", err)` where `err` is the binding
    // from a `catch`, an `.on("error", …)` handler or a process handler. A
    // narrowed call — `loggableError(err)`, `err.message`, `String(err)` — is
    // fine and is what every site should look like.
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const code = codeOf(path);
      const matches = code.matchAll(
        /console\.(?:error|warn|log)\([^)]*?,\s*(err|error|reason|cause|e)\s*\)/g,
      );
      for (const match of matches) {
        offenders.push(`${path.slice(SRC.length + 1)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("loggableError drops what a library attached, and keeps what a human needs", () => {
  it("does not carry an ioredis AUTH command's arguments", () => {
    // The actual shape, from the incident: ioredis sets `command` on the error.
    const password = "s3cret-rotate-me";
    const error = Object.assign(new Error("WRONGPASS invalid username-password pair"), {
      command: { name: "auth", args: ["default", password] },
    });
    const logged = loggableError(error);
    expect(logged).not.toContain(password);
    expect(logged).not.toContain("args");
    // And it is not passing merely by being empty.
    expect(logged).toContain("WRONGPASS");
  });

  it("keeps the stack, because an exception with no frames is a dead end", () => {
    const logged = loggableError(new Error("boom"));
    expect(logged).toContain("boom");
    expect(logged).toContain("at ");
  });

  it("drops any own-property, not a list of known ones", () => {
    // The distinction that makes this right by construction: a redactor has to
    // be correct about every field ioredis — or the next library — might add.
    // `Error.prototype.stack` is built from the name, the message and the
    // frames and never walks own-properties, so this has to be correct about
    // one thing: that `stack` is a string.
    const error = Object.assign(new Error("boom"), {
      connectionString: "redis://default:hunter2@host:6379",
      apiKey: "xai-do-not-log-me",
      nested: { deep: { token: "also-secret" } },
    });
    const logged = loggableError(error);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("xai-do-not-log-me");
    expect(logged).not.toContain("also-secret");
  });

  it("survives a thrown non-Error", () => {
    expect(loggableError("just a string")).toBe("just a string");
    expect(loggableError(undefined)).toBe("undefined");
    expect(loggableError({ toString: () => "odd" })).toBe("odd");
  });
});
