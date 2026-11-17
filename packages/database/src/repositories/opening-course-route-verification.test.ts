import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lockHistory: vi.fn(),
  assertGoal: vi.fn(),
  assertCourse: vi.fn(),
  readRequirements: vi.fn(),
  readRoute: vi.fn(),
  readQuestionForGrading: vi.fn(),
}));

vi.mock("./opening-learning-facts", async original => ({
  ...(await original<typeof import("./opening-learning-facts")>()),
  lockWorkspaceLearningHistory: mocks.lockHistory,
}));
vi.mock("./opening-learning-goals", () => ({
  assertLearningGoalAction: mocks.assertGoal,
}));
vi.mock("./opening-course-route-read", () => ({
  assertCourseRouteCourse: mocks.assertCourse,
  readCourseRequirements: mocks.readRequirements,
  readOpeningCourseRoute: mocks.readRoute,
}));
vi.mock("./opening-teaching-question", () => ({
  readTeachingQuestionForGrading: mocks.readQuestionForGrading,
}));

import { createOpeningCourseRouteVerificationRepository } from "./opening-course-route-verification";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const courseId = randomUUID(), activityId = randomUUID(), goalId = randomUUID();
const requirementId = randomUUID(), stableSkillId = randomUUID(), itemVersionId = randomUUID();

function makeDb() {
  const beginModes: Array<string | null> = [];
  const itemRow = { id: itemVersionId, stem_snapshot: "二阶单位矩阵的秩是多少？" };
  const activityRow = {
    content_version: 1,
    goal_json: {
      courseRoute: {
        goalId,
        goalRevision: 1,
        requirementId,
        requirementRevision: 1,
        stableSkillId,
        requirementKey: "rank",
        action: "diagnose",
      },
    },
  };
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([activityRow]);
    if (query.includes("FROM opening_learning_attempts")) return Promise.resolve([itemRow]);
    if (query.includes("FROM opening_learning_item_versions")) return Promise.resolve([itemRow]);
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as unknown as Sql["json"];
  sql.begin = ((modeOrFn: string | ((tx: Sql) => unknown), maybeFn?: (tx: Sql) => unknown) => {
    if (typeof modeOrFn === "string") {
      beginModes.push(modeOrFn);
      return maybeFn!(sql);
    }
    beginModes.push(null);
    return modeOrFn(sql);
  }) as Sql["begin"];
  return { sql, beginModes, itemRow };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockHistory.mockResolvedValue(undefined);
  mocks.assertGoal.mockResolvedValue({ id: goalId, revision: 1, courseIds: [courseId] });
  mocks.assertCourse.mockResolvedValue(undefined);
  mocks.readRequirements.mockResolvedValue([{
    id: requirementId,
    revision: 1,
    stableSkillId,
    requirementKey: "rank",
    goalIds: [goalId],
    verification: { kind: "rubric", status: "needs_check", exerciseKeys: [], rubric: "说明线性无关列的数量。", missingReasons: [] },
  }]);
  mocks.readRoute.mockResolvedValue({
    requirements: [{ requirement: { id: requirementId }, sourcesAvailable: true }],
  });
  mocks.readQuestionForGrading.mockResolvedValue({
    stem: "二阶单位矩阵的秩是多少？",
    misconceptions: [],
    sourceRefs: [],
    referenceText: "两列线性无关，秩为 2。",
  });
});

describe("opening-course-route-verification readOnly forwarding", () => {
  it("passes readOnly: true on repeatable-read-only read() and readOnly: false on confirm()", async () => {
    const { sql, beginModes, itemRow } = makeDb();
    const repo = createOpeningCourseRouteVerificationRepository(sql);

    const preview = await repo.read(scope, courseId, activityId);
    expect(preview).toMatchObject({
      courseId,
      activityId,
      available: true,
      items: [{ itemVersionId, referenceText: "两列线性无关，秩为 2。" }],
    });
    expect(beginModes).toEqual(["isolation level repeatable read read only"]);
    expect(mocks.readQuestionForGrading).toHaveBeenCalledTimes(1);
    expect(mocks.readQuestionForGrading).toHaveBeenCalledWith(sql, scope, itemRow, { readOnly: true });

    mocks.readQuestionForGrading.mockClear();
    await repo.confirm(scope, courseId, {
      goalId,
      expectedGoalRevision: 1,
      activityId,
      expectedContentVersion: 1,
      requirementId,
      expectedRequirementRevision: 1,
      itemVersionIds: [itemVersionId],
      confirmed: true,
    });
    expect(beginModes).toEqual(["isolation level repeatable read read only", null]);
    expect(mocks.readQuestionForGrading).toHaveBeenCalledTimes(2);
    expect(mocks.readQuestionForGrading).toHaveBeenNthCalledWith(1, sql, scope, itemRow, { readOnly: false });
    expect(mocks.readQuestionForGrading).toHaveBeenNthCalledWith(2, sql, scope, itemRow, { readOnly: false });
  });
});
