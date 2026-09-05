import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * **The boundary, asserted.** Nothing the public API serves as a *read* may
 * reach the modelling service, and re-adding a per-request inference is a
 * two-line change that nothing else in this repository would notice.
 *
 * `docs/specs/api-surface.md` seam 1 calls this "the test that keeps the
 * architecture", and the decision it keeps is not a routing preference. The
 * gateway used to forward `GET /forecast/day-ahead` to Python per request;
 * api-surface 11 deleted that route and answered the read from Postgres
 * instead. The two arrangements differ in nothing a user can see on a good day
 * and in everything they can see on a bad one: with the modelling service down,
 * one of them is a stale timestamp and the other is an outage on the
 * most-viewed screen. That difference is the whole product promise of the
 * boundary, and it survives only as long as no handler quietly dials Python
 * again.
 *
 * **What this file is not.** `solver-surface.test.ts` already asserts a version
 * of this claim over `src/api/*.ts`, and `optimize.test.ts`,
 * `replay-endpoint.test.ts` and `ml-proxy.test.ts` own the per-route failure
 * mapping. This file exists because the earlier check **enumerates**: it lists
 * the four files in `src/api` that carry no routes, reads that directory
 * non-recursively, and matches `postMl` and `ml-proxy.js` as substrings of a
 * route module's text. Three real escapes follow from that, and each is a
 * positive control below:
 *
 *  1. A handler in a **new subdirectory** — `src/api/routes/nowcast.ts` — is
 *     never read, because `readdirSync` does not descend.
 *  2. A **helper** that crosses on a route's behalf — `src/forecast/nowcast.ts`
 *     imported by `forecast.ts` — is not a route module, so nothing reads it
 *     either. The route's own text stays clean.
 *  3. A route that dials the service **without naming the proxy at all** —
 *     `fetch(\`${process.env.WATTSTEER_ML_URL}/…\`)`, or the `http://ml:8000`
 *     that `docker-compose.yml` publishes, pasted in — matches neither
 *     substring.
 *
 * So this file asserts the same property a different way, and the difference is
 * the point:
 *
 * - **The governed set is discovered, never listed.** Every `.ts` file under
 *   `apps/api/src` is read, and the modules the gateway can actually reach are
 *   the transitive closure of `src/api/index.ts`'s own imports, resolved as the
 *   runtime resolves them. A handler cannot escape by living in a directory
 *   this test has not heard of, by being a helper rather than a route, or by
 *   not being named here. The repository has been bitten by the difference
 *   before: three parity READMEs once claimed a directory-completeness check
 *   that neither suite performed, because both enumerated the subdirectory
 *   names they already knew.
 * - **The door is an import edge, not a substring.** A crossing is detected
 *   from the resolved module graph, so `import { callMl as ask } from
 *   "../api/ml-proxy.js"` five directories down is the same hit as
 *   `./ml-proxy.js` next door, and a file called `html-report.ts` is not one.
 * - **The vocabulary is read off the modelling service's own source.** The
 *   private-surface prefix and the deployment host below are checked against
 *   `apps/ml/src/wattsteer_ml/app.py` and `docker-compose.yml`, so a rename
 *   there makes this test say it has gone blind rather than pass for the wrong
 *   reason.
 * - **Sensitivity is pinned at both ends by controls held as strings.** Five
 *   plausible violations must be detected and six innocent modules must not,
 *   so both the cheap way out of a failure — loosen the detector — and the
 *   expensive one — widen it until a Postgres read is accused of running a
 *   model — break a control first.
 *
 * **False positives are as fatal as misses here.** A guard that flags
 * `curtailment.ts` for calling ONS is a guard the next author deletes, and then
 * there is no guard. That is why the signals below are three narrow ones and
 * not "no `fetch` outside the proxy": the ingest layer is inside this graph and
 * fetches ONS and Open-Meteo by design.
 *
 * **It needs no network, no database and no modelling service.** It reads
 * files. `database-ml-boundary.test.ts` carries the behavioural half.
 */

/** `apps/api/test/` → the repository root, and the two trees this file reads. */
const REPO = join(import.meta.dir, "..", "..", "..");
const API_SRC = join(REPO, "apps", "api", "src");

/** Module ids are posix-relative to `apps/api/src`, as the imports below read. */
const ENTRY = "api/index.ts";

/**
 * The **door**: the one module permitted to hold the modelling service's
 * address and to speak HTTP to it. Not a list to append to — a second entry is
 * a second failure mapping, and then "whose fault was the 500" has two answers
 * that will not agree.
 */
const DOOR = "api/ml-proxy.ts";

/**
 * The **settings registry**, which declares `mlUrl` beside every other setting.
 * It names the service's address without reaching it, and it is pinned here for
 * the same reason the door is: so that naming the address anywhere else is a
 * hit rather than an exception someone has to argue about.
 */
const SETTINGS = "config.ts";

/**
 * **Who may cross, and why each one is not a forecast.**
 *
 * `docs/specs/api-surface.md` seam 1 says "except the optimizer and replay
 * solve handlers" and api-surface 22 adds `/v1/meta` as a deliberate third.
 * There are **four**, and the fourth is not an oversight — api-surface 16 put
 * the model card here on the record, for the same reason as `/v1/meta`. Naming
 * four with reasons is the honest form of this assertion; widening it to "any
 * route that has a good reason" is how it stops meaning anything.
 *
 * The two axes that matter are *what is on the other side* and *what happens
 * when it is down*:
 *
 * | module          | verb     | what it fetches               | at 503        |
 * |-----------------|----------|-------------------------------|---------------|
 * | `optimize.ts`   | `postMl` | a MILP over user input        | fails, loudly |
 * | `replay.ts`     | both     | a replay solve, the calendar  | fails, loudly |
 * | `meta.ts`       | `callMl` | the service's self-description| degrades      |
 * | `model-card.ts` | `callMl` | a file on the artifact volume | degrades      |
 *
 * The first two are *product* crossings and cannot be precomputed: a scenario
 * is unbounded, so there is no table to read it out of. The last two are reads
 * of *diagnostic* state that only exists in the process with the volume mounted, they go through `callMl` like the others, and they degrade instead
 * of failing — `apps/ml`'s own `/v1/meta` never raises for exactly this reason,
 * while `current(lane)` does. No forecast, band, day figure or attribution is
 * on this table, and that is the property being kept.
 */
const CROSSINGS: Readonly<Record<string, string>> = {
  "api/meta.ts":
    "the modelling service's own artifact and lane view, merged into the " +
    "operator's one readout — diagnostic, not product, and it degrades to " +
    "`model.reachable: false` rather than failing",
  "api/model-card.ts":
    "the card is a file on the modelling service's volume and the gateway has " +
    "none; mirroring it into Postgres would make a second copy of the one " +
    "auditable record of an artifact",
  "api/optimize.ts": "the MILP — a solve over user input cannot be precomputed",
  "api/replay.ts":
    "the replay solve, the replayable-day calendar and the backtest aggregate",
};

/** The two of those four that may carry canonical scenario bytes to a solver. */
const SOLVER_CALLERS = ["api/optimize.ts", "api/replay.ts"];

// --- the modelling service's vocabulary, read off its own source -------------

/**
 * The modelling service's **private surface**. `apps/ml` serves
 * `/internal/publish/forecast`, `/internal/retrain` and three
 * `/internal/replay/*` routes; the gateway serves nothing under that prefix and
 * never will, because the prefix exists to mark what only the worker may call.
 * So an absolute or relative path literal under it, inside the gateway's
 * request graph, is a crossing however it was spelled.
 *
 * Checked against `app.py` below rather than trusted, so a rename there is a
 * failure here instead of a silent blindness.
 */
const PRIVATE_PREFIX = "/internal/";

/**
 * The modelling service's **deployment address**, discovered from the
 * repository's own compose file rather than written down twice.
 *
 * This is the signal that catches the laziest violation there is: the author
 * who wants a forecast in a handler, does not want to argue with `ml-proxy.ts`,
 * and pastes the host they can see in `docker-compose.yml`. It names no
 * `mlUrl`, imports no proxy, and a names-only detector reads green over it —
 * the same escape a bare numeric literal opened in the one-execution-rule
 * guard, where a second implementation that wrote its round-trip factor as
 * `0.92` instead of naming it satisfied six of seven concepts.
 */
function deployedMlHosts(): string[] {
  const compose = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
  const found = new Set<string>();
  const declaration = /WATTSTEER_ML_URL\s*:\s*["']?(https?:\/\/[^\s"']+)/g;
  for (
    let match = declaration.exec(compose);
    match !== null;
    match = declaration.exec(compose)
  ) {
    found.add(new URL(match[1] as string).host);
  }
  return [...found].sort();
}

const ML_HOSTS = deployedMlHosts();

// --- the modules, discovered ------------------------------------------------

/**
 * Every `.ts` file under `apps/api/src`, **discovered by walking**, keyed by the
 * posix id its own imports use. Listing them would reintroduce exactly the
 * escape this file exists to close.
 */
function loadModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const stack = [API_SRC];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name.endsWith(".ts")) {
        modules.set(
          relative(API_SRC, path).split(sep).join("/"),
          readFileSync(path, "utf8"),
        );
      }
    }
  }
  return modules;
}

const MODULES: ReadonlyMap<string, string> = loadModules();

/** Source with block and line comments removed — prose may not satisfy a rule,
 *  and prose may not break one either: the doc comment above names every token
 *  the signals below look for. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * Relative import and re-export specifiers, plus dynamic `import()`. Static
 * form only, and deliberately: a handler assembled by `await import(variable)`
 * is not something this test can see, and pretending otherwise would be worse
 * than saying so.
 */
const SPECIFIER =
  /(?:^|[\n;])\s*(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  const found: string[] = [];
  SPECIFIER.lastIndex = 0;
  const stripped = code(source);
  for (
    let match = SPECIFIER.exec(stripped);
    match !== null;
    match = SPECIFIER.exec(stripped)
  ) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith(".")) {
      found.push(specifier);
    }
  }
  return found;
}

/** `./ml-proxy.js` from `api/optimize.ts` → `api/ml-proxy.ts`, as Bun resolves it. */
function resolveId(
  modules: ReadonlyMap<string, string>,
  from: string,
  specifier: string,
): string | undefined {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const path = segments.join("/");
  for (const candidate of [
    path.replace(/\.js$/, ".ts"),
    `${path}.ts`,
    `${path}/index.ts`,
  ]) {
    if (modules.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Everything the gateway can reach from its composition root, with the shortest
 * import chain to each — so a failure names the route, not just the file.
 */
function requestGraph(modules: ReadonlyMap<string, string>): Map<string, string[]> {
  const chains = new Map<string, string[]>([[ENTRY, [ENTRY]]]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const chain = chains.get(id) as string[];
    for (const specifier of specifiers(modules.get(id) ?? "")) {
      const next = resolveId(modules, id, specifier);
      if (next !== undefined && !chains.has(next)) {
        chains.set(next, [...chain, next]);
        queue.push(next);
      }
    }
  }
  return chains;
}

// --- the three signals ------------------------------------------------------

/** Names imported from the door, whatever they were renamed to on the way in. */
function doorImports(modules: ReadonlyMap<string, string>, id: string): string[] {
  const source = code(modules.get(id) ?? "");
  const found = new Set<string>();
  const statement = /(?:^|[\n;])\s*import\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (
    let match = statement.exec(source);
    match !== null;
    match = statement.exec(source)
  ) {
    const specifier = match[2] as string;
    if (!specifier.startsWith(".") || resolveId(modules, id, specifier) !== DOOR) {
      continue;
    }
    for (const binding of (match[1] as string).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      found.add(binding[1] as string);
    }
  }
  return [...found].sort();
}

/**
 * Why a module is a crossing. Three narrow signals, and the narrowness is
 * deliberate: each one is *specific to the modelling service*, so a handler
 * that reads Postgres, an ingestor that fetches ONS and a chart that scales a
 * bar are all invisible to every one of them.
 */
function crossingReasons(modules: ReadonlyMap<string, string>, id: string): string[] {
  const reasons: string[] = [];
  const source = code(modules.get(id) ?? "");

  // 1. The door, as a resolved import edge rather than a substring.
  if (doorImports(modules, id).length > 0) {
    reasons.push("imports the ml-proxy boundary");
  }

  // 2. The service's address, however it is reached for. `\b` on both sides so
  //    a local `htmlUrl` is not a hit; the env name in a string literal is one,
  //    because there is no innocent reason for a handler to spell it.
  if (/\bmlUrl\b/.test(source) || /WATTSTEER_ML_URL/.test(source)) {
    reasons.push("names the modelling service's address setting");
  }

  // 3. The service's own surface, spelled out: its private prefix, or its
  //    deployment host in an absolute URL. Relative gateway route strings such
  //    as "/v1/optimize" carry no host and are not hits — the gateway's own
  //    route table is full of them.
  const literals = [...source.matchAll(/["'`]([^"'`]*)["'`]/g)].map(
    (match) => match[1] as string,
  );
  if (literals.some((literal) => literal.includes(PRIVATE_PREFIX))) {
    reasons.push(`dials the modelling service's private ${PRIVATE_PREFIX} surface`);
  }
  if (
    literals.some((literal) =>
      ML_HOSTS.some((host) => new RegExp(`https?://${host}(?![\\w.:-])`).test(literal)),
    )
  ) {
    reasons.push("hardcodes the modelling service's deployment host");
  }

  return reasons;
}

/** The door and the settings registry are the boundary, not users of it. */
const IS_BOUNDARY = (id: string) => id === DOOR || id === SETTINGS;

function crossings(
  modules: ReadonlyMap<string, string>,
): { id: string; chain: string[]; reasons: string[] }[] {
  const graph = requestGraph(modules);
  const found: { id: string; chain: string[]; reasons: string[] }[] = [];
  for (const [id, chain] of graph) {
    if (IS_BOUNDARY(id)) {
      continue;
    }
    const reasons = crossingReasons(modules, id);
    if (reasons.length > 0) {
      found.push({ id, chain, reasons });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** The real repository, plus synthetic modules, so a control is a string. */
function withModules(overlay: Record<string, string>): ReadonlyMap<string, string> {
  const modules = new Map(MODULES);
  for (const [id, source] of Object.entries(overlay)) {
    modules.set(id, source);
  }
  return modules;
}

/** `index.ts` with one more mount, which is how a new handler actually arrives. */
function mounting(id: string): string {
  const path = `./${id.replace(/^api\//, "").replace(/\.ts$/, ".js")}`;
  return `${MODULES.get(ENTRY) as string}\nimport { extra } from "${path}";\nexport const mounted = extra;\n`;
}

// --- box: the detector is calibrated ----------------------------------------

/**
 * Five violations that must be detected. Each is held as a **string**, not a
 * file, so loosening the detector to make a real failure go away breaks these
 * first and the cheap way out is closed. None of them is a copy-paste of a real
 * crossing: between them they use a renamed binding, a new directory, a helper
 * one hop from the route, an env read with no `config` import, and a pasted
 * host — which is to say, five different ways of not looking like `optimize.ts`.
 */
const VIOLATIONS: readonly [string, Record<string, string>][] = [
  [
    "a read route that re-adds the per-request inference the spec deleted",
    {
      "api/forecast.ts": `
import { Elysia } from "elysia";
import { callMl } from "./ml-proxy.js";
export const extra = new Elysia().get("/v1/forecast/day-ahead", async ({ query }) => {
  return await callMl("/v1/forecast/day-ahead", new URLSearchParams(query));
});
`,
    },
  ],
  [
    "a handler in a new subdirectory, which a flat directory listing never reads",
    {
      [ENTRY]: mounting("api/routes/nowcast.ts"),
      "api/routes/nowcast.ts": `
import { Elysia } from "elysia";
import { callMl as ask } from "../ml-proxy.js";
export const extra = new Elysia().get("/v1/nowcast", () => ask("/v1/meta"));
`,
    },
  ],
  [
    "a helper that crosses on a route's behalf, leaving the route's own text clean",
    {
      "api/forecast.ts": `
import { Elysia } from "elysia";
import { nowcast } from "../forecast/nowcast.js";
export const extra = new Elysia().get("/v1/forecast/nowcast", () => nowcast());
`,
      "forecast/nowcast.ts": `
import { callMl as reachOut } from "../api/ml-proxy.js";
export async function nowcast() {
  return await reachOut("/v1/forecast/day-ahead", new URLSearchParams());
}
`,
    },
  ],
  [
    "a route that reads the address out of the environment, naming no proxy",
    {
      "api/forecast.ts": `
import { Elysia } from "elysia";
export const extra = new Elysia().get("/v1/forecast/day-ahead", async () => {
  const answer = await fetch(\`\${process.env.WATTSTEER_ML_URL}/v1/forecast/day-ahead\`);
  return await answer.json();
});
`,
    },
  ],
  [
    "a route with the compose file's host pasted in, naming neither proxy nor setting",
    {
      "api/grid.ts": `
import { Elysia } from "elysia";
export const extra = new Elysia().get("/v1/grid/nowcast", async () => {
  const answer = await fetch("http://ml:8000/internal/publish/forecast", { method: "POST" });
  return await answer.json();
});
`,
    },
  ],
];

/**
 * Six innocent modules that must **not** be detected, because a guard that
 * accuses a Postgres read of running a model is a guard the next author
 * deletes. Each pins a specific place where widening the signal would have been
 * the easy fix:
 *
 * - prose, which is why comments are stripped: nobody should have to delete an
 *   explanation of the boundary to make this file pass, and the doc comment at
 *   the top of this test is itself covered by it;
 * - an outbound HTTP call to a *different* upstream, which is what
 *   `src/ingest/**` does all day from inside this very graph — the reason the
 *   signal is not "no `fetch` outside the proxy";
 * - a local identifier that merely contains `mlUrl` as a substring;
 * - an import whose path merely contains `ml`;
 * - the gateway's own route strings, which name `/v1/optimize` and
 *   `/v1/replay` with no host, because a handler must be allowed to say the
 *   path it serves;
 * - arithmetic on a literal, which is the shape that makes a chart look like an
 *   implementation to a careless detector.
 */
const INNOCENTS: readonly [string, Record<string, string>][] = [
  [
    "a read route whose doc comment explains the whole boundary",
    {
      "api/forecast.ts": `
import { Elysia } from "elysia";
/**
 * Answered from Postgres. It does **not** call \`postMl\` or \`callMl\`, does not
 * import \`./ml-proxy.js\`, never reads \`config.mlUrl\` or WATTSTEER_ML_URL, and
 * would not dial http://ml:8000/internal/publish/forecast if it could.
 */
export const extra = new Elysia().get("/v1/forecast/day-ahead", () => ({ hours: [] }));
// Not via mlUrl, not via WATTSTEER_ML_URL, not via /internal/retrain.
`,
    },
  ],
  [
    "an ingestor fetching ONS, which is a different upstream inside the same graph",
    {
      // Wired to a route on purpose. An overlay that nothing imports is not
      // reached by the walk, so it would pass every negative assertion while
      // proving nothing — which is how this control was written first, and
      // "every control is reachable" below is the check that caught it.
      "api/curtailment.ts": `
import { Elysia } from "elysia";
import { pull } from "../ingest/ons/nowcast.js";
export const extra = new Elysia().get("/v1/curtailment/refresh", () => pull(fetch));
`,
      "ingest/ons/nowcast.ts": `
export async function pull(fetcher: typeof fetch) {
  const answer = await fetcher("https://dados.ons.org.br/api/3/action/package_show?id=carga");
  const second = await fetch("https://api.open-meteo.com/v1/forecast?latitude=-9.4");
  return [await answer.json(), await second.json()];
}
`,
    },
  ],
  [
    "a local identifier that contains the setting's name as a substring",
    {
      "api/plants.ts": `
import { Elysia } from "elysia";
export const extra = new Elysia().get("/v1/plants/attribution", () => {
  const htmlUrl = "https://www.aneel.gov.br/siga";
  const xmlUrlTemplate = "https://example.invalid/{id}.xml";
  return { htmlUrl, xmlUrlTemplate };
});
`,
    },
  ],
  [
    "an import whose path merely contains the two letters",
    {
      "api/curtailment.ts": `
import { Elysia } from "elysia";
import { render } from "../report/html-report.js";
export const extra = new Elysia().get("/v1/curtailment/report", () => render());
`,
      "report/html-report.ts": 'export const render = () => "<p>ok</p>";\n',
    },
  ],
  [
    "a handler naming the relative paths it serves, which happen to be the solver's",
    {
      "api/canonical.ts": `
import { Elysia } from "elysia";
export const extra = new Elysia()
  .get("/v1/optimize/echo", () => ({ path: "/v1/optimize" }))
  .get("/v1/replay/echo", () => ({ path: "/v1/replay/days" }));
`,
    },
  ],
  [
    "a chart-shaped module doing arithmetic on a literal",
    {
      "api/grid.ts": `
import { Elysia } from "elysia";
export const extra = new Elysia().get("/v1/grid/bars", () => {
  const slot = 240;
  return { width: slot * 0.62, charge: slot / 0.92 };
});
`,
    },
  ],
];

describe("the ml boundary detector is calibrated", () => {
  it("reads the modelling service's private prefix off the service's own source", () => {
    // If `apps/ml` renames `/internal`, this test says so instead of quietly
    // losing a third of its sensitivity.
    const app = readFileSync(
      join(REPO, "apps", "ml", "src", "wattsteer_ml", "app.py"),
      "utf8",
    );
    const served = [...app.matchAll(/@app\.(?:get|post)\(\s*"([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(served.length).toBeGreaterThan(8);
    expect(
      served.filter((path) => path.startsWith(PRIVATE_PREFIX)).length,
    ).toBeGreaterThan(0);
    // And the prefix discriminates: inside `apps/api`, the only modules that
    // spell it are the two the *worker* runs — `forecast/publish.ts` and
    // `jobs/retrain.ts`, which are the precomputation this whole boundary
    // exists to move the model into, and which the gateway's request graph
    // cannot reach. That is what makes the prefix a signal rather than a
    // coincidence: it already separates the two sides correctly, with no
    // exception list.
    const spelling = [...MODULES.keys()]
      .filter((id) =>
        [...code(MODULES.get(id) as string).matchAll(/["'`]([^"'`]*)["'`]/g)].some(
          (match) => (match[1] as string).startsWith(PRIVATE_PREFIX),
        ),
      )
      .sort();
    expect(spelling).toEqual(["forecast/publish.ts", "jobs/retrain.ts"]);
    expect(spelling.filter((id) => requestGraph(MODULES).has(id))).toEqual([]);
  });

  it("reads the modelling service's deployment host off the compose file", () => {
    expect(ML_HOSTS).toEqual(["ml:8000"]);
  });

  it("every control is reachable, so none of them passes vacuously", () => {
    // The failure mode this closes, found while writing this file: a negative
    // control placed at a module id nothing imports is never walked, so it
    // satisfies "not detected" no matter how wide the detector gets — and the
    // widening it was written to refuse goes through. Every overlay must be in
    // the request graph *after* the overlay is applied.
    const unreachable: string[] = [];
    for (const [name, overlay] of [...VIOLATIONS, ...INNOCENTS]) {
      const graph = requestGraph(withModules(overlay));
      for (const id of Object.keys(overlay)) {
        if (!graph.has(id)) {
          unreachable.push(`${id} (${name})`);
        }
      }
    }
    expect(unreachable).toEqual([]);
  });

  for (const [name, overlay] of VIOLATIONS) {
    it(`detects ${name}`, () => {
      const modules = withModules(overlay);
      const introduced = crossings(modules)
        .map((each) => each.id)
        .filter((id) => Object.hasOwn(overlay, id) || !Object.hasOwn(CROSSINGS, id));
      // Named, not counted: a failure here should say which synthetic module
      // went undetected rather than that a number moved.
      expect(introduced.length > 0 ? introduced : ["<nothing detected>"]).not.toEqual([
        "<nothing detected>",
      ]);
      expect(introduced.some((id) => Object.hasOwn(overlay, id))).toBe(true);
    });
  }

  for (const [name, overlay] of INNOCENTS) {
    it(`does not detect ${name}`, () => {
      // Tightening the detector until a real failure goes away breaks these
      // first, and a guard that cries wolf is a guard someone deletes.
      const accused = crossings(withModules(overlay))
        .map((each) => each.id)
        .filter((id) => Object.hasOwn(overlay, id));
      expect(accused).toEqual([]);
    });
  }

  it("detects the crossings that really exist, so the scan is not blind", () => {
    // The scan's own positive control, on the real files. If `optimize.ts`
    // stops looking like a crossing, either it moved or the detector went
    // blind — and either way the assertion below would pass for the wrong
    // reason.
    const found = crossings(MODULES);
    for (const id of Object.keys(CROSSINGS)) {
      expect({
        id,
        reasons: found.find((each) => each.id === id)?.reasons ?? [],
      }).not.toEqual({ id, reasons: [] });
    }
  });
});

// --- box: the crossing table, discovered ------------------------------------

describe("only the named handlers reach the modelling service", () => {
  it("the request graph is real and was actually walked", () => {
    // A walk that found nothing would satisfy every assertion below.
    const graph = requestGraph(MODULES);
    expect(MODULES.size).toBeGreaterThan(100);
    expect(graph.size).toBeGreaterThan(80);
    expect(graph.has(DOOR)).toBe(true);
    expect(graph.has(SETTINGS)).toBe(true);
    // It descended into subdirectories, which is the property the earlier
    // check does not have.
    expect([...graph.keys()].some((id) => id.startsWith("api/plugins/"))).toBe(true);
    expect([...graph.keys()].some((id) => id.split("/").length > 2)).toBe(true);
    // And it reached the reads whose independence from the model is the point.
    for (const id of ["api/forecast.ts", "api/diagnosis.ts", "api/grid.ts"]) {
      expect([...graph.keys()]).toContain(id);
    }
  });

  it("the four crossings are exactly the ones named here, with reasons", () => {
    const found = crossings(MODULES);
    // Reported as sentences rather than as a set difference: a failure here
    // should say *which* handler reaches the modelling service, *how*, and by
    // *what import chain*, because "the count is five" sends the next author
    // looking for the fifth by hand.
    expect(
      found.map((each) =>
        Object.hasOwn(CROSSINGS, each.id)
          ? each.id
          : `${each.id} — ${each.reasons.join("; ")} — reached from ${each.chain.join(" → ")}` +
            " — docs/specs/api-surface.md seam 1: anything needing a model artifact is" +
            " computed by the worker at the gate instants and written to Postgres; the" +
            " public API reads rows. Add a row to CROSSINGS only with the argument for it.",
      ),
    ).toEqual(Object.keys(CROSSINGS).sort());
    // Every entry carries a written reason, because the point of naming them is
    // that a fifth has to be argued for rather than added.
    for (const id of Object.keys(CROSSINGS)) {
      expect((CROSSINGS[id] as string).length).toBeGreaterThan(40);
    }
  });

  it("names a fifth crossing, and the route that reaches it, when one appears", () => {
    // The failure message is the product here: "a helper five directories down
    // is reachable from `api/forecast.ts`" is actionable; "the count is 5" is
    // not.
    const modules = withModules({
      "api/forecast.ts": `
import { Elysia } from "elysia";
import { nowcast } from "../forecast/nowcast.js";
export const extra = new Elysia().get("/v1/forecast/nowcast", () => nowcast());
`,
      "forecast/nowcast.ts":
        'import { callMl } from "../api/ml-proxy.js";\nexport const nowcast = () => callMl("/v1/meta");\n',
    });
    const extra = crossings(modules).filter((each) => !Object.hasOwn(CROSSINGS, each.id));
    expect(extra.map((each) => each.id)).toEqual(["forecast/nowcast.ts"]);
    expect(extra[0]?.chain).toEqual([ENTRY, "api/forecast.ts", "forecast/nowcast.ts"]);
  });

  it("only the optimizer and the replay may carry a scenario to the solver", () => {
    // `postMl` is the verb that puts canonical scenario bytes in front of a
    // MILP. `meta.ts` and `model-card.ts` cross with a GET for a document and
    // cannot reach the solver even by accident.
    const solvers = [...requestGraph(MODULES).keys()]
      .filter((id) => !IS_BOUNDARY(id) && doorImports(MODULES, id).includes("postMl"))
      .sort();
    expect(solvers).toEqual(SOLVER_CALLERS);
    for (const id of Object.keys(CROSSINGS).filter(
      (each) => !SOLVER_CALLERS.includes(each),
    )) {
      expect({ id, imports: doorImports(MODULES, id) }).toEqual({
        id,
        imports: doorImports(MODULES, id).filter((name) => name !== "postMl"),
      });
    }
  });

  it("nothing reaches the modelling service around the door", () => {
    // One address, one failure mapping. Two would give "whose fault was the
    // 500" two answers that will not agree.
    const around = crossings(MODULES).filter(
      (each) => !each.reasons.includes("imports the ml-proxy boundary"),
    );
    expect(around).toEqual([]);
  });

  it("the door is the only module that speaks HTTP to the modelling service", () => {
    const dialling = [...requestGraph(MODULES).keys()].filter(
      (id) =>
        id !== SETTINGS && /\bmlUrl\b|WATTSTEER_ML_URL/.test(code(MODULES.get(id) ?? "")),
    );
    expect(dialling).toEqual([DOOR]);
  });
});

// --- box: nothing outside the gateway knows the service exists --------------

/**
 * `docs/specs/api-surface.md`: "Expo talks only to Elysia, and Elysia forwards
 * anything model-shaped. Keeping that boundary in one small module means the
 * web app never learns the ML service exists."
 *
 * Discovered by walking the repository, so a new package is governed on the day
 * it is created. `apps/api` is excluded because the worker legitimately calls
 * the modelling service twice a day — that is the whole precomputation
 * arrangement — and `apps/ml` is the service. Test files are excluded because
 * several of them assert the variable is *unset*, which is the opposite of a
 * breach.
 */
const OUTSIDE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const OUTSIDE_SKIP = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".expo",
  ".next",
  "test-results",
  "playwright-report",
]);

function sourceOutsideTheGateway(): string[] {
  const found: string[] = [];
  const stack = [REPO];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      const id = relative(REPO, path).split(sep).join("/");
      if (entry.isDirectory()) {
        if (
          !OUTSIDE_SKIP.has(entry.name) &&
          id !== "apps/api" &&
          id !== "apps/ml" &&
          entry.name !== "test" &&
          entry.name !== "__tests__"
        ) {
          stack.push(path);
        }
      } else if (
        OUTSIDE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)) &&
        !/\.test\.[a-z]+$/.test(entry.name)
      ) {
        found.push(id);
      }
    }
  }
  return found.sort();
}

describe("the modelling service is not named outside the gateway", () => {
  it("no web or package source knows the modelling service's address", () => {
    const files = sourceOutsideTheGateway();
    // The walk has to have found the web app, or this passes vacuously.
    expect(files.some((id) => id.startsWith("apps/web/"))).toBe(true);
    expect(files.some((id) => id.startsWith("packages/core/"))).toBe(true);

    const knowing = files.filter((id) => {
      const source = code(readFileSync(join(REPO, id), "utf8"));
      return (
        /\bmlUrl\b|WATTSTEER_ML_URL/.test(source) ||
        [...source.matchAll(/["'`]([^"'`]*)["'`]/g)].some((match) =>
          ML_HOSTS.some((host) =>
            new RegExp(`https?://${host}(?![\\w.:-])`).test(match[1] as string),
          ),
        )
      );
    });
    expect(knowing).toEqual([]);
  });
});
