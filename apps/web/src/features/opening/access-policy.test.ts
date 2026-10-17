import { describe, expect, it } from "vitest";
import {
  OPENING_TEST_FIXTURE_ORIGIN,
  allowRegistration,
  allowsDemoStudyData,
  assertAllowedCookieAuthOrigin,
  isAllowedCookieAuthOrigin,
  isOpeningRelease,
  shouldRedirectLegacyMockPages,
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

  it("closes production registration by default and requires an explicit false value", () => {
    expect(isOpeningRelease({ NODE_ENV: "production" })).toBe(true);
    expect(isOpeningRelease({ NODE_ENV: "production", OPENING_RELEASE: "" })).toBe(true);
    expect(isOpeningRelease({ NODE_ENV: "production", OPENING_RELEASE: "typo" })).toBe(true);
    for (const value of ["0", "false", "no"]) {
      expect(isOpeningRelease({ NODE_ENV: "production", OPENING_RELEASE: value })).toBe(false);
    }
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

describe("allowsDemoStudyData", () => {
  it("is false in production regardless of OPENING_RELEASE", () => {
    expect(allowsDemoStudyData({ NODE_ENV: "production" })).toBe(false);
    expect(allowsDemoStudyData({ NODE_ENV: "production", OPENING_RELEASE: "0" })).toBe(false);
    expect(allowsDemoStudyData({ NODE_ENV: "production", OPENING_RELEASE: "1" })).toBe(false);
  });

  it("is true outside production so local demo surfaces can still run", () => {
    expect(allowsDemoStudyData({ NODE_ENV: "development" })).toBe(true);
    expect(allowsDemoStudyData({ NODE_ENV: "test" })).toBe(true);
    expect(allowsDemoStudyData({})).toBe(true);
  });
});

describe("shouldRedirectLegacyMockPages", () => {
  it("redirects when opening release is on", () => {
    expect(shouldRedirectLegacyMockPages({ OPENING_RELEASE: "1", NODE_ENV: "development" })).toBe(true);
  });

  it("redirects in production even when OPENING_RELEASE is unset", () => {
    expect(shouldRedirectLegacyMockPages({ NODE_ENV: "production" })).toBe(true);
    expect(shouldRedirectLegacyMockPages({ NODE_ENV: "production", OPENING_RELEASE: "0" })).toBe(true);
  });

  it("does not redirect in non-production without opening release", () => {
    expect(shouldRedirectLegacyMockPages({ NODE_ENV: "development", OPENING_RELEASE: "0" })).toBe(false);
    expect(shouldRedirectLegacyMockPages({ NODE_ENV: "test" })).toBe(false);
  });
});

