import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingLearnerFocus } from "@aistudy/contracts";
import { type CourseEvidence } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../domain/src/opening/learning-summary-fixtures";
import { readOpeningTeachingCompilerFocus } from "./opening-teaching-focus";
import { readOpeningCourseEvidence } from "./opening-learning-read";
import { readCourseRouteObservations } from "./opening-course-route-read";

vi.mock("./opening-learning-read", () => ({ readOpeningCourseEvidence: vi.fn() }));
vi.mock("./opening-course-route-read", () => ({ readCourseRouteObservations: vi.fn() }));

const scope = { workspaceId: learningObservation.workspaceId, ownerUserId: "22222222-2222-4222-8222-222222222222" };
const activityId = "44444444-4444-4444-8444-444444444449";
const itemVersionId = "88888888-8888-4888-8888-888888888882";
const observationId = learningObservation.id;
const route = { goalId: "99999999-9999-4999-8999-999999999991", goalRevision: 1, requirementId: "99999999-9999-4999-8999-999999999992",
  requirementRevision: 2, stableSkillId: "99999999-9999-4999-8999-999999999993", requirementKey: "knowledge:node", action: "targeted_explain" as const };
const binding = { id: route.requirementId, revision: route.requirementRevision, stableSkillId: route.stableSkillId, requirementKey: route.requirementKey };
const part = { questionIdentityRefId: "99999999-9999-4999-8999-999999999994", partId: "part-b",
  identityRefId: "99999999-9999-4999-8999-999999999995", requirementKey: route.requirementKey };
const focus: TeachingLearnerFocus = { skillLabel: "Simplifying fractions", requirementKey: route.requirementKey, activityKind: "targeted_explain",
  reasonCode: "verified_incorrect", focusObservationId: observationId, recentAssistance: [], strategyVersion: "course-route-1" };
function evidence(): CourseEvidence {
  return { observations: [{ ...learningObservation, itemVersionId, requirementKey: "exam-skill:node", outcome: "incorrect" }],
    evidenceContexts: { [observationId]: {
      observation: { ...qualifiedInput.observation, requirementKey: "exam-skill:node", itemVersionId, outcome: "incorrect" },
      context: { ...qualifiedInput.context, version: { applicability: "exact", currentItemVersionId: itemVersionId },
        referenceCheck: { ...qualifiedInput.context.referenceCheck!, itemVersionId, outcome: "incorrect" } },
    } } };
}
function sqlFor(learnerFocus: unknown = focus, courseRoute: unknown = route, stem?: unknown) {
  const activity = [{ course_id: learningObservation.courseId, goal_json: { learnerFocus, courseRoute } }];
  const capturedStem = arguments.length >= 3 ? stem : "Submitted stem, not current mutable wording";
  return vi.fn().mockResolvedValueOnce(activity).mockResolvedValueOnce([{ stem_snapshot: capturedStem }]);
}
const read = (sql: ReturnType<typeof sqlFor>) => readOpeningTeachingCompilerFocus(sql as unknown as Sql, scope, activityId);
function project(patch: Record<string, unknown> = {}) {
  const current = { id: observationId, courseRequirement: binding, usableForCurrentVersion: "yes", verifiedCorrect: "no", ...patch };
  vi.mocked(readCourseRouteObservations).mockResolvedValue({ raw: [{ ...learningObservation }], projected: [current] } as never);
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence()); project(); });

describe("#274 requirement-qualified compiler focus never uses a label as authority", () => {
  it("attaches original stem and answer only through the exact route binding", async () => {
    const sql = sqlFor();
    expect(await read(sql)).toEqual({ learnerFocus: focus, focusAttempt: { question: "Submitted stem, not current mutable wording", answer: learningObservation.answer } });
    expect(readCourseRouteObservations).toHaveBeenCalledExactlyOnceWith(sql, scope, learningObservation.courseId, false);
    expect(sql.mock.calls[1]).toEqual(expect.arrayContaining([itemVersionId, learningObservation.problemId, scope.workspaceId, scope.ownerUserId]));
  });
  it.each([
    ["requirement revision advanced", { ...binding, revision: 3 }], ["requirement revision string", { ...binding, revision: "2" }],
    ["requirement revision missing", { ...binding, revision: undefined }], ["stable skill moved", { ...binding, stableSkillId: route.goalId }],
    ["requirement replaced", { ...binding, id: route.goalId }], ["requirement key changed", { ...binding, requirementKey: "other" }],
    ["binding absent", undefined], ["binding null", null],
  ])("rejects %s without reading question snapshots", async (_name, courseRequirement) => {
    project({ courseRequirement }); const sql = sqlFor();
    expect(await read(sql)).toEqual({}); expect(sql).toHaveBeenCalledTimes(1);
  });
  it("ambiguous duplicate projection is rejected rather than taking the first row", async () => {
    const current = { id: observationId, courseRequirement: binding };
    vi.mocked(readCourseRouteObservations).mockResolvedValue({ raw: [], projected: [current, current] } as never);
    const sql = sqlFor(); expect(await read(sql)).toEqual({}); expect(sql).toHaveBeenCalledTimes(1);
  });
  it.each([{ projected: [] }, { projected: [{ id: "other-head", courseRequirement: binding }] }])("retracted/replaced head is absent from effective projection %#", async ({ projected }) => {
    vi.mocked(readCourseRouteObservations).mockResolvedValue({ raw: [], projected } as never);
    expect(await read(sqlFor())).toEqual({});
  });
  it.each([null, {}, { ...route, requirementRevision: "2" }, { ...route, stableSkillId: null }, { ...route, requirementKey: "" }])("malformed route context %# cannot authorize label/key fallback", async context => {
      expect(await read(sqlFor(focus, context))).toEqual({}); expect(readCourseRouteObservations).not.toHaveBeenCalled();
    });
  it("the strategy marker itself is not a grant for non-route activities", async () => {
    expect(await read(sqlFor({ ...focus, strategyVersion: "adaptive-1" }))).toEqual({});
    expect(readCourseRouteObservations).not.toHaveBeenCalled();
  });
  it("route projection failure propagates; it is never converted into fallback teaching", async () => {
    vi.mocked(readCourseRouteObservations).mockRejectedValueOnce(new Error("projection unavailable"));
    await expect(read(sqlFor())).rejects.toThrow("projection unavailable");
  });
  it.each([null, undefined, "", 0])("missing stem snapshot %j does not fabricate a current question", async stem => {
    const result = await read(sqlFor(focus, route, stem));
    expect(result).toEqual({ learnerFocus: focus }); expect(result).not.toHaveProperty("focusAttempt");
  });
  it("bounded stem and answer are taken from the focused immutable version only", async () => {
    const facts = evidence(); facts.observations[0]!.answer = "a".repeat(5000);
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const result = await read(sqlFor(focus, route, "s".repeat(3000)));
    expect(result.focusAttempt).toEqual({ question: "s".repeat(2000), answer: "a".repeat(4000) });
  });
});

describe("private exam-part focus must be rebound on every compiler read", () => {
  const stored = { ...focus, examPartFocus: part };
  it("part-specific current negative verdict may focus a whole-question correct raw answer", async () => {
    const facts = evidence(), captured = facts.evidenceContexts[observationId]!;
    facts.observations[0]!.outcome = "correct";
    captured.observation.outcome = "correct"; captured.context.referenceCheck = { ...captured.context.referenceCheck!, outcome: "correct" };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    project({ examPartFocus: part, requirementKey: route.requirementKey });
    expect(await read(sqlFor(stored))).toMatchObject({ learnerFocus: stored, focusAttempt: { answer: learningObservation.answer } });
  });
  it.each([
    ["question identity", { ...part, questionIdentityRefId: route.goalId }], ["part id", { ...part, partId: "part-a" }],
    ["private part identity", { ...part, identityRefId: route.goalId }], ["requirement key", { ...part, requirementKey: "other" }],
    ["missing", undefined],
  ])("changed %s blocks part-to-whole upgrade", async (_name, examPartFocus) => {
    project({ examPartFocus, requirementKey: route.requirementKey });
    const sql = sqlFor(stored);
    expect(await read(sql)).toEqual({});
    expect(sql).toHaveBeenCalledTimes(1);
  });
  it.each(["yes", "unknown", undefined] as const)("part verdict %s is not a current verified failure", async verifiedCorrect => {
    project({ examPartFocus: part, requirementKey: route.requirementKey, verifiedCorrect });
    expect(await read(sqlFor(stored))).toEqual({});
  });
  it.each(["no", "unknown", undefined] as const)("part applicability %s is not current", async usableForCurrentVersion => {
    project({ examPartFocus: part, requirementKey: route.requirementKey, usableForCurrentVersion });
    expect(await read(sqlFor(stored))).toEqual({});
  });
  it("a child revision cannot be relabelled as the immutable raw whole question", async () => {
    project({ examPartFocus: part, requirementKey: route.requirementKey });
    vi.mocked(readCourseRouteObservations).mockResolvedValue({ raw: [{ ...learningObservation, rootObservationId: route.goalId }],
      projected: [{ id: observationId, courseRequirement: binding, examPartFocus: part, requirementKey: route.requirementKey,
        usableForCurrentVersion: "yes", verifiedCorrect: "no" }] } as never);
    expect(await read(sqlFor(stored))).toEqual({});
  });
  it("missing raw original cannot be patched from the projected part", async () => {
    vi.mocked(readCourseRouteObservations).mockResolvedValue({ raw: [], projected: [{ id: observationId, courseRequirement: binding,
      examPartFocus: part, requirementKey: route.requirementKey, usableForCurrentVersion: "yes", verifiedCorrect: "no" }] } as never);
    expect(await read(sqlFor(stored))).toEqual({});
  });
  it("private part cannot authorize a stored focus lacking its private part reference", async () => {
    project({ examPartFocus: part, requirementKey: route.requirementKey });
    expect(await read(sqlFor(focus))).toEqual({});
  });
  it("non-route marker cannot reuse a private exam-part grant", async () => {
    project({ examPartFocus: part, requirementKey: route.requirementKey });
    expect(await read(sqlFor({ ...stored, strategyVersion: "adaptive-1" }))).toEqual({});
    expect(readCourseRouteObservations).not.toHaveBeenCalled();
  });
});

describe("persisted focus input is parsed before any evidence access", () => {
  it.each([null, {}, [], { ...focus, examPartFocus: null }, { ...focus, focusObservationId: "bad" },
    { ...focus, reservedAnswer: "PRIVATE_SENTINEL" }, { ...focus, recentErrors: null }, { ...focus, requirementKey: 3 }])("rejects malformed persisted focus %#", async stored => {
      expect(await read(sqlFor(stored))).toEqual({});
      expect(readOpeningCourseEvidence).not.toHaveBeenCalled(); expect(readCourseRouteObservations).not.toHaveBeenCalled();
    });
});
