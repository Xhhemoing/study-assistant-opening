import { describe, expect, it } from "vitest";
import { resolveSpanTutorAuthorization } from "./opening-span-tutor-grant";
const grant = { enabled: true, dailyMinutes: 45, revision: 2, confirmedAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z", expiresOn: null };
const preferences = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false, autoGradeOnSave: true };
const base = { grant, preferences, archived: false, invalidPreferences: false, timeZone: "America/Los_Angeles", goalTargetDate: null, now: new Date("2026-10-28T01:00:00.000Z") };
describe("span tutor course grant admission", () => {
  it("requires explicit course authorization, separately from account switches", () => {
    expect(resolveSpanTutorAuthorization(base)).toMatchObject({ authorized: true, localDate: "2026-10-27", grant });
    expect(resolveSpanTutorAuthorization({ ...base, grant: null })).toMatchObject({ authorized: false, reason: "not_enabled" });
  });
  it("account off, archive and unreadable preferences block automatic writes", () => {
    expect(resolveSpanTutorAuthorization({ ...base, preferences: { ...preferences, assessmentEnabled: false } }).reason).toBe("account_disabled");
    expect(resolveSpanTutorAuthorization({ ...base, preferences: { ...preferences, retestSuggestionsEnabled: false } }).reason).toBe("account_disabled");
    expect(resolveSpanTutorAuthorization({ ...base, archived: true }).reason).toBe("course_archived");
    expect(resolveSpanTutorAuthorization({ ...base, invalidPreferences: true }).reason).toBe("invalid_preferences");
  });
  it("uses the workspace date for inclusive grant and goal end dates", () => {
    expect(resolveSpanTutorAuthorization({ ...base, grant: { ...grant, expiresOn: "2026-10-27" } }).authorized).toBe(true);
    expect(resolveSpanTutorAuthorization({ ...base, grant: { ...grant, expiresOn: "2026-10-26" } }).reason).toBe("expired");
    expect(resolveSpanTutorAuthorization({ ...base, goalTargetDate: "2026-10-26" }).reason).toBe("goal_ended");
  });
});
