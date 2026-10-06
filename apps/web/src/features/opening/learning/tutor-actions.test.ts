import { describe, expect, it, vi } from "vitest";
import {
  aggregateHighestExposure,
  buildTutorActions,
  listTutorActionsForCourse,
  parseTutorActionsSearchParams,
  type TutorActionObservationDeps,
} from "./tutor-actions";

const COURSE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const scope = { workspaceId: "workspace-1", ownerUserId: "user-1" };

function createDeps(
  overrides: Partial<TutorActionObservationDeps> = {},
): TutorActionObservationDeps {
  return {
    assertOwnedCourse: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listDeliveredExposures: vi.fn(async () => []),
    listDueRetests: vi.fn(async () => []),
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
      }),
    );
    expect(parsed.courseId).toBe(COURSE);
    expect(parsed.query.sessionId).toBe(SESSION);
    expect(parsed.query.currentPage).toBe(5);
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
    ).toThrow();
    expect(
      () =>
        parseTutorActionsSearchParams(
          COURSE,
          new URLSearchParams({ skillLabel: "derivatives", assistedSuccess: "1" }),
        ),
    ).toThrow();
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

describe("aggregateHighestExposure", () => {
  it("does not let a hint mask a reveal", () => {
    expect(aggregateHighestExposure(["revealed", "hinted"])).toEqual([
      "revealed",
    ]);
    expect(aggregateHighestExposure(["hinted", "hinted"])).toEqual(["hinted"]);
    expect(aggregateHighestExposure([])).toEqual([]);
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
});
