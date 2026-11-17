import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { assertPublicTeachingActivityIntent, readOpeningSpanCourseBinding } from "./opening-span-course-binding";
import { createOpeningTeachingActivitiesRepository } from "./opening-teaching-activities";

const input = { clientKey: "ordinary-topic-1", intentKind: "topic" as const, intentSummary: "linear algebra", createIntent: {} };
const scope = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" };
describe("course span authority boundary", () => {
  it.each(["spanCourseBinding", "spanPrerequisiteRepair", "courseRoute", "spanRepair", "tutorNextAction", "tutorBudget", "learningBudget", "reservedStart"])("rejects public repository goal authority %s before a transaction", async key => {
    const begin = vi.fn();
    await expect(createOpeningTeachingActivitiesRepository({ begin } as unknown as Sql).create(scope,
      { ...input, goalJson: { [key]: null } })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(begin).not.toHaveBeenCalled();
  });
  it.each(["span-lesson:fake", "span-tutor-decision:fake", "course-route-start:fake", "span-prerequisite:fake", "course-span-start:fake"])("rejects reserved operation %s", clientKey => {
    expect(() => assertPublicTeachingActivityIntent({ ...input, clientKey })).toThrow();
    expect(() => assertPublicTeachingActivityIntent({ ...input, createIntent: { operationId: clientKey } })).toThrow();
  });
  it("preserves ordinary typed task and learner focus creation", () => {
    expect(() => assertPublicTeachingActivityIntent({ ...input, createIntent: { source: "task", taskId: scope.workspaceId },
      goalJson: { learnerFocus: { requirementKey: "span:linear-combination:v1" }, wantsFullExplanation: true } })).not.toThrow();
  });
  it("does not grant binding from a protocol or client key", async () => {
    const db = vi.fn().mockResolvedValue([{ id: scope.workspaceId, create_intent: { protocol: "span-lesson-v1" }, goal_json: {}, client_key: "span-lesson:fake" }]) as unknown as Sql;
    expect(await readOpeningSpanCourseBinding(db, scope, scope.workspaceId)).toBeNull();
  });
  it.each([{ spanCourseBinding: { version: 1 } }, {}])("rejects incomplete or deauthorized course writer identity %j", async goal_json => {
    const db = vi.fn().mockResolvedValue([{ id: scope.workspaceId, create_intent: { protocol: "span-lesson-v1", courseSpanRequest: {} }, goal_json }]) as unknown as Sql;
    await expect(readOpeningSpanCourseBinding(db, scope, scope.workspaceId)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "SPAN_COURSE_BINDING_CHANGED" });
  });
  it("propagates dependency/lock failures instead of calling them unbound", async () => {
    const failure = Object.assign(new Error("lock unavailable"), { code: "55P03" });
    const db = vi.fn().mockRejectedValue(failure) as unknown as Sql;
    await expect(readOpeningSpanCourseBinding(db, scope, scope.workspaceId)).rejects.toBe(failure);
  });
});
