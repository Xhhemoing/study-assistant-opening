import { describe, expect, it } from "vitest";
import { courseRouteConfirmSchema, courseRouteNextSchema, courseRequirementSchema, courseRequirementProgressSchema } from "./course-route";
const id = "00000000-0000-4000-8000-000000000001";
const progress = {
  requirement: { id, courseId: id, stableSkillId: id, knowledgeNodeId: null, requirementKey: "coverage", title: "Coverage",
    position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [],
    verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] },
    revision: 1, lifecycle: "active", origin: "confirmed", approvedAt: null },
  status: "unobserved", observationId: null, missingReasons: [], sourcesAvailable: true,
};
const counts = { total: 1, bound: 0, missing: 1, mismatch: 0, unknown: 0 };
const coverage = { total: 4, bound: 0, missing: 4, mismatch: 0, unknown: 0, factualSupport: "unverified",
  byRole: { teach: counts, prompt: counts, example: counts, answer_key: counts } };

describe("course citation coverage boundary", () => {
  it("accepts optional count-only coverage including an explicit empty population", () => {
    expect(courseRequirementProgressSchema.parse(progress).citationCoverage).toBeUndefined();
    expect(courseRequirementProgressSchema.parse({ ...progress, citationCoverage: coverage }).citationCoverage).toEqual(coverage);
    const zero = { total: 0, bound: 0, missing: 0, mismatch: 0, unknown: 0 };
    expect(courseRequirementProgressSchema.safeParse({ ...progress, citationCoverage: { ...zero, factualSupport: "unverified",
      byRole: { teach: zero, prompt: zero, example: zero, answer_key: zero } } }).success).toBe(true);
  });
  it("rejects inconsistent totals, invalid numbers, invented roles and factual verification", () => {
    const invalid = [
      { ...coverage, total: 5 }, { ...coverage, bound: 1, missing: 3 },
      { ...coverage, byRole: { ...coverage.byRole, prompt: { ...counts, missing: 0 } } },
      { ...coverage, byRole: { ...coverage.byRole, teach: { ...counts, total: 2, missing: 2 } } },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity].map(total => ({ ...coverage, total })),
      { ...coverage, factualSupport: "verified" }, { ...coverage, byRole: { ...coverage.byRole, meta: counts } },
      { ...coverage, byRole: { teach: counts, prompt: counts, example: counts } },
    ];
    for (const citationCoverage of invalid) expect(courseRequirementProgressSchema.safeParse({ ...progress, citationCoverage }).success).toBe(false);
  });
  it("rejects body, identity, answer and source data at every count boundary", () => {
    for (const privateField of ["text", "prompt", "answer", "id", "key", "answerBlockId", "refs"]) {
      for (const citationCoverage of [
        { ...coverage, [privateField]: "private" },
        { ...coverage, byRole: { ...coverage.byRole, answer_key: { ...counts, [privateField]: "private" } } },
      ]) expect(courseRequirementProgressSchema.safeParse({ ...progress, citationCoverage }).success).toBe(false);
    }
  });
});

describe("course route boundary", () => {
  it("projects only public supply counts and gaps, never private candidate bodies", () => {
    const schema = courseRequirementProgressSchema.shape.reservedSupply.unwrap();
    for (const status of ["ready", "missing", "unknown"] as const) expect(schema.parse({status,available:0,reason:null})).toEqual({status,available:0,reason:null});
    expect(schema.safeParse({status:"ready",available:1,reason:null,answer:"private"}).success).toBe(false);
    expect(schema.safeParse({status:"ready",available:-1,reason:null}).success).toBe(false);
  });
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
