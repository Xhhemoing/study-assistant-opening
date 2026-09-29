import { describe, expect, it } from "vitest";
import { courseRestrictionDraft, courseRestrictionUpdate, filterCourses } from "./course-state-model";
const active = { id: "active", title: "代数", slug: "algebra", description: "", createdAt: "2026-09-29", updatedAt: "2026-09-29", archivedAt: null };
const archived = { ...active, id: "archived", title: "旧代数", archivedAt: "2026-09-29T00:00:00Z" };
describe("course state model", () => {
  it("keeps inherited settings distinct from a course restriction", () => {
    expect(courseRestrictionDraft({ retestSuggestionsEnabled: false })).toEqual({ assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: true });
    expect(courseRestrictionUpdate({ assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: true })).toEqual({ retestSuggestionsEnabled: false });
  });
  it("keeps archived courses discoverable without mixing them into the active list", () => {
    expect(filterCourses([active, archived], "", "active")).toEqual([active]);
    expect(filterCourses([active, archived], "代数", "archived")).toEqual([archived]);
    expect(filterCourses([active, archived], "不匹配", "archived")).toEqual([]);
  });
});
