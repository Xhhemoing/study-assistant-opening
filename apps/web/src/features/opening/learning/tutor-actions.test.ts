import { describe, expect, it, vi } from "vitest";
import {
  aggregateHighestExposure,
  buildTutorActions,
  createSkillEvidenceDepsFromDatabase,
  listTutorActionsForCourse,
  parseTutorActionsSearchParams,
  type TutorActionObservationDeps,
} from "./tutor-actions";

const COURSE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OBS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const scope = { workspaceId: "workspace-1", ownerUserId: "user-1" };

function createDeps(
  overrides: Partial<TutorActionObservationDeps> = {},
): TutorActionObservationDeps {
  return {
    assertOwnedCourse: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listDeliveredExposures: vi.fn(async () => []),
    listDueRetests: vi.fn(async () => []),
    listSkillEvidenceForNode: vi.fn(async () => []),
    hasAssistanceForNode: vi.fn(async () => false),
    hasCheckedIndependentForNode: vi.fn(async () => false),
    ...overrides,
  };
}

describe("K02a tutor-actions query", () => {
  it("accepts server-observed query fields only", () => {
    const parsed = parseTutorActionsSearchParams(
      COURSE,
      new URLSearchParams({
        skillLabel: "derivatives",
        sessionId: SESSION,
        currentPage: "5",
        nodeId: NODE,
      }),
    );
    expect(parsed.courseId).toBe(COURSE);
    expect(parsed.query.sessionId).toBe(SESSION);
    expect(parsed.query.currentPage).toBe(5);
    expect(parsed.query.nodeId).toBe(NODE);
    expect(parsed.sourceIds).toEqual([]);
  });

  it("rejects client-supplied observation fields", () => {
    expect(
      () =>
        parseTutorActionsSearchParams(
          COURSE,
          new URLSearchParams({
            skillLabel: "derivatives",
            sessionExposures: "revealed",
          }),
        ),
    ).toThrow(/self-report|Unrecognized|sessionExposures/i);
    expect(
      () =>
        parseTutorActionsSearchParams(
          COURSE,
          new URLSearchParams({ skillLabel: "derivatives", assistedSuccess: "1" }),
        ),
    ).toThrow();
    expect(
      () =>
        parseTutorActionsSearchParams(
          COURSE,
          new URLSearchParams({
            skillLabel: "derivatives",
            hasCheckedIndependent: "true",
          }),
        ),
    ).toThrow(/self-report|hasCheckedIndependent/i);
    expect(
      () =>
        parseTutorActionsSearchParams(
          COURSE,
          new URLSearchParams({
            skillLabel: "derivatives",
            hasAssistance: "true",
          }),
        ),
    ).toThrow(/self-report|hasAssistance/i);
  });
});

describe("K02a tutor action recommendation", () => {
  it("starts guided when a material page is selected", () => {
    const actions = buildTutorActions({
      skillLabel: "derivatives",
      currentPage: 5,
      nodeId: null,
      sourceIds: [],
      sessionExposures: [],
      retestDue: false,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("guided");
    expect(actions[0]!.nodeId).toBeNull();
    expect(actions[0]).not.toHaveProperty("masteryPercent");
  });

  it("clarifies when no material page is selected", () => {
    const actions = buildTutorActions({
      skillLabel: "derivatives",
      currentPage: null,
      nodeId: null,
      sourceIds: [],
      sessionExposures: [],
      retestDue: false,
    });
    expect(actions[0]!.kind).toBe("clarify");
  });

  it("moves to an independent variant after a full reveal", () => {
    const actions = buildTutorActions({
      skillLabel: "chain rule",
      currentPage: 2,
      nodeId: null,
      sourceIds: [],
      sessionExposures: ["revealed"],
      retestDue: false,
    });
    expect(actions[0]!.kind).toBe("independent_variant");
  });

  it("offers a worked example after a hint", () => {
    const actions = buildTutorActions({
      skillLabel: "chain rule",
      currentPage: 2,
      nodeId: null,
      sourceIds: [],
      sessionExposures: ["hinted"],
      retestDue: false,
    });
    expect(actions[0]!.kind).toBe("worked_example");
  });

  it("prioritizes a due retest", () => {
    const actions = buildTutorActions({
      skillLabel: "chain rule",
      currentPage: 2,
      nodeId: null,
      sourceIds: [],
      sessionExposures: ["revealed"],
      retestDue: true,
    });
    expect(actions[0]!.kind).toBe("delayed_retest");
  });
});

describe("K02 nodeId adaptive recommendation", () => {
  it("asks for independent transfer after assisted success on a node", () => {
    const actions = buildTutorActions({
      skillLabel: "chain rule",
      currentPage: 2,
      nodeId: NODE,
      sourceIds: [],
      sessionExposures: [],
      retestDue: false,
      hasAssistance: true,
      hasCheckedIndependent: false,
      evidenceIds: [OBS],
    });
    expect(actions[0]!.kind).toBe("independent_variant");
    expect(actions[0]!.nodeId).toBe(NODE);
    expect(actions[0]!.evidenceIds).toEqual([OBS]);
    expect(actions[0]).not.toHaveProperty("masteryPercent");
  });

  it("clarifies when the node has no reliable evidence", () => {
    const actions = buildTutorActions({
      skillLabel: "chain rule",
      currentPage: null,
      nodeId: NODE,
      sourceIds: [],
      sessionExposures: [],
      retestDue: false,
      hasAssistance: false,
      hasCheckedIndependent: false,
    });
    expect(actions[0]!.kind).toBe("clarify");
  });
});

describe("aggregateHighestExposure", () => {
  it("does not let a hint mask a reveal", () => {
    expect(aggregateHighestExposure(["revealed", "hinted"])).toEqual([
      "revealed",
    ]);
    expect(aggregateHighestExposure(["hinted", "hinted"])).toEqual(["hinted"]);
    expect(aggregateHighestExposure([])).toEqual([]);
  });
});

describe("createSkillEvidenceDepsFromDatabase", () => {
  it("stubs empty flags when the SkillEvidence repository is not landed", () => {
    const deps = createSkillEvidenceDepsFromDatabase({} as never, {});
    expect(deps).toBeTruthy();
  });

  it("binds to createOpeningSkillEvidenceRepository when present", async () => {
    const listByNode = vi.fn(async () => [
      { nodeId: NODE, observationId: OBS, dimension: "procedure" as const },
    ]);
    const flagsForNode = vi.fn(async () => ({
      nodeId: NODE,
      hasAssistance: true,
      hasCheckedIndependent: false,
      evidenceIds: [OBS],
    }));
    const deps = createSkillEvidenceDepsFromDatabase({} as never, {
      createOpeningSkillEvidenceRepository: () => ({
        listByNode,
        flagsForNode,
      }),
    });
    await expect(deps.listSkillEvidenceForNode(scope, NODE)).resolves.toEqual([
      { nodeId: NODE, observationId: OBS, dimension: "procedure" },
    ]);
    await expect(deps.hasAssistanceForNode(scope, NODE)).resolves.toBe(true);
    await expect(deps.hasCheckedIndependentForNode(scope, NODE)).resolves.toBe(
      false,
    );
    await expect(deps.flagsForNode?.(scope, NODE)).resolves.toEqual({
      hasAssistance: true,
      hasCheckedIndependent: false,
      evidenceIds: [OBS],
    });
  });
});

describe("listTutorActionsForCourse authorization", () => {
  it("rejects a course outside the caller workspace", async () => {
    const deps = createDeps({
      assertOwnedCourse: vi.fn(async () => {
        throw Object.assign(new Error("course not found"), { code: "NOT_FOUND" });
      }),
    });
    await expect(
      listTutorActionsForCourse(
        {} as never,
        scope,
        COURSE,
        new URLSearchParams({ skillLabel: "derivatives" }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.assertOwnedCourse).toHaveBeenCalledWith(scope, COURSE);
  });

  it("rejects a session outside the requested course", async () => {
    const deps = createDeps({
      getSession: vi.fn(async () => ({
        id: SESSION,
        courseId: "33333333-3333-4333-8333-333333333333",
      })),
    });
    await expect(
      listTutorActionsForCourse(
        {} as never,
        scope,
        COURSE,
        new URLSearchParams({ skillLabel: "derivatives", sessionId: SESSION }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("derives recommendations from delivered exposures", async () => {
    const deps = createDeps({
      getSession: vi.fn(async () => ({ id: SESSION, courseId: COURSE })),
      listDeliveredExposures: vi.fn(async () => ["revealed", "hinted"]),
    });
    const actions = await listTutorActionsForCourse(
      {} as never,
      scope,
      COURSE,
      new URLSearchParams({ skillLabel: "chain rule", sessionId: SESSION }),
      deps,
    );
    expect(actions[0]!.kind).toBe("independent_variant");
    expect(deps.listDeliveredExposures).toHaveBeenCalledWith(scope, SESSION);
  });

  it("derives delayed retest from a matching due activity", async () => {
    const deps = createDeps({
      listDueRetests: vi.fn(async () => [{ skillLabel: "chain rule" }]),
    });
    const actions = await listTutorActionsForCourse(
      {} as never,
      scope,
      COURSE,
      new URLSearchParams({ skillLabel: "chain rule", currentPage: "2" }),
      deps,
    );
    expect(actions[0]!.kind).toBe("delayed_retest");
  });

  it("ignores a due activity for another skill", async () => {
    const deps = createDeps({
      listDueRetests: vi.fn(async () => [{ skillLabel: "other skill" }]),
    });
    const actions = await listTutorActionsForCourse(
      {} as never,
      scope,
      COURSE,
      new URLSearchParams({ skillLabel: "chain rule", currentPage: "2" }),
      deps,
    );
    expect(actions[0]!.kind).toBe("guided");
  });

  it("loads SkillEvidence flags on the server when nodeId is present", async () => {
    const flagsForNode = vi.fn(async () => ({
      hasAssistance: true,
      hasCheckedIndependent: false,
      evidenceIds: [OBS],
    }));
    const deps = createDeps({ flagsForNode });
    const actions = await listTutorActionsForCourse(
      {} as never,
      scope,
      COURSE,
      new URLSearchParams({
        skillLabel: "chain rule",
        currentPage: "2",
        nodeId: NODE,
      }),
      deps,
    );
    expect(actions[0]!.kind).toBe("independent_variant");
    expect(actions[0]!.nodeId).toBe(NODE);
    expect(actions[0]!.evidenceIds).toEqual([OBS]);
    expect(flagsForNode).toHaveBeenCalledWith(scope, NODE);
  });

  it("falls back to discrete flag loaders when flagsForNode is absent", async () => {
    const deps = createDeps({
      flagsForNode: undefined,
      listSkillEvidenceForNode: vi.fn(async () => [
        { nodeId: NODE, observationId: OBS, dimension: "transfer" as const },
      ]),
      hasAssistanceForNode: vi.fn(async () => true),
      hasCheckedIndependentForNode: vi.fn(async () => false),
    });
    const actions = await listTutorActionsForCourse(
      {} as never,
      scope,
      COURSE,
      new URLSearchParams({
        skillLabel: "chain rule",
        currentPage: "2",
        nodeId: NODE,
      }),
      deps,
    );
    expect(actions[0]!.kind).toBe("independent_variant");
    expect(actions[0]!.evidenceIds).toEqual([OBS]);
    expect(deps.listSkillEvidenceForNode).toHaveBeenCalledWith(scope, NODE);
    expect(deps.hasAssistanceForNode).toHaveBeenCalledWith(scope, NODE);
    expect(deps.hasCheckedIndependentForNode).toHaveBeenCalledWith(scope, NODE);
  });
});
