import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

const create = vi.hoisted(() => vi.fn());
const requestCompile = vi.hoisted(() => vi.fn());

vi.mock("@aistudy/database", () => ({
  createOpeningTeachingActivitiesRepository: vi.fn(() => ({ create, requestCompile })),
}));

import { createOpeningTeachingActivityService } from "./activity-service";

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
  requestCompile.mockReset().mockResolvedValue({ activity: { id: activityId }, jobId: "job" });
});

describe("teaching activity service: compile enqueue seam", () => {
  it("creates with enqueueCompile when the teaching compiler is on", async () => {
    await createOpeningTeachingActivityService(sql, { OPENING_TEACHING_COMPILER_ENABLED: "1" }).create(scope, input);
    expect(create).toHaveBeenCalledWith(scope, input, { enqueueCompile: true });
  });

  it("keeps the plain activity shell when the compiler is off", async () => {
    await createOpeningTeachingActivityService(sql, {}).create(scope, input);
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
    const service = createOpeningTeachingActivityService(sql, {});
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
});
