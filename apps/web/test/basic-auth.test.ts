import { describe, expect, it } from "bun:test";
import {
  basicAuthChallenge,
  basicAuthFrom,
  basicAuthorized,
} from "../scripts/basic-auth";

const auth = { user: "wattsteer", password: "s3cret" };
const header = (credentials: string) =>
  `Basic ${Buffer.from(credentials).toString("base64")}`;

describe("the event's password", () => {
  it("is off unless both variables are set", () => {
    expect(basicAuthFrom({})).toBeNull();
    expect(basicAuthFrom({ WATTSTEER_WEB_USER: "wattsteer" })).toBeNull();
    expect(basicAuthFrom({ WATTSTEER_WEB_PASSWORD: "s3cret" })).toBeNull();
    expect(
      basicAuthFrom({
        WATTSTEER_WEB_USER: "wattsteer",
        WATTSTEER_WEB_PASSWORD: "s3cret",
      }),
    ).toEqual(auth);
  });

  it("accepts only the configured user and password", () => {
    expect(basicAuthorized(header("wattsteer:s3cret"), auth)).toBe(true);
    expect(basicAuthorized(header("wattsteer:wrong!"), auth)).toBe(false);
    expect(basicAuthorized(header("wattsteer:s3cret-longer"), auth)).toBe(false);
    expect(basicAuthorized(header("other:s3cret"), auth)).toBe(false);
    expect(basicAuthorized(null, auth)).toBe(false);
    expect(basicAuthorized("Bearer s3cret", auth)).toBe(false);
  });

  it("asks the browser for it, uncached", () => {
    const response = basicAuthChallenge();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toStartWith("Basic ");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
