import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every canonical query parameter a route declares is one a handler reads.
 *
 * `/v1/canonical/*` is the modelling service's data plane — ADR-0005, *"the
 * canonical layer publishes reads"* — and each route is query-parameter wiring:
 * Elysia validates the shape, the handler copies the values across into a
 * repository query. Between those two steps is a name typed twice.
 *
 * Getting it wrong is silent in both directions and neither shows up as an
 * error. A parameter **declared and not read** validates a caller's request and
 * then ignores it: the repository sees `undefined` and answers unfiltered. A
 * parameter **read and not declared** is `undefined` on every request, because
 * the schema rejected or dropped it before the handler ran.
 *
 * On this route set the unfiltered answer is the dangerous one. `as_of` and
 * `published_at_or_before` are the vintage gates — what WattSteer had learned
 * by an instant, and what had been published by one. A read that quietly loses
 * either returns rows from after the cut, and a model trained on that has been
 * shown the future. It would score beautifully and be worthless, which is the
 * failure this whole layer is built to make impossible.
 *
 * So both directions are asserted, off the source, because there is no runtime
 * here that would notice either.
 */

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "src", "api", "canonical.ts"),
  "utf8",
);

/**
 * The bodies of every query schema in the file.
 *
 * Brace-matched rather than regexed to a closing line: a `t.Object` argument
 * contains nested objects, and a non-greedy match to the first `}` stops inside
 * the first `t.String({ description })` it meets.
 */
function queryBlocks(source: string): string[] {
  const out: string[] = [];
  const opener = /(?:query:\s*t\.Object\(|(?:FACT_QUERY|REGISTRY_QUERY)\s*=\s*)\{/g;
  let match = opener.exec(source);
  while (match !== null) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(start + 1, index));
          break;
        }
      }
    }
    match = opener.exec(source);
  }
  return out;
}

/** A block with its nested objects removed, so only its own keys remain. */
function topLevel(block: string): string {
  let depth = 0;
  let out = "";
  for (const char of block) {
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

/**
 * One route's source: its path, its handler and its query schema.
 *
 * **Per route, not per file**, and the difference is the whole check. A
 * file-level set comparison was the first version of this test and it does not
 * work: six routes declare `plant_ons_code`-shaped keys and several share a
 * name, so a handler that stopped reading one of them still finds the name read
 * elsewhere in the file, and the assertion passes. Verified by making that exact change
 * — dropping `published_at_or_before` from the training-window handler — and
 * watching the file-level version stay green.
 */
const ROUTES = SOURCE.split("\n  .get(").slice(1);

/**
 * The keys a route names one at a time, which are the only ones that can drift.
 *
 * `FACT_QUERY` and `REGISTRY_QUERY` are spread into a schema and consumed
 * wholesale by `factWindow(query)` / `registryWindow(query)`, so their names are
 * never retyped and there is nothing to mistype. Keys written individually on a
 * route are copied across by hand, one name on each side.
 */
function individuallyDeclared(route: string): string[] {
  return queryBlocks(route).flatMap((block) =>
    [...topLevel(block).matchAll(/(?:^|,)\s*([a-z][A-Za-z0-9_]*)\s*:/g)].map(
      (found) => found[1] as string,
    ),
  );
}

const readsOf = (route: string): Set<string> =>
  new Set(
    [...route.matchAll(/query\.([a-z_][a-z0-9_]*)/g)].map((found) => found[1] as string),
  );

/*
  Two sets, because two different questions are asked of them.

  `DECLARED` is every key any schema in the file names, the shared
  `FACT_QUERY` / `REGISTRY_QUERY` spreads included — that is the file's whole
  vocabulary, and it is what the vintage-gate check and the read-but-undeclared
  check are about.

  The drift check below uses `individuallyDeclared` per route instead, because
  a spread key is never retyped and cannot drift.
*/
const BLOCKS = queryBlocks(SOURCE);
const DECLARED = new Set(
  BLOCKS.flatMap((block) =>
    [...topLevel(block).matchAll(/(?:^|,)\s*([a-z][A-Za-z0-9_]*)\s*:/g)].map(
      (found) => found[1] as string,
    ),
  ),
);
const READ = new Set(
  [...SOURCE.matchAll(/query\.([a-z_][a-z0-9_]*)/g)].map((found) => found[1] as string),
);

describe("the canonical routes read what they declare", () => {
  it("the scan found the schemas, or everything below is vacuous", () => {
    // Non-vacuity for the file. Two empty sets agree perfectly, so a parser
    // that silently matched nothing would make every assertion here pass.
    expect(BLOCKS.length).toBeGreaterThanOrEqual(10);
    expect(DECLARED.size).toBeGreaterThanOrEqual(10);
    expect(READ.size).toBeGreaterThanOrEqual(10);
  });

  it("found every route, so a per-route gap has somewhere to show up", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it("no route declares a parameter its own handler then ignores", () => {
    // The dangerous direction: validated, accepted, and dropped on the floor —
    // the repository answers unfiltered and the caller is never told.
    const ignored = ROUTES.flatMap((route) => {
      const read = readsOf(route);
      return individuallyDeclared(route).filter((key) => !read.has(key));
    }).sort();
    expect(ignored).toEqual([]);
  });

  it("reads no parameter it did not declare", () => {
    // The other direction is merely dead: the schema drops an undeclared key
    // before the handler runs, so the read is `undefined` on every request.
    const undeclared = [...READ].filter((key) => !DECLARED.has(key)).sort();
    expect(undeclared).toEqual([]);
  });

  it("still carries both vintage gates", () => {
    /*
      Named rather than left to the set comparison, because these two are why
      the comparison matters. `as_of` is what WattSteer had learned by an
      instant; `published_at_or_before` is what had been published by one. A
      read that loses either returns rows from after the cut, and a model
      trained on those has been shown the future.
    */
    for (const gate of ["as_of", "published_at_or_before"]) {
      expect(DECLARED.has(gate)).toBe(true);
      expect(READ.has(gate)).toBe(true);
    }
  });
});
