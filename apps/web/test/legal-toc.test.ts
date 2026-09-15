import { describe, expect, it } from "bun:test";
import { computeActiveSection } from "../src/hooks/use-legal-toc";

const sections = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
  { id: "c", title: "C" },
];
const positions = { a: 0, b: 500, c: 1000 };

describe("computeActiveSection", () => {
  it("first section while scrolled at the top", () => {
    expect(computeActiveSection(sections, positions, 0, false)).toBe("a");
  });

  it("switches to the next section once within the threshold", () => {
    // 420 >= 500 - 100 → b is active.
    expect(computeActiveSection(sections, positions, 420, false)).toBe("b");
  });

  it("stays on the previous section just before the threshold", () => {
    expect(computeActiveSection(sections, positions, 399, false)).toBe("a");
  });

  it("last section when bottomed out, regardless of offset", () => {
    expect(computeActiveSection(sections, positions, 300, true)).toBe("c");
  });

  it("empty section list yields an empty id", () => {
    expect(computeActiveSection([], {}, 0, false)).toBe("");
  });

  it("sections without a measured position are ignored", () => {
    expect(computeActiveSection(sections, { a: 0 }, 999, false)).toBe("a");
  });

  it("honors a custom threshold", () => {
    expect(computeActiveSection(sections, positions, 480, false, 0)).toBe("a");
    expect(computeActiveSection(sections, positions, 500, false, 0)).toBe("b");
  });

  it("picks the deepest crossed section, not just the first match", () => {
    // Past c's top: active should be c even though a and b also qualify.
    expect(computeActiveSection(sections, positions, 1000, false)).toBe("c");
  });
});
