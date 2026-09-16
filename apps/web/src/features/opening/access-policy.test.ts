import { describe, expect, it } from "vitest";
import {
  OPENING_TEST_FIXTURE_ORIGIN,
  allowRegistration,
  assertAllowedCookieAuthOrigin,
  isAllowedCookieAuthOrigin,
  isOpeningRelease,
} from "./access-policy";

describe("allowRegistration", () => {
  it("blocks registration in opening release mode", () => {
    expect(allowRegistration({ openingRelease: true })).toBe(false);
    expect(allowRegistration({ openingRelease: false })).toBe(true);
  });
});

describe("isOpeningRelease", () => {
  it("reads OPENING_RELEASE truthy flags", () => {
    expect(isOpeningRelease({ OPENING_RELEASE: "1" })).toBe(true);
    expect(isOpeningRelease({ OPENING_RELEASE: "true" })).toBe(true);
    expect(isOpeningRelease({ OPENING_RELEASE: "0" })).toBe(false);
    expect(isOpeningRelease({})).toBe(false);
  });
});

describe("cookie-auth origin", () => {
  const publicBase = "http://localhost:3000";

  it("allows same-origin requests, including explicitly configured fixtures", () => {
    expect(
      isAllowedCookieAuthOrigin("http://localhost:3000", publicBase),
    ).toBe(true);
    expect(
      isAllowedCookieAuthOrigin(OPENING_TEST_FIXTURE_ORIGIN, OPENING_TEST_FIXTURE_ORIGIN),
    ).toBe(true);
  });

  it("does not exempt a fixture origin from the configured same-origin boundary", () => {
    expect(
      isAllowedCookieAuthOrigin(OPENING_TEST_FIXTURE_ORIGIN, publicBase),
    ).toBe(false);
    expect(() =>
      assertAllowedCookieAuthOrigin(OPENING_TEST_FIXTURE_ORIGIN, "https://study.example"),
    ).toThrow(/Foreign Origin/);
  });

  it("denies missing and foreign Origin", () => {
    expect(isAllowedCookieAuthOrigin(null, publicBase)).toBe(false);
    expect(isAllowedCookieAuthOrigin(undefined, publicBase)).toBe(false);
    expect(
      isAllowedCookieAuthOrigin("https://evil.example", publicBase),
    ).toBe(false);
    expect(() =>
      assertAllowedCookieAuthOrigin(null, publicBase),
    ).toThrow(/Missing Origin/);
  });
});
