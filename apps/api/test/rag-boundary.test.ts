/**
 * The evidence service has one door too.
 *
 * `ml-boundary.test.ts` narrowed itself to stop reporting `/internal/rag/*` as
 * a modelling crossing, and that narrowing is only safe because this file
 * exists. The worry it answers is the one that argued against narrowing in the
 * first place: a handler that dials the corpus on a request path is the same
 * defect as a handler that dials the model, however different the service.
 *
 * Two rules, and they are not the same rule:
 *
 *  1. **One door.** `api/rag-proxy.ts` is the only module that speaks HTTP to
 *     the evidence service from the gateway, and `config.ts` the only one that
 *     names its address. A second door is a second failure mapping.
 *  2. **Reads only.** The door may fetch a stored row and may never ask for one
 *     to be built. Building runs a language model on a free tier, and a page
 *     that waited for it is a page that sometimes does not arrive.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DOOR = "api/rag-proxy.ts";
const SETTINGS = "config.ts";
/** The job that builds. It is a schedule, not a request path, and may. */
const BUILDER = "jobs/rag-evidence.ts";
/** The job that asks the corpus to refresh itself. Also a schedule. */
const REFRESHER = "jobs/rag-refresh.ts";
/** The scheduler, which decides whether the two jobs are registered at all. */
const WORKER = "worker.ts";
/** The public read. It names the path and goes through the door for it. */
const ROUTE = "api/evidence.ts";

function modules(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${entry}/`);
        continue;
      }
      if (entry.endsWith(".ts")) {
        found.set(`${prefix}${entry}`, readFileSync(full, "utf8"));
      }
    }
  };
  walk(SRC, "");
  return found;
}

/** Source with comments stripped: a claim in prose is not a claim in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const MODULES = modules();

describe("one door to the evidence service", () => {
  it("only the door and the settings registry name its address", () => {
    const naming = [...MODULES.entries()]
      .filter(([, source]) => /\bragUrl\b|WATTSTEER_RAG_URL/.test(code(source)))
      .map(([id]) => id)
      .sort();
    // The two jobs name it because they call it directly, and they are
    // schedules — the gateway's request graph cannot reach them, which is the
    // whole reason they may. `worker.ts` names it to decide whether to register
    // them at all, and says so at boot when it does not.
    expect(naming).toEqual([BUILDER, REFRESHER, DOOR, SETTINGS, WORKER].sort());
  });

  it("only the door dials its private surface", () => {
    const dialling = [...MODULES.entries()]
      .filter(([, source]) => code(source).includes("/internal/rag/"))
      .map(([id]) => id)
      .sort();
    /*
      The route is here and that is correct: it names the path it wants and
      hands it to the door, exactly as `model-card.ts` names `/v1/model/card`
      and calls `callMl`. Naming a path is not speaking HTTP to a service.

      **And the door is not here**, which is the better half of the property.
      `readRag` takes the path as an argument, so the module that speaks HTTP
      knows no routes and the modules that know routes speak no HTTP. Neither
      list is a subset of the other, and that is what makes "one door" a
      structural fact rather than a convention.
    */
    expect(dialling).toEqual([BUILDER, REFRESHER, ROUTE].sort());
  });

  it("the route module goes through the door rather than around it", () => {
    const route = code(MODULES.get("api/evidence.ts") as string);
    expect(route).toContain("readRag(");
    // No `fetch(` of its own, which is what the first draft did and what
    // `ml-boundary.test.ts` caught within a minute.
    expect(route).not.toMatch(/\bfetch\s*\(/);
    expect(route).not.toMatch(/\bragUrl\b/);
  });
});

describe("the door reads and never builds", () => {
  it("issues no POST", () => {
    /*
      `POST /internal/rag/evidence` runs a language model. The schedule may
      spend a minute on that; a reader's request may not, and a gateway that
      started a model on a page view is the defect the sibling boundary exists
      to prevent — the service being different does not make it a different
      defect.
    */
    const door = code(MODULES.get(DOOR) as string);
    expect(door).not.toMatch(/method:\s*["']POST["']/);
  });

  it("and the builder is a job, not a handler", () => {
    // Non-vacuity for the rule above: something must be allowed to POST, or
    // the assertion holds of a repository that cannot build evidence at all.
    expect(code(MODULES.get(BUILDER) as string)).toMatch(/method:\s*["']POST["']/);
  });
});
