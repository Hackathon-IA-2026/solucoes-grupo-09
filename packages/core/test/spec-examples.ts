/**
 * Reading the specs' own JSON examples, so they can be validated rather than
 * admired.
 *
 * `docs/specs/api-surface.md` and its four upstream specs write their contracts
 * as fenced `jsonc` blocks. Those blocks are the closest thing the project has
 * to a worked example of every response, and until now nothing checked that
 * they were even parseable, let alone that they matched the schema the code
 * validates against. This module turns a fence into a value.
 *
 * Two features of the specs' blocks make that non-trivial, and both are handled
 * rather than avoided:
 *
 *  - **Comments.** They are `jsonc` on purpose — a lot of the argument lives in
 *    a trailing `// or "en-US"`. Stripped, with a string-aware scanner, so that
 *    a `//` inside a URL is not mistaken for one.
 *  - **Elisions.** `"peak_power": { "p10": …, "p50": …, "p90": … }` and
 *    `"assets": [ /* … *\/ ]` are prose, not data. They are replaced with a
 *    sentinel, so a block that contains one is *known* to be partial and the
 *    fixture that completes it is compared only where the block is complete.
 *
 * The alternative — retyping the examples into fixtures and hoping — is what
 * the manifest test exists to prevent: an example edited in a spec and not in
 * its fixture fails, and a fence added to a spec with no manifest entry fails
 * too, so neither half can drift ahead of the other.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The marker a stripped elision leaves behind. */
export const ELIDED = "@@ELIDED@@";

export interface SpecExample {
  /** Spec file name, e.g. `api-surface.md`. */
  spec: string;
  /** 1-based line of the opening fence. A grep target, deliberately NOT the key. */
  line: number;
  /**
   * Which fenced block this is within the file, counting from zero.
   *
   * This is the manifest's key, and it used to be `line`. A line number keys an
   * example to prose that has not moved — which sounds like a virtue until you
   * notice that *editing a spec above a block* then breaks the manifest, and the
   * fix is a mechanical remap that teaches nobody anything. It happened twice.
   * An ordinal still changes when a block is added, removed or reordered, which
   * is the change actually worth a second look.
   */
  fence: number;
  /** Which document within the fence. Zero unless the block holds several. */
  position: number;
  /** The raw block, comments and all. */
  raw: string;
  /** The block parsed, with comments removed and elisions replaced by `ELIDED`. */
  value: unknown;
  /** Whether the block contains at least one elision. */
  elided: boolean;
}

/** Where the specs live, relative to `packages/core/test`. */
export const SPEC_DIR = join(import.meta.dir, "..", "..", "..", "docs", "specs");

/** Every spec file, sorted. */
export function specFiles(): string[] {
  return readdirSync(SPEC_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
}

/**
 * Remove `//` and block comments, replacing any comment that sits where a
 *value* belongs with the elision sentinel.
 *
 * A comment after `[`, `,` or `:` is standing in for data the spec chose not to
 * write out (`[ /* 24 × mwh *\/ ]`). A comment anywhere else is annotation.
 * Telling the two apart is what lets the manifest distinguish "this example is
 * complete" from "this example is a sketch".
 */
function clean(source: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  /** The last non-space character emitted — what says whether an elision is a value. */
  const previous = (): string => out.replace(/\s+$/, "").slice(-1);
  /** `{` or `[` for each container currently open. An elision means different things in each. */
  const containers: string[] = [];
  /**
   * Emit a sentinel shaped for where it sits.
   *
   * After `:` or inside an array it is a *value*. At the start of an object, or
   * after a comma inside one, it stands in for members and has to be emitted as
   * a member — `"@@ELIDED@@": true` — or the block stops being parseable, which
   * would make the specs' own examples untestable for a punctuation reason.
   */
  const elide = (): void => {
    const before = previous();
    const container = containers.at(-1);
    if (before === "{" || (before === "," && container === "{")) {
      out += `"${ELIDED}": true`;
      return;
    }
    if (before === "[" || before === "," || before === ":") {
      out += `"${ELIDED}"`;
      return;
    }
    if (container === "[") {
      // "and more entries like the one above" — `// … N, S, SE` under
      // `subsystems`, `// ... eight entries` under `groups`. The example names
      // a shape and refuses to retype it three more times, which is right for
      // prose and fatal for a length assertion, so the list is marked partial.
      out += `, "${ELIDED}"`;
    }
  };

  /**
   * Is this comment standing in for data, or annotating it?
   *
   * A block comment where a value must appear is always an elision — there is
   * nothing else it could be. A comment anywhere else is an elision only if it
   * says so with an ellipsis, which is how the specs write it. Without that
   * distinction `// no_artifact | present_unpromoted | promoted` would be read
   * as missing members rather than as a note about an enum.
   */
  const isElision = (text: string, valueSlot: boolean, block: boolean): boolean =>
    (block && valueSlot) || text.includes("…") || text.includes("...");
  while (index < source.length) {
    const char = source[index] as string;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "…") {
      elide();
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      const before = previous();
      const valueSlot =
        before === "{" || before === "[" || before === "," || before === ":";
      if (isElision(source.slice(index, stop), valueSlot, false)) {
        elide();
      }
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      const before = previous();
      const valueSlot =
        before === "{" || before === "[" || before === "," || before === ":";
      if (isElision(source.slice(index, stop), valueSlot, true)) {
        elide();
      }
      index = stop;
      continue;
    }
    if (char === "{" || char === "[") {
      containers.push(char);
    } else if (char === "}" || char === "]") {
      containers.pop();
    }
    out += char;
    index += 1;
  }
  // A `…` that stood in for "and more members" leaves a dangling comma behind.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function containsSentinel(value: unknown): boolean {
  if (value === ELIDED) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsSentinel);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).includes(ELIDED) || Object.values(record).some(containsSentinel)
    );
  }
  return false;
}

/**
 * One fence can hold more than one document — `docs/specs/flex-optimizer.md`
 * writes the battery and the shiftable load in a single block, separated by a
 * comment. Split at top-level brace depth, string-aware, so each is validated
 * against the variant it is an example of rather than being lumped together.
 */
function splitDocuments(cleaned: string): string[] {
  const documents: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        documents.push(cleaned.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return documents;
}

/** Every JSON document in every fenced `json` / `jsonc` block in one spec file. */
export function examplesIn(spec: string): SpecExample[] {
  const lines = readFileSync(join(SPEC_DIR, spec), "utf8").split("\n");
  const found: SpecExample[] = [];
  let fence = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```jsonc?$/.test(lines[index] ?? "")) {
      continue;
    }
    const close = lines.indexOf("```", index + 1);
    const raw = lines.slice(index + 1, close === -1 ? lines.length : close).join("\n");
    const documents = splitDocuments(clean(raw));
    if (documents.length === 0) {
      throw new SyntaxError(`${spec}:${index + 1} holds no JSON document`);
    }
    const fenceIndex = fence;
    fence += 1;
    documents.forEach((document, position) => {
      let value: unknown;
      try {
        value = JSON.parse(document) as unknown;
      } catch (cause) {
        throw new SyntaxError(
          `${spec}:${index + 1}#${position} is not parseable after comment stripping: ${(cause as Error).message}`,
        );
      }
      found.push({
        spec,
        line: index + 1,
        fence: fenceIndex,
        position,
        raw,
        value,
        elided: containsSentinel(value),
      });
    });
    index = close === -1 ? lines.length : close;
  }
  return found;
}

/** The manifest key for one document: `api-surface.md#2.0` — file, fence, position. */
export function exampleKey(example: SpecExample): string {
  return `${example.spec}#${example.fence}.${example.position}`;
}

/** Every example in every spec, in file then line order. */
export function allExamples(): SpecExample[] {
  return specFiles().flatMap((spec) => examplesIn(spec));
}

/**
 * Assert that a fixture reproduces every part of a spec block that the spec
 * actually wrote down.
 *
 * A subtree containing an elision is skipped — the spec did not state it, so
 * the fixture is free to complete it. A subtree free of elisions is compared
 * exactly, which is what stops a fixture quietly correcting a spec instead of
 * the spec being corrected.
 *
 * Returns the paths that disagree; an empty array is agreement.
 */
export function nonElidedDisagreements(
  block: unknown,
  fixture: unknown,
  path = "",
): string[] {
  if (Array.isArray(block)) {
    // A list with an elision in it names a shape, not a length, so nothing in
    // it is a stated fact about the whole list. A list without one is compared
    // whole: the spec wrote every member it meant.
    if (containsSentinel(block)) {
      return [];
    }
    return JSON.stringify(block) === JSON.stringify(fixture)
      ? []
      : [path === "" ? "/" : path];
  }
  if (typeof block === "object" && block !== null) {
    // Objects are always walked, elided or not, so that `completes` can name
    // one field rather than having to exempt the whole document to state that
    // one string in it was prose. A key the block never mentions is free — the
    // spec omitting a field is not the spec forbidding it.
    const other = (
      typeof fixture === "object" && fixture !== null ? fixture : {}
    ) as Record<string, unknown>;
    return Object.entries(block as Record<string, unknown>)
      .filter(([key]) => key !== ELIDED)
      .flatMap(([key, value]) =>
        nonElidedDisagreements(value, other[key], path === "" ? key : `${path}.${key}`),
      );
  }
  if (block === ELIDED) {
    return [];
  }
  return JSON.stringify(block) === JSON.stringify(fixture)
    ? []
    : [path === "" ? "/" : path];
}
