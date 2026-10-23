import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

const create = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const requestCompile = vi.hoisted(() => vi.fn());
const readTask = vi.hoisted(() => vi.fn());
const readySources = vi.hoisted(() => vi.fn());

vi.mock("@aistudy/database", () => ({
  createOpeningTeachingActivitiesRepository: vi.fn(() => ({ create, get, requestCompile })),
  readOpeningTeachingTaskFocus: readTask,
  createOpeningCourseReadySourcesRepository: vi.fn(() => ({ listReadySourceIdsForCourse: readySources })),
}));

import {
  createOpeningTeachingActivityService,
  teachingCreateGenerateStatusLabel,
} from "./activity-service";
import { canRequestTeachingCompile } from "./today-activity";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const input = {
  clientKey: "today-topic:2026-10-13",
  intentKind: "topic",
  intentSummary: "今日主题学习",
  createIntent: { intentKind: "topic", source: "today" },
};
const sql = {} as Sql;

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: activityId, generateStatus: "queued" });
  get.mockReset();
  requestCompile.mockReset().mockResolvedValue({ activity: { id: activityId }, jobId: "job" });
  readTask.mockReset();
  readySources.mockReset().mockResolvedValue([activityId]);
});

describe("teaching activity service: compile enqueue seam", () => {
  it("rejects a client-forged card variant before creating any activity", async () => {
    await expect(createOpeningTeachingActivityService(sql, {}).create(scope, { ...input,
      createIntent: { kind: "card_review_variant", cardId: activityId, variantBlockId: activityId, reviewReps: 0 },
    })).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    expect(create).not.toHaveBeenCalled();
    expect(requestCompile).not.toHaveBeenCalled();
  });
  it("resumes the activity bound to a first-learning task instead of compiling another empty lesson", async () => {
    readTask.mockResolvedValue({ title: "首次学习", courseId: null, skillLabel: null, clientKey: `first-learning-activity:${activityId}` });
    const original = { id: activityId, clientKey: "first-learning:original-request:activity", sourceIds: [activityId], intentSummary: "原目标与材料" };
    get.mockResolvedValue(original);
    const result = await createOpeningTeachingActivityService(sql, {}).create(scope, { ...input, createIntent: { source: "task", taskId: activityId } });
    expect(result).toEqual(original);
    expect(get).toHaveBeenCalledWith(scope, activityId);
    expect(create).not.toHaveBeenCalled();
  });
  it("does not manufacture a replacement if the first-learning activity is no longer owned or available", async () => {
    readTask.mockResolvedValue({ title: "首次学习", courseId: null, clientKey: `first-learning-activity:${activityId}` });
    get.mockResolvedValue(null);
    await expect(createOpeningTeachingActivityService(sql, {}).create(scope, { ...input, createIntent: { source: "task", taskId: activityId } })).rejects.toMatchObject({ status: 404 });
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["0", "1"])("does not compile a card-review task as an empty teaching activity with adaptive=%s", async flag => {
    readTask.mockResolvedValue({ title: "Review cards", courseId: null, skillLabel: null, suggestionKind: "review_cards" });
    await expect(createOpeningTeachingActivityService(sql, { OPENING_ADAPTIVE_PLANNING: flag, OPENING_TEACHING_COMPILER_ENABLED: "1" }).create(scope, {
      ...input, createIntent: { intentKind: "goal", source: "task", taskId: activityId },
    })).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    expect(create).not.toHaveBeenCalled();
  });
  it("preserves the real task course and materials when adaptive planning is disabled", async () => {
    readTask.mockResolvedValue({ title: "Real task", courseId: activityId, skillLabel: "Matrix rank" });
    await createOpeningTeachingActivityService(sql, { OPENING_ADAPTIVE_PLANNING: "0", OPENING_TEACHING_COMPILER_ENABLED: "0" }).create(scope, {
      ...input, sourceIds: [], createIntent: { source: "task", taskId: activityId },
    });
    expect(create).toHaveBeenCalledWith(scope, expect.objectContaining({
      intentSummary: "Real task", courseId: activityId, sourceIds: [activityId],
    }), { enqueueCompile: false });
    expect(create.mock.calls[0]![1]).not.toHaveProperty("goalJson.learnerFocus");
  });
  it("discards client-supplied learner focus even when adaptive planning is off", async () => {
    await createOpeningTeachingActivityService(sql, { OPENING_ADAPTIVE_PLANNING: "0", OPENING_TEACHING_COMPILER_ENABLED: "0" }).create(scope, {
      ...input, goalJson: { wantsFullExplanation: true, learnerFocus: { activityKind: "transfer_check" } },
    });
    expect(create).toHaveBeenCalledWith(scope, { ...input, goalJson: { wantsFullExplanation: true } }, { enqueueCompile: false });
  });

  it.each([{}, { OPENING_TEACHING_COMPILER_ENABLED: "1" }])("creates with enqueueCompile when the teaching compiler is on by default or explicitly: %j", async env => {
    await createOpeningTeachingActivityService(sql, env).create(scope, input);
    expect(create).toHaveBeenCalledWith(scope, input, { enqueueCompile: true });
  });

  it("keeps the plain activity shell when the compiler is off", async () => {
    await createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "0" }).create(scope, input);
    expect(create).toHaveBeenCalledWith(scope, input, { enqueueCompile: false });
  });

  it("requestCompile delegates with the client key when the compiler is on", async () => {
    const service = createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "true" });
    await expect(service.requestCompile(scope, activityId, { clientKey: "compile:abc123" })).resolves.toMatchObject({
      jobId: "job",
    });
    expect(requestCompile).toHaveBeenCalledWith(scope, activityId, "compile:abc123");
  });

  it("requestCompile fails as CONFIGURATION (503) when the compiler is off — never a silent no-op", async () => {
    const service = createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "0" });
    await expect(service.requestCompile(scope, activityId, { clientKey: "compile:abc123" })).rejects.toMatchObject({
      code: "CONFIGURATION",
      status: 503,
    });
    expect(requestCompile).not.toHaveBeenCalled();
  });

  it("maps repository CONFLICT to a 409", async () => {
    requestCompile.mockRejectedValue(Object.assign(new Error("teaching content already exists"), { code: "CONFLICT" }));
    const service = createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "1" });
    await expect(service.requestCompile(scope, activityId, { clientKey: "compile:abc123" })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("rejects a short client key before touching the repository", async () => {
    const service = createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "1" });
    await expect(service.requestCompile(scope, activityId, { clientKey: "x" })).rejects.toThrow();
    expect(requestCompile).not.toHaveBeenCalled();
  });

  it("does not claim 主讲内容已就绪 when the compiler is off (cv0 shell)", async () => {
    create.mockResolvedValue({
      id: activityId,
      generateStatus: "ready",
      contentVersion: 0,
    });
    const activity = await createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "0" }).create(scope, input);
    expect(create).toHaveBeenCalledWith(scope, input, { enqueueCompile: false });
    expect(teachingCreateGenerateStatusLabel(activity)).toBe("主讲内容未生成");
    expect(teachingCreateGenerateStatusLabel(activity)).not.toBe("主讲内容已就绪");
  });

  it("hides compile request when compilerEnabled is false", () => {
    expect(
      canRequestTeachingCompile(
        { generateStatus: "ready", contentVersion: 0 },
        { compilerEnabled: false },
      ),
    ).toBe(false);
    expect(
      canRequestTeachingCompile(
        { generateStatus: "failed", contentVersion: 2 },
        { compilerEnabled: false },
      ),
    ).toBe(false);
  });

});
