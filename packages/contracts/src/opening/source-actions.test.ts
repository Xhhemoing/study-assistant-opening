import { describe, expect, it } from "vitest";
import { sourceActionInputSchema, sourceImpactSchema } from "./sources";

const sourceId = "11111111-1111-4111-8111-111111111111";
const courses = Array.from({ length: 1001 }, (_, index) => {
  const id = `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`;
  return { membershipId: id, courseId: id, title: `Course ${index + 1}`, archivedAt: null };
});

describe("source action confirmation", () => {
  it.each(["exclude", "delete"] as const)("accepts %s with all 1001 references from a valid impact preview", action => {
    const impact = sourceImpactSchema.parse({ sourceId, version: 2, aiExcluded: false, courses });
    const input = { action, expectedVersion: impact.version, expectedMembershipIds: impact.courses.map(course => course.membershipId) };
    expect(sourceActionInputSchema.parse(input)).toEqual(input);
  });

  it("still validates the UUID of every reference beyond the former limit", () => {
    const ids = courses.map(course => course.membershipId);
    ids[1000] = "not-a-uuid";
    for (const action of ["exclude", "delete"] as const) {
      const parsed = sourceActionInputSchema.safeParse({ action, expectedVersion: 2, expectedMembershipIds: ids });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["expectedMembershipIds", 1000], code: "invalid_format" }));
    }
  });
});
