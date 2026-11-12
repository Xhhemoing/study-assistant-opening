import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { activitySpecClientInitSchema, type TeachingActivityGenerateStatus } from "@aistudy/contracts";
import { createOpeningTeachingResumeService } from "./resume-service";

const io = vi.hoisted(() => ({ owned: vi.fn(), reconcile: vi.fn(), init: vi.fn(), attempts: vi.fn(), help: vi.fn(), heads: vi.fn(), sources: vi.fn(),
  activitiesFactory: vi.fn(), contentFactory: vi.fn(), attemptsFactory: vi.fn() }));
vi.mock("@aistudy/database", async () => {
  const actual = await import("../../../../../../packages/database/src/repositories/opening-teaching-content");
  return { assertOwnedActivity: io.owned, reconcileTeachingGenerate: io.reconcile, createOpeningTeachingActivitiesRepository: io.activitiesFactory,
    createOpeningTeachingContentRepository: io.contentFactory, createOpeningLearningAttemptRepository: io.attemptsFactory,
    listDeliveredHelpByActivity: io.help, listObservationHeadsByActivity: io.heads, probeLearningSourcesAvailability: io.sources,
    sanitizeCheckpointForRestore: actual.sanitizeCheckpointForRestore };
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, activityId = id(3), sourceId = id(4), blockId = id(5);
const sql = (() => { throw new Error("unexpected raw SQL; this test replaces repository ports only"); }) as unknown as Sql;
const stamp = "2026-11-11T03:00:00.000Z";
const init = activitySpecClientInitSchema.parse({ id: id(6), activityId, teachingUnitId: id(7), documentId: id(8), revisionNumber: 1,
  blockOrder: [], sourceRefs: [], goals: [], verificationStatus: "unchecked", generationConfig: {}, version: 2, createdAt: stamp, updatedAt: stamp, blocks: [], contentVersion: 2 });
function activity(status: TeachingActivityGenerateStatus = "queued", version = 1) {
  return { id: activityId, status: "active", generateStatus: status, contentVersion: version, pathVersion: 1, sourceIds: [sourceId], checkpointJson: {} };
}
beforeEach(() => {
  vi.resetAllMocks(); io.activitiesFactory.mockReturnValue({}); io.contentFactory.mockReturnValue({ getClientInit: io.init });
  io.attemptsFactory.mockReturnValue({ listByActivity: io.attempts }); io.owned.mockResolvedValue(activity());
  io.reconcile.mockResolvedValue({ changed: false }); io.init.mockResolvedValue(init); io.attempts.mockResolvedValue([]);
  io.help.mockResolvedValue([]); io.heads.mockResolvedValue([]); io.sources.mockResolvedValue({ availableIds: [sourceId] });
});
function service(staleMs = 42) { return createOpeningTeachingResumeService(sql, { generateStaleMs: staleMs }); }

describe("resume factory reconciliation and fail-soft boundary", () => {
  it.each(["queued", "generating"] as const)("rereads a changed %s activity and assembles the refreshed version/status", async initial => {
    io.owned.mockResolvedValueOnce(activity(initial)).mockResolvedValueOnce(activity("failed", 2));
    io.reconcile.mockResolvedValueOnce({ changed: true });
    const result = await service().getResume(scope, activityId);
    expect(result).toMatchObject({ generateStatus: "failed", contentVersion: 2, gates: { job: "unknown" }, summary: { status: "skipped" } });
    expect(result.continuableActions).toEqual(["wait_job"]);
    expect(io.owned).toHaveBeenCalledTimes(2);
    expect(io.reconcile).toHaveBeenCalledExactlyOnceWith(sql, scope, activityId, { staleMs: 42 });
    expect(io.owned.mock.invocationCallOrder[0]!).toBeLessThan(io.reconcile.mock.invocationCallOrder[0]!);
    expect(io.reconcile.mock.invocationCallOrder[0]!).toBeLessThan(io.owned.mock.invocationCallOrder[1]!);
    expect(io.owned.mock.invocationCallOrder[1]!).toBeLessThan(io.init.mock.invocationCallOrder[0]!);
  });
  it.each(["ready", "failed", "cancelled", "unknown", "stale"] as const)("does not reconcile terminal/non-running %s even when the port would report a change", async status => {
    io.owned.mockResolvedValue(activity(status)); io.reconcile.mockResolvedValue({ changed: true });
    const result = await service().getResume(scope, activityId);
    expect(result.generateStatus).toBe(status); expect(io.reconcile).not.toHaveBeenCalled(); expect(io.owned).toHaveBeenCalledOnce();
  });
  it("does not reread after unchanged reconciliation, preserving the original version and in-flight gate", async () => {
    const result = await service(0).getResume(scope, activityId);
    expect(result).toMatchObject({ contentVersion: 1, gates: { job: "in_flight" } });
    expect(io.owned).toHaveBeenCalledOnce(); expect(io.reconcile).toHaveBeenCalledWith(sql, scope, activityId, { staleMs: 0 });
    expect(result.continuableActions).toEqual(["wait_job"]);
  });
  it("keeps resume available when reconciliation itself fails and still reads all factual ports", async () => {
    io.reconcile.mockRejectedValueOnce(new Error("reconcile unavailable"));
    const result = await service().getResume(scope, activityId);
    expect(result).toMatchObject({ generateStatus: "queued", gates: { job: "in_flight" }, summary: { status: "skipped" } });
    expect(io.owned).toHaveBeenCalledOnce();
    expect(io.attempts).toHaveBeenCalledExactlyOnceWith(scope, activityId, 100);
    expect(io.help).toHaveBeenCalledExactlyOnceWith(sql, scope, activityId, 100);
    expect(io.heads).toHaveBeenCalledExactlyOnceWith(sql, scope, activityId, 100);
    expect(io.sources).toHaveBeenCalledExactlyOnceWith(sql, scope, [sourceId]);
  });
  it("retains the first owned snapshot if the best-effort changed reread fails", async () => {
    io.reconcile.mockResolvedValueOnce({ changed: true }); io.owned.mockResolvedValueOnce(activity()).mockRejectedValueOnce(new Error("reread failed"));
    const result = await service().getResume(scope, activityId);
    expect(result).toMatchObject({ generateStatus: "queued", contentVersion: 1, gates: { job: "in_flight" } });
    expect(io.init).toHaveBeenCalledOnce(); expect(io.attempts).toHaveBeenCalledOnce();
  });
  it("treats client-init failure as missing init without discarding factual attempts or checkpoint drafts", async () => {
    io.owned.mockResolvedValue({ ...activity("ready"), checkpointJson: { drafts: [{ blockId, contentVersion: 1, draftText: "kept" }] } });
    io.init.mockRejectedValueOnce(new Error("published body unavailable"));
    io.attempts.mockResolvedValueOnce([{ id: id(10), problemId: id(11), itemVersionId: null, submittedAt: null, outcome: null, assistance: "unknown" }]);
    const result = await service().getResume(scope, activityId);
    expect(result.clientInit).toBeNull(); expect(result.continuableActions).toEqual(["edit_draft"]);
    expect(result.actualAttempts).toEqual([{ attemptId: id(10), problemId: id(11), itemVersionId: null, outcome: "in_progress", assistance: "unknown", submittedAt: null }]);
    expect(result.openProblems).toEqual([{ problemId: id(11), itemVersionId: null, reason: "attempt_open" }]);
    expect(result.drafts).toEqual([{ blockId, contentVersion: 1, draftText: "kept" }]);
  });
  it.each(["attempts", "help", "heads", "sources"] as const)("does not turn factual %s failure into an empty successful resume", async port => {
    const failure = new Error(`failed ${port}`); io[port].mockRejectedValueOnce(failure);
    await expect(service().getResume(scope, activityId)).rejects.toBe(failure);
    if (port === "attempts") expect(io.help).not.toHaveBeenCalled();
    if (port === "help") expect(io.heads).not.toHaveBeenCalled();
    if (port === "heads") expect(io.sources).not.toHaveBeenCalled();
  });
  it("stops on initial ownership failure before reconciliation or other reads", async () => {
    const failure = Object.assign(new Error("not owned"), { code: "NOT_FOUND" }); io.owned.mockRejectedValueOnce(failure);
    await expect(service().getResume(scope, activityId)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, message: "not owned" });
    expect(io.reconcile).not.toHaveBeenCalled(); expect(io.init).not.toHaveBeenCalled(); expect(io.attempts).not.toHaveBeenCalled();
  });
  it("uses the refreshed source/checkpoint/status together instead of mixing old and new snapshots", async () => {
    const fresh = { ...activity("ready", 2), status: "paused", pathVersion: 3, sourceIds: [id(12)],
      checkpointJson: { currentBlockId: blockId, drafts: [{ blockId, contentVersion: 2, draftText: "fresh" }] } };
    io.owned.mockResolvedValueOnce(activity()).mockResolvedValueOnce(fresh); io.reconcile.mockResolvedValueOnce({ changed: true });
    io.sources.mockResolvedValueOnce({ availableIds: [] });
    const result = await service().getResume(scope, activityId);
    expect(result).toMatchObject({ status: "paused", contentVersion: 2, pathVersion: 3, thoughtTrain: { currentBlockId: blockId },
      drafts: [{ blockId, contentVersion: 2, draftText: "fresh" }], gates: { job: "ready", materials: "unavailable", unavailableSourceIds: [id(12)] } });
    expect(io.sources).toHaveBeenCalledExactlyOnceWith(sql, scope, [id(12)]);
    expect(result.continuableActions).toEqual(["resolve_material", "continue_block", "command_why", "command_rephrase", "command_expand", "command_example", "command_skip", "command_branch", "edit_draft"]);
  });
  it("keeps both fail-soft paths independent when reconciliation and client init fail together", async () => {
    io.reconcile.mockRejectedValueOnce(new Error("reconcile")); io.init.mockRejectedValueOnce(new Error("init"));
    const result = await service().getResume(scope, activityId);
    expect(result).toMatchObject({ clientInit: null, generateStatus: "queued", gates: { job: "in_flight" }, actualAttempts: [], helpDelivered: [], summary: { status: "skipped" } });
    expect(result.continuableActions).toEqual(["wait_job"]); expect(io.sources).toHaveBeenCalledOnce();
  });
  it("does not treat a malformed non-null client init as the allowed missing-init fallback", async () => {
    io.init.mockResolvedValueOnce({ ...init, contentVersion: -1 });
    await expect(service().getResume(scope, activityId)).rejects.toMatchObject({ name: "ZodError" });
    expect(io.sources).toHaveBeenCalledOnce();
  });
  it("creates repository ports once per factory with the supplied SQL handle", async () => {
    const s = service(); await s.getResume(scope, activityId); await s.getResume(scope, activityId);
    for (const factory of [io.activitiesFactory, io.contentFactory, io.attemptsFactory]) expect(factory).toHaveBeenCalledExactlyOnceWith(sql);
    expect(io.owned).toHaveBeenCalledTimes(2); expect(io.reconcile).toHaveBeenCalledTimes(2);
  });
});
