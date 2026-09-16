/**
 * Every scene type reaches a renderer, and every renderer survives no data.
 *
 * The failure this guards is quiet: a scene type composed but not rendered
 * leaves the stage blank for its whole duration, and the sequence moves on as
 * if it had shown something. Nothing throws, nothing logs, and the reader gets
 * a hole in the middle of an answer.
 *
 * Read off the source rather than by rendering, which is the idiom
 * `voice-provider.test.ts` already uses here: the question is whether the
 * `switch` has an arm, and that is a fact about the file.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENE_TYPES } from "@/lib/voice/briefing/types";

const SRC = join(import.meta.dir, "..", "src");
const RENDERER = readFileSync(
  join(SRC, "components", "briefing", "scene-renderer.tsx"),
  "utf8",
);
const COMPOSE = readFileSync(join(SRC, "lib", "voice", "briefing", "compose.ts"), "utf8");
const DATA = readFileSync(
  join(SRC, "components", "briefing", "briefing-data.ts"),
  "utf8",
);

describe("the scene language is closed, and fully rendered", () => {
  it("every scene type has an arm in the renderer", () => {
    for (const type of SCENE_TYPES) {
      expect(RENDERER).toContain(`case "${type}":`);
    }
  });

  it("every scene type is reachable — the composer can emit it", () => {
    // A type nothing composes is a type that is wrong about something: either
    // the composer is missing a case or the union has a member it should not.
    for (const type of SCENE_TYPES) {
      expect(COMPOSE).toContain(`type: "${type}"`);
    }
  });

  it("the renderer draws no figure the screen did not hand it", () => {
    // The rule that makes a spoken answer inherit the screens' guarantee. The
    // renderer may read `data.*` and the scene's own selectors; it may not
    // fetch, and it may not do arithmetic on what it is given.
    expect(RENDERER).not.toContain("ApiClient");
    expect(RENDERER).not.toContain("fetch(");
    expect(RENDERER).not.toContain("useEffect");
  });

  it("every slice of briefing data is nullable, and the empty one sets them all", () => {
    // A scene with nothing to show draws its heading. That is only possible if
    // every field can actually be absent.
    const fields = [...DATA.matchAll(/readonly (\w+):/g)].map((match) => match[1]);
    expect(fields.length).toBeGreaterThan(5);
    for (const field of fields) {
      expect(DATA).toContain(`${field}: null,`);
    }
  });
});

describe("the briefing never reaches for its own data", () => {
  it("no component under briefing/ imports the API client", () => {
    for (const file of [
      "scene-renderer.tsx",
      "briefing-stage.tsx",
      "briefing-host.tsx",
      "briefing-subject.tsx",
    ]) {
      const source = readFileSync(join(SRC, "components", "briefing", file), "utf8");
      // The one direction this feature must never take: a briefing that reads
      // its own copy could disagree with the screen a reader dismisses onto.
      expect(source).not.toContain("@/lib/api");
      expect(source).not.toContain("useNetwork");
      expect(source).not.toContain("useExplain");
      expect(source).not.toContain("useOptimization");
    }
  });
});
