import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, openingAdaptivePrefsPatchSchema, openingAdaptivePrefsSchema } from "./adaptive-planning";
const courseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const grant = { enabled: true, dailyMinutes: 45, revision: 1,
  confirmedAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z", expiresOn: null };

describe("explicit course span tutor authorization", () => {
  it("retains a course grant without changing copilot or enabling account preferences", () => {
    const result = openingAdaptivePrefsSchema.parse({ ...DEFAULT_OPENING_ADAPTIVE_PREFS, spanTutorGrants: { [courseId]: grant } });
    expect(result).toEqual({ ...DEFAULT_OPENING_ADAPTIVE_PREFS, spanTutorGrants: { [courseId]: grant } });
  });
  it("accepts an explicit versioned course choice with a visible budget", () => {
    const choice = { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } };
    expect(openingAdaptivePrefsPatchSchema.parse(choice)).toEqual(choice);
  });
  it.each([
    { enabled: true, dailyMinutes: 30, expiresOn: null },
    { enabled: true, dailyMinutes: 0, expiresOn: null, expectedRevision: 0 },
    { enabled: true, dailyMinutes: 30, expiresOn: "2026-02-30", expectedRevision: 0 },
    { enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0, confirmedAt: grant.confirmedAt },
  ])("rejects missing revision, invalid budget/date or forged confirmation %j", values => {
    expect(openingAdaptivePrefsPatchSchema.safeParse({ spanTutorGrant: { courseId, ...values } }).success).toBe(false);
  });
  it("leaves existing preferences and goal writes byte-shape compatible", () => {
    expect(openingAdaptivePrefsSchema.parse(DEFAULT_OPENING_ADAPTIVE_PREFS)).toEqual(DEFAULT_OPENING_ADAPTIVE_PREFS);
    expect(openingAdaptivePrefsPatchSchema.parse({ autonomy: "manual" })).toEqual({ autonomy: "manual" });
  });
});
it("canonicalizes a UUID alias before selecting the course grant revision", () => {
  const input = { spanTutorGrant: { courseId: courseId.toUpperCase(), enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } };
  expect(openingAdaptivePrefsPatchSchema.parse(input).spanTutorGrant?.courseId).toBe(courseId);
});
