import { expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";

const mocks = vi.hoisted(() => ({
  activityRow: null as Record<string, unknown> | null,
  retestRow: null as Record<string, unknown> | null,
  currentActivityId: null as string | null,
}));

vi.mock("./opening-current-learning-activity", () => ({
  readOpeningCurrentLearningActivity: vi.fn(async () =>
    mocks.currentActivityId ? { activityId: mocks.currentActivityId, sessionId: null, courseId: "11111111-1111-4111-8111-111111111111" } : null,
  ),
}));
vi.mock("./opening-learning-decisions", () => ({
  readOpeningLearningDecision: vi.fn(async () => null),
}));
vi.mock("./opening-learner-state-read", () => ({
  readOpeningLearnerState: vi.fn(async () => ({
    stateVersion: "rev:0",
    dataAsOf: "2026-11-02T09:00:00.000Z",
    features: [],
    sourceVersions: {},
  })),
}));
vi.mock("./opening-learning-read", () => ({
  readOpeningCourseEvidence: vi.fn(async () => ({ observations: [], evidenceContexts: {} })),
}));
vi.mock("./opening-span-tutor-grant", () => ({
  readSpanTutorAuthorization: vi.fn(async () => ({
    grant: null,
    authorized: true,
    reason: null,
    timeZone: "UTC",
    localDate: "2026-11-02",
    goalTargetDate: null,
  })),
}));
vi.mock("./opening-course-route-origin", () => ({
  assertOpeningCourseRouteCurrent: vi.fn(async () => undefined),
}));
vi.mock("./opening-course-route-read", () => ({
  readCourseRequirements: vi.fn(async () => []),
  readCourseRouteObservations: vi.fn(async () => ({ projected: [] })),
}));
vi.mock("./opening-learning-goals", () => ({
  readLearningGoal: vi.fn(async () => null),
}));

import { createOpeningLearningAgendaRepository, readOpeningLearningAgenda } from "./opening-learning-agenda";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const courseId = "33333333-3333-4333-8333-333333333333";
const activityId = "44444444-4444-4444-8444-444444444444";
const retestId = "55555555-5555-4555-8555-555555555555";

function createFakeSql() {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM opening_teaching_activities a")) {
      return Promise.resolve(mocks.activityRow ? [mocks.activityRow] : []);
    }
    if (query.includes("FROM opening_retest_activities r")) {
      return Promise.resolve(mocks.retestRow ? [mocks.retestRow] : []);
    }
    return Promise.resolve([]);
  }) as unknown as TransactionSql;

  const sql = {
    begin: (_modeOrFn: unknown, maybeFn?: (tx: TransactionSql) => Promise<unknown>) =>
      (maybeFn ?? (_modeOrFn as (tx: TransactionSql) => Promise<unknown>))(tx),
  } as unknown as Sql;

  return { tx, sql };
}

function seedActivityAndRetest(retestOverrides: Record<string, unknown> = {}, activityOverrides: Record<string, unknown> = {}) {
  mocks.activityRow = {
    id: activityId,
    status: "active",
    source_ids: [],
    archived_at: null,
    session_id: null,
    skill_label: null,
    create_intent: { protocol: "span-lesson-v1" },
    goal_json: {},
    checkpoint_json: { spanLesson: { retestId, moveId: "self-example" } },
    ...activityOverrides,
  };
  mocks.retestRow = {
    id: retestId,
    status: "accepted",
    task_status: null,
    snoozed_until: "2026-11-05T09:00:00.000Z",
    not_before_at: null,
    not_before: null,
    scheduled_start_at: null,
    recommended_at: null,
    ...retestOverrides,
  };
}

it("evaluates snoozed_until deterministically against options.now across before, exact, and after boundaries", async () => {
  seedActivityAndRetest();
  const { tx } = createFakeSql();

  const wellBefore = await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-02T09:00:00Z") });
  expect(wellBefore).toMatchObject({ status: "deferred", resumable: false, invalidationReasons: ["retest_deferred"] });

  const oneMsBefore = await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-05T08:59:59.999Z") });
  expect(oneMsBefore).toMatchObject({ status: "deferred", resumable: false, invalidationReasons: ["retest_deferred"] });

  const exactBoundary = await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-05T09:00:00.000Z") });
  expect(exactBoundary).toMatchObject({ status: "active", resumable: true, invalidationReasons: [] });

  const afterBoundary = await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-05T09:00:00.001Z") });
  expect(afterBoundary).toMatchObject({ status: "active", resumable: true, invalidationReasons: [] });
});

it.each(["not_before_at", "not_before", "scheduled_start_at", "recommended_at"] as const)(
  "treats future %s relative to injected now as deferred",
  async field => {
    seedActivityAndRetest({ snoozed_until: null, [field]: "2026-11-05T09:00:00.000Z" });
    const { tx } = createFakeSql();
    expect(await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-02T09:00:00Z") }))
      .toMatchObject({ status: "deferred", resumable: false, invalidationReasons: ["retest_deferred"] });
    expect(await readOpeningLearningAgenda(tx, scope, courseId, activityId, { now: new Date("2026-11-05T09:00:00Z") }))
      .toMatchObject({ status: "active", resumable: true, invalidationReasons: [] });
  },
);

it("threads injected clock from createOpeningLearningAgendaRepository and uses clock for archived dataAsOf fallback", async () => {
  seedActivityAndRetest({}, { archived_at: "2026-11-01T00:00:00.000Z" });
  let current = new Date("2026-11-02T09:00:00Z");
  const { sql } = createFakeSql();
  const repo = createOpeningLearningAgendaRepository(sql, () => current);

  expect(await repo.get(scope, courseId, activityId)).toMatchObject({
    status: "deferred",
    resumable: false,
    invalidationReasons: ["course_unavailable", "retest_deferred"],
    dataAsOf: "2026-11-02T09:00:00.000Z",
  });

  current = new Date("2026-11-05T09:00:00Z");
  expect(await repo.get(scope, courseId, activityId)).toMatchObject({
    status: "active",
    resumable: false,
    invalidationReasons: ["course_unavailable"],
    dataAsOf: "2026-11-05T09:00:00.000Z",
  });
});
