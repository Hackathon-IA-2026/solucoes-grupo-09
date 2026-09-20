/**
 * Three properties of the feedback control that the screen cannot show and a
 * type cannot hold, asserted against the component's own source.
 *
 * The reason they are source-level: this is a `.tsx` with a `TextInput` and two
 * `Pressable`s, and `test:web` does not mount react-native-web components —
 * `apps/web/test` asserts derivations and rules, and the export is driven in
 * `test:e2e`. What is at stake here is not a rendering, it is whether three
 * decisions are still in the file, and each of them was a defect Copilot found
 * on #34 rather than a preference.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "../src/components/app/answer-feedback.tsx"),
  "utf8",
);

describe("the control that files a verdict", () => {
  it("files no second row when Send is pressed with an empty box", () => {
    /*
      The "down" verdict is already filed by the press that opened the box, so
      an empty Send used to write a second, reasonless row — two rows for one
      press, and a retrain counting verdicts would have read that thumb twice.
    */
    expect(source).toContain('if (reason.trim() !== "")');
    // Non-vacuous: the call it guards is the one that would duplicate.
    expect(source).toContain('void file("down", reason)');
  });

  it("says which thumb is selected, and not only in colour", () => {
    // After a press the selection is a border and a background. A screen
    // reader hears neither, and both buttons otherwise keep reading the same.
    expect(source).toContain("accessibilityState={{ selected: active");
  });

  it("announces what happened to the verdict", () => {
    // The sentence appears after the request, so a reader whose focus is still
    // on the thumb is never told whether it was filed or refused.
    expect(source).toContain('accessibilityLiveRegion="polite"');
    expect(source).toContain('role="status"');
  });

  it("renders no prose of its own", () => {
    // The dictionaries own every sentence; `i18n-hardcoded-copy.test.ts` holds
    // this repository-wide, and this is the same rule at the file that would
    // most tempt someone to write "Thanks!" inline.
    expect(source).toContain("useCopy().app.feedback");
    expect(source).not.toMatch(/[>{]\s*"[A-ZÀ-Ý][a-zà-ÿ]{3,}[^"]*"\s*[<}]/);
  });
});
