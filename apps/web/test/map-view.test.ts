/**
 * The saved camera, and the half-read one it refuses.
 *
 * A camera parsed loosely is worse than none: it points the globe at a
 * plausible-looking wrong place, and a reader has no way to tell that from the
 * framing they saved. So the round trip is pinned, and so is every way a
 * malformed value can arrive from a hand-edited link.
 */

import { describe, expect, it } from "bun:test";
import { formatView, type MapView, parseView } from "../src/lib/map-view";

const VIEW: MapView = {
  longitude: -52.104,
  latitude: -15.823,
  height: 6_412_345,
  heading: 0,
  pitch: -34.2,
};

describe("a camera round-trips", () => {
  it("survives format and parse", () => {
    const back = parseView(formatView(VIEW));
    expect(back).toEqual({ ...VIEW, height: 6_412_345 });
  });

  it("rounds to what a camera can tell apart", () => {
    // Three decimals of degree is about 100 m, and a metre of altitude is well
    // below what a reader could notice at this range. The point is a short
    // link, not a precise one.
    expect(formatView(VIEW)).toBe("-52.104,-15.823,6412345,0.0,-34.2");
  });
});

describe("a camera that cannot be fully read is refused", () => {
  const bad: [string, string | null | undefined][] = [
    ["nothing", null],
    ["undefined", undefined],
    ["empty", ""],
    ["too few fields", "-52,-15,6400000,0"],
    ["too many fields", "-52,-15,6400000,0,-34,9"],
    ["not numbers", "-52,-15,here,0,-34"],
    ["longitude off the earth", "-521,-15,6400000,0,-34"],
    ["latitude off the earth", "-52,-95,6400000,0,-34"],
    ["underground", "-52,-15,-10,0,-34"],
    ["past the moon", "-52,-15,7e7,0,-34"],
    ["pitch past vertical", "-52,-15,6400000,0,-91"],
  ];

  for (const [name, raw] of bad) {
    it(`refuses ${name}`, () => {
      expect(parseView(raw)).toBeNull();
    });
  }

  it("accepts the edges, which are real positions", () => {
    // A camera exactly over the pole or looking straight down is unusual and
    // not wrong; refusing it would be the parser inventing a rule.
    expect(parseView("180,90,1,360,-90")).not.toBeNull();
    expect(parseView("-180,-90,1,-360,90")).not.toBeNull();
  });
});
