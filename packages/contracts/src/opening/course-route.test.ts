import { describe, expect, it } from "vitest";
import { courseRouteConfirmSchema, courseRouteNextSchema, courseRequirementSchema } from "./course-route";
const id = "00000000-0000-4000-8000-000000000001";
describe("course route boundary", () => {
  it("keeps stable skill and requirement identities separate and permits explicit material gaps", () => {
    expect(courseRequirementSchema.parse({ id, courseId:id, stableSkillId:id, knowledgeNodeId:null,
      requirementKey:"algebra.eigenvectors", title:"特征向量", position:0, mandatory:true, goalIds:[], prerequisiteIds:[],
      sourceRefs:[], verification:{kind:"unavailable",status:"missing",exerciseKeys:[],rubric:null,missingReasons:["未提供习题"]},
      revision:1,lifecycle:"active",origin:"confirmed",approvedAt:null }).verification.status).toBe("missing");
  });
  it("rejects duplicate requirement identities and a next without a pinned activity version", () => {
    expect(courseRouteConfirmSchema.safeParse({ expectedRevisions:[],requirements:[],confirmScope:true }).success).toBe(false);
    expect(courseRouteNextSchema.safeParse({goalId:id,expectedGoalRevision:1,activityId:id,observationId:null,clientKey:"same-next"}).success).toBe(false);
  });
});
