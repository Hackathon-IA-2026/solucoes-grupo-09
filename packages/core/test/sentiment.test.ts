import { describe, expect, test } from "bun:test";
import { analyzeSentiment, classifySentiment, sentimentScore } from "../src/sentiment";

describe("sentimentScore", () => {
  test("positive and negative vocabulary", () => {
    expect(sentimentScore("this app is amazing and works great")).toBeGreaterThan(0.3);
    expect(sentimentScore("keeps crashing, totally unusable garbage")).toBeLessThan(-0.5);
  });

  test("negation flips polarity", () => {
    expect(sentimentScore("this is not good at all")).toBeLessThan(0);
    expect(sentimentScore("does not crash anymore")).toBeGreaterThan(0);
  });

  test("intensifiers amplify", () => {
    const plain = sentimentScore("the app is slow");
    const strong = sentimentScore("the app is really slow");
    expect(strong).toBeLessThan(plain);
  });

  test("no lexicon hits → 0 (unknown, not neutral)", () => {
    expect(sentimentScore("i opened it on tuesday")).toBe(0);
    expect(sentimentScore("")).toBe(0);
  });

  test("bounded to [-1, 1]", () => {
    expect(sentimentScore("scam scam scam scam fraud")).toBeGreaterThanOrEqual(-1);
    expect(sentimentScore("perfect amazing flawless superb")).toBeLessThanOrEqual(1);
  });
});

describe("classifySentiment", () => {
  test("clear, repeated text overrides the star rating", () => {
    // 5★ but the words scream problems (sarcastic/miskeyed ratings happen).
    expect(
      classifySentiment({
        rating: 5,
        body: "constantly crashing, totally unusable garbage since update",
      }),
    ).toBe("negative");
    // 1★ but glowing text (fat-fingered star).
    expect(
      classifySentiment({
        rating: 1,
        body: "absolutely amazing app, works perfect and love it",
      }),
    ).toBe("positive");
  });

  test("a single incidental lexicon hit never flips a clear rating", () => {
    // Review-confirmed regression: praising 5★ mentioning past crashes.
    expect(classifySentiment({ rating: 5, body: "they finally fixed the crashes" })).toBe(
      "positive",
    );
    expect(classifySentiment({ rating: 1, body: "one nice icon though" })).toBe(
      "negative",
    );
  });

  test("negation does not leak across sentence boundaries", () => {
    // Review-confirmed regression: "not" must not flip "crashes" in the
    // next sentence into a positive.
    expect(classifySentiment({ rating: 1, body: "Not bad. Crashes sometimes." })).toBe(
      "negative",
    );
    const clauseSafe = analyzeSentiment("no issues. crashes daily");
    expect(clauseSafe.score).toBeLessThan(0);
  });

  test("typographic apostrophes negate like ASCII ones", () => {
    // Review-confirmed regression: iOS keyboards emit U+2019.
    expect(
      classifySentiment({
        rating: 1,
        body: "Can\u2019t recommend this app, it doesn\u2019t work",
      }),
    ).toBe("negative");
  });

  test("weak or short text defers to the rating", () => {
    expect(classifySentiment({ rating: 5, body: "ok" })).toBe("positive");
    expect(classifySentiment({ rating: 1, body: "meh" })).toBe("negative");
    expect(classifySentiment({ rating: 3, body: "" })).toBe("neutral");
  });

  test("3★ with a lean follows the text", () => {
    expect(classifySentiment({ rating: 3, body: "pretty good overall" })).toBe(
      "positive",
    );
    expect(classifySentiment({ rating: 3, body: "kind of buggy lately" })).toBe(
      "negative",
    );
  });
});
