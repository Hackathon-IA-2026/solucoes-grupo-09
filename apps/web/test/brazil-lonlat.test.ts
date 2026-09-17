/**
 * The globe's geometry, checked against cities rather than against itself.
 *
 * A round-trip test would pass on a projection inverted with the wrong sign and
 * a country drawn upside down in the sea. What cannot pass by accident is a real
 * city's real coordinates landing inside the region ONS bills it to — so that is
 * the assertion, and two of the six are chosen because the electrical answer and
 * the geographic answer differ.
 */

import { describe, expect, it } from "bun:test";
import type { SubsystemCode } from "@wattsteer/core";
import { subsystemRings, unproject } from "../src/lib/geo/brazil-lonlat";

/** Ray casting, on any of a subsystem's rings. */
function contains(code: SubsystemCode, lon: number, lat: number): boolean {
  return subsystemRings(code).some((ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as [number, number];
      const [xj, yj] = ring[j] as [number, number];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  });
}

describe("the inverted projection puts cities in the right subsystem", () => {
  const cities: [string, number, number, SubsystemCode][] = [
    ["Belém", -48.5, -1.46, "N"],
    ["Fortaleza", -38.54, -3.73, "NE"],
    ["São Paulo", -46.63, -23.55, "SE"],
    ["Curitiba", -49.27, -25.43, "S"],
  ];

  for (const [name, lon, lat, code] of cities) {
    it(`${name} is in ${code}`, () => {
      expect(contains(code, lon, lat)).toBe(true);
    });
  }
});

describe("the subsystems are electrical, not geographic", () => {
  // The two that prove the grouping survived the round trip. Getting these
  // wrong is the failure this whole module exists to make impossible, and it is
  // the one a reviewer glancing at a globe would never catch: both look right.
  it("São Luís is in Norte, though Maranhão is in the Nordeste region", () => {
    expect(contains("N", -44.3, -2.53)).toBe(true);
    expect(contains("NE", -44.3, -2.53)).toBe(false);
  });

  it("Porto Velho is in Sudeste/Centro-Oeste, though Rondônia is in the North", () => {
    expect(contains("SE", -63.9, -8.76)).toBe(true);
    expect(contains("N", -63.9, -8.76)).toBe(false);
  });
});

describe("the outlines are usable as polygons", () => {
  it("every ring has at least three points", () => {
    // Cesium throws while building a geometry from a two-point ring, which
    // would take the whole globe down over a sliver of a dropped island.
    for (const code of ["N", "NE", "SE", "S"] as SubsystemCode[]) {
      for (const ring of subsystemRings(code)) {
        expect(ring.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("stays inside Brazil's bounding box", () => {
    for (const code of ["N", "NE", "SE", "S"] as SubsystemCode[]) {
      for (const ring of subsystemRings(code)) {
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThan(-75);
          expect(lon).toBeLessThan(-32);
          expect(lat).toBeGreaterThan(-35);
          expect(lat).toBeLessThan(6);
        }
      }
    }
  });

  it("the origin corner unprojects to the north-west of the country", () => {
    const [lon, lat] = unproject(0, 0);
    expect(lon).toBeCloseTo(-73.99, 1);
    expect(lat).toBeCloseTo(5.27, 1);
  });
});
