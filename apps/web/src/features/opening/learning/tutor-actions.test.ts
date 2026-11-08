import { describe, expect, it, vi } from "vitest";
import { toSnapshotEvidence, type CourseEvidence } from "@aistudy/domain";
import type { LearningObservation } from "@aistudy/contracts";
import {
  aggregateHighestExposure,
  buildTutorActions,
  listTutorActionsForCourse,
  parseTutorActionsSearchParams,
  type TutorActionObservationDeps,
} from "./tutor-actions";

const COURSE = "11111111-1111-4111-8111-111111111111";
const OTHER_COURSE = "33333333-3333-4333-8333-333333333333";
const SESSION = "22222222-2222-4222-8222-222222222222";
const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OBS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LINK = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const scope = { workspaceId: "workspace-1", ownerUserId: "user-1" };
const emptyEvidence = (): CourseEvidence => ({ observations: [], evidenceContexts: {} });

type EvidenceOptions = {
  id?: string; at?: number; assistance?: "independent" | "hinted" | "revealed";
  outcome?: "correct" | "incorrect"; unknown?: boolean;
  applicability?: "exact" | "changed_needs_check" | "unavailable" | "privacy_excluded";
  skillLabel?: string; courseId?: string;
};

/** Server-scored captured attempt, with real identity, timing, help and version inputs. */
function evidenceRow(options: EvidenceOptions = {}): CourseEvidence {
  const id = options.id ?? OBS, at = options.at ?? Date.parse("2026-11-01T10:00:00Z");
  const assistance = options.assistance ?? "independent", outcome = options.outcome ?? "correct";
  const row: LearningObservation = {
    id, workspaceId: scope.workspaceId, sessionId: SESSION, courseId: options.courseId ?? COURSE,
    skillLabel: options.skillLabel ?? "chain rule", sourceIds: [], sourceTurnIds: [],
    answer: "[2,3]", outcome, assistance, clientKey: `attempt-${id}`,
    occurredAt: new Date(at).toISOString(), submittedAt: new Date(at).toISOString(),
    verdictSource: options.unknown ? "self_report" : "deterministic", evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    problemId: `problem-${id}`, itemVersionId: `item-${id}`, attemptId: `attempt-${id}`,
  };
  return { observations: [row], evidenceContexts: { [id]: {
    observation: { observationId: id, courseId: row.courseId, requirementKey: "chain-rule",
      attemptId: row.attemptId, problemId: row.problemId, itemVersionId: row.itemVersionId,
      startedAt: at - 60_000, submittedAt: at, assistance, outcome, verdictSource: row.verdictSource },
    context: {
      helpHistory: { complete: true, exposures: assistance === "independent" ? [] : [{
        attemptId: row.attemptId, problemId: row.problemId, delivered: true,
        deliveredAt: at - 30_000, level: assistance, kind: assistance === "hinted" ? "hint" : "solution",
      }] },
      version: { applicability: options.applicability ?? "exact", currentItemVersionId: row.itemVersionId },
      serverEvaluation: { observationId: id, attemptId: row.attemptId!, problemId: row.problemId!, itemVersionId: row.itemVersionId!,
        requirementKey: "chain-rule", evaluatorVersion: "matrix-exact-v1", specVersion: "matrix-arithmetic-v1",
        decision: outcome, outcome, reasonCodes: ["matrix_compared"], evaluatedAt: row.occurredAt },
    },
  } } };
}
function combine(...items: CourseEvidence[]): CourseEvidence {
  return { observations: items.flatMap(item => item.observations), evidenceContexts: Object.assign({}, ...items.map(item => item.evidenceContexts)) };
}
function createDeps(overrides: Partial<TutorActionObservationDeps> = {}): TutorActionObservationDeps {
  return {
    assertOwnedCourse: vi.fn(async () => {}), readCourseEvidence: vi.fn(async () => emptyEvidence()),
    getSession: vi.fn(async () => null), listDeliveredExposures: vi.fn(async () => []), listDueRetests: vi.fn(async () => []),
    flagsForNode: vi.fn(async () => ({ hasAssistance: false, hasCheckedIndependent: false, evidenceIds: [], observationIds: [] })),
    ...overrides,
  };
}
function recommend(evidence: CourseEvidence, retestDue = false) {
  return buildTutorActions({ skillLabel: "chain rule", currentPage: 2,
    observations: toSnapshotEvidence(evidence, new Date()).observations, retestDue })[0]!;
}
function list(deps: TutorActionObservationDeps, query: Record<string, string> = {}, courseId = COURSE) {
  return listTutorActionsForCourse({} as never, scope, courseId, new URLSearchParams({ skillLabel: "chain rule", ...query }), deps);
}
const interventionPrefs = {
  proactivity: "balanced" as const, depth: "hint_then_offer" as const, quietMode: false,
  nodes: { allowOnTeach: true, allowOnPrompt: true, allowOnLowEvidence: false },
};
function intervention(effective = interventionPrefs) {
  return { settings: interventionPrefs, courseOverride: null, sessionOverride: null, effective, saved: true, invalidStoredSettings: false };
}

describe("tutor-actions query boundary", () => {
  it("accepts context fields without treating page or source as performance", () => {
    const parsed = parseTutorActionsSearchParams(COURSE, new URLSearchParams({
      skillLabel: "chain rule", sessionId: SESSION, currentPage: "5", nodeId: NODE, sourceIds: LINK,
    }));
    expect(parsed).toMatchObject({ courseId: COURSE, query: { sessionId: SESSION, currentPage: 5, nodeId: NODE }, sourceIds: [LINK] });
  });
  it.each(["sessionExposures", "assistedSuccess", "assistedSuccessOnCurrentItem", "hasCheckedIndependent", "hasAssistance", "retestDue", "observationIds", "evidenceIds", "verifiedCorrect"])("rejects client supplied %s", key => {
    expect(() => parseTutorActionsSearchParams(COURSE, new URLSearchParams({ skillLabel: "chain rule", [key]: "true" }))).toThrow();
  });
});

describe("canonical tutor action mapping (pure seam)", () => {
  it("maps no evidence and unknown-only evidence to clarify, even with a selected page", () => {
    expect(recommend(emptyEvidence())).toMatchObject({ kind: "clarify", currentPage: 2, evidenceIds: [] });
    expect(recommend(evidenceRow({ unknown: true, assistance: "hinted" })).kind).toBe("clarify");
  });
  it("maps a verified error to guided", () => {
    expect(recommend(evidenceRow({ outcome: "incorrect" }))).toMatchObject({ kind: "guided", evidenceIds: [OBS] });
  });
  it("maps repeated assisted verified-step errors to worked_example", () => {
    const evidence = combine(evidenceRow({ id: "older", at: 100_000, assistance: "hinted", outcome: "incorrect" }),
      evidenceRow({ id: "newer", at: 200_000, assistance: "revealed", outcome: "incorrect" }));
    const observations = toSnapshotEvidence(evidence, new Date()).observations.map(row => ({ ...row,
      errors: [{ observationId: row.id, label: "dimensions", feedback: "Check dimensions", source: "verified_steps" as const }],
    }));
    expect(buildTutorActions({ skillLabel: "chain rule", observations, retestDue: false })[0]!.kind).toBe("worked_example");
  });
  it.each([0, 1, 2])("D5: latest verified assisted success after %i independent successes stays reduced-help", count => {
    const earlier = Array.from({ length: count }, (_, index) => evidenceRow({ id: `independent-${index}`, at: 100_000 + index * 1000 }));
    const action = recommend(combine(...earlier, evidenceRow({ at: 200_000, assistance: "hinted" })));
    expect(action).toMatchObject({ kind: "independent_variant", problemRef: "variant:1" });
    expect(action).not.toHaveProperty("masteryPercent");
  });
  it("maps independent transfer to a variant, and only a server-due retest to delayed_retest", () => {
    expect(recommend(evidenceRow()).kind).toBe("independent_variant");
    expect(recommend(emptyEvidence(), true).kind).toBe("delayed_retest");
    expect(recommend(evidenceRow({ assistance: "revealed" }), true).kind).toBe("delayed_retest");
  });
  it.each(["changed_needs_check", "unavailable", "privacy_excluded"] as const)("does not use %s evidence", applicability => {
    expect(recommend(evidenceRow({ applicability }))).toMatchObject({ kind: "clarify", evidenceIds: [] });
  });
});

describe("listTutorActionsForCourse canonical scope and gates", () => {
  it("keeps skill-label scope on the non-node path, without adding a requirement filter", async () => {
    const own = evidenceRow(), unrelated = evidenceRow({ id: "other-skill", at: Date.now(), skillLabel: "other skill", outcome: "incorrect" });
    const deps = createDeps({ readCourseEvidence: vi.fn(async () => combine(own, unrelated)) });
    expect((await list(deps))[0]).toMatchObject({ kind: "independent_variant", evidenceIds: [OBS] });
    expect(deps.readCourseEvidence).toHaveBeenCalledWith(scope, COURSE);
    expect(deps.flagsForNode).not.toHaveBeenCalled();
  });
  it("intersects distinct canonical observation IDs, not link IDs or boolean flags", async () => {
    const deps = createDeps({ readCourseEvidence: vi.fn(async () => combine(evidenceRow({ assistance: "hinted" }),
      evidenceRow({ id: "other-node", at: Date.now(), outcome: "incorrect" }))),
      flagsForNode: vi.fn(async () => ({ hasAssistance: false, hasCheckedIndependent: false, evidenceIds: [LINK], observationIds: [OBS, OBS] })),
    });
    expect((await list(deps, { nodeId: NODE }))[0]).toMatchObject({ kind: "independent_variant", nodeId: NODE, evidenceIds: [LINK] });
    expect(deps.flagsForNode).toHaveBeenCalledWith(scope, COURSE, NODE);
  });
  it("cannot invent observations from flags or a retracted/missing head", async () => {
    const deps = createDeps({ flagsForNode: vi.fn(async () => ({ hasAssistance: true, hasCheckedIndependent: true, evidenceIds: [LINK], observationIds: [OBS] })) });
    expect((await list(deps, { nodeId: NODE }))[0]!.kind).toBe("clarify");
  });
  it("does not reuse evidence from another course or node", async () => {
    const deps = createDeps({ readCourseEvidence: vi.fn(async (_scope, courseId) => courseId === COURSE ? evidenceRow() : emptyEvidence()),
      flagsForNode: vi.fn(async () => ({ hasAssistance: true, hasCheckedIndependent: true, evidenceIds: [LINK], observationIds: [OBS] })),
    });
    expect((await list(deps, { nodeId: NODE }))[0]!.kind).toBe("independent_variant");
    expect((await list(deps, { nodeId: NODE }, OTHER_COURSE))[0]!.kind).toBe("clarify");
    deps.flagsForNode = vi.fn(async () => ({ hasAssistance: true, hasCheckedIndependent: true, evidenceIds: [], observationIds: [] }));
    expect((await list(deps, { nodeId: NODE }))[0]!.kind).toBe("clarify");
  });
  it.each(["hinted", "revealed"] as const)("does not turn delivered %s into assisted success without a trusted verdict", async level => {
    const deps = createDeps({ getSession: vi.fn(async () => ({ id: SESSION, courseId: COURSE })),
      listDeliveredExposures: vi.fn(async () => [level]), readCourseEvidence: vi.fn(async () => evidenceRow({ unknown: true, assistance: level })),
    });
    expect((await list(deps, { sessionId: SESSION, currentPage: "2", sourceIds: LINK }))[0]!.kind).toBe("clarify");
    expect(deps.listDeliveredExposures).toHaveBeenCalledWith(scope, SESSION);
  });
  it("uses due retests only from the existing server course/time/skill scope", async () => {
    const deps = createDeps({ listDueRetests: vi.fn(async () => [{ skillLabel: "chain rule" }]) });
    expect((await list(deps))[0]!.kind).toBe("delayed_retest");
    expect(deps.listDueRetests).toHaveBeenCalledWith(scope, COURSE, expect.any(String));
    deps.listDueRetests = vi.fn(async () => [{ skillLabel: "other skill" }]);
    expect((await list(deps))[0]!.kind).toBe("clarify");
  });
  it("preserves course ownership before reading evidence", async () => {
    const deps = createDeps({ assertOwnedCourse: vi.fn(async () => { throw Object.assign(new Error("not found"), { code: "NOT_FOUND" }); }) });
    await expect(list(deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.readCourseEvidence).not.toHaveBeenCalled();
  });
  it.each([null, { id: SESSION, courseId: OTHER_COURSE }])("rejects missing/foreign sessions before evidence reads", async session => {
    const deps = createDeps({ getSession: vi.fn(async () => session) });
    await expect(list(deps, { sessionId: SESSION })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(deps.readCourseEvidence).not.toHaveBeenCalled();
    expect(deps.listDeliveredExposures).not.toHaveBeenCalled();
  });
  it.each(["readCourseEvidence", "flagsForNode"] as const)("propagates %s failure instead of treating it as empty", async key => {
    const failure = new Error("evidence unavailable");
    const deps = createDeps({ [key]: vi.fn(async () => { throw failure; }) });
    await expect(list(deps, { nodeId: NODE })).rejects.toBe(failure);
  });
  it("keeps intervention quiet, node and low-evidence gates", async () => {
    const deps = createDeps({ readCourseEvidence: vi.fn(async () => evidenceRow()), getIntervention: vi.fn(async () => intervention()) });
    expect(await list(deps)).toHaveLength(1);
    expect(deps.getIntervention).toHaveBeenCalledWith(scope, COURSE, null);
    deps.getIntervention = vi.fn(async () => intervention({ ...interventionPrefs, quietMode: true }));
    expect(await list(deps)).toEqual([]);
    deps.getIntervention = vi.fn(async () => intervention());
    deps.readCourseEvidence = vi.fn(async () => emptyEvidence());
    expect(await list(deps, { nodeId: NODE })).toEqual([]);
    deps.getIntervention = vi.fn(async () => intervention({ ...interventionPrefs, nodes: { ...interventionPrefs.nodes, allowOnLowEvidence: true } }));
    expect(await list(deps, { nodeId: NODE })).toHaveLength(1);
    deps.getIntervention = vi.fn(async () => intervention({ ...interventionPrefs, nodes: { ...interventionPrefs.nodes, allowOnPrompt: false } }));
    expect(await list(deps, { nodeId: NODE })).toEqual([]);
  });
});

describe("aggregateHighestExposure (gate context only)", () => {
  it("does not let a hint mask a reveal", () => {
    expect(aggregateHighestExposure(["revealed", "hinted"])).toEqual(["revealed"]);
    expect(aggregateHighestExposure(["hinted", "hinted"])).toEqual(["hinted"]);
    expect(aggregateHighestExposure([])).toEqual([]);
  });
});
