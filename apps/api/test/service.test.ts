import { describe, expect, it } from "bun:test";
import { ReviewService } from "../src/api/reviews/service.js";
import { BadInputError } from "../src/errors.js";

describe("ReviewService.validate", () => {
  it("resolves the store from the app id", () => {
    expect(ReviewService.validate({ appId: "284882215" })).toEqual({
      store: "apple",
      country: "us",
    });
    expect(ReviewService.validate({ appId: "com.spotify.music" }).store).toBe("google");
  });

  it("lowercases the country and honors an explicit store", () => {
    expect(
      ReviewService.validate({ appId: "1", store: "google", country: "BR" }),
    ).toEqual({
      store: "google",
      country: "br",
    });
  });

  it("treats a blank `since` as not provided (the empty-since bug)", () => {
    expect(() => ReviewService.validate({ appId: "284882215", since: "" })).not.toThrow();
    expect(() =>
      ReviewService.validate({ appId: "284882215", since: "   " }),
    ).not.toThrow();
  });

  it("accepts a real `since` date", () => {
    expect(() =>
      ReviewService.validate({ appId: "284882215", since: "2025-01-01" }),
    ).not.toThrow();
  });

  it("rejects a non-blank invalid `since` with BadInputError", () => {
    expect(() =>
      ReviewService.validate({ appId: "284882215", since: "not-a-date" }),
    ).toThrow(BadInputError);
  });

  it("rejects an un-resolvable app id with BadInputError", () => {
    expect(() => ReviewService.validate({ appId: "nonsense" })).toThrow(BadInputError);
  });
});
