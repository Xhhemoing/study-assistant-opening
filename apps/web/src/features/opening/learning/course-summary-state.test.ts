import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseLearningSummaryPage, LearningSummaryAggregate } from "@aistudy/contracts";
import { notifyOpeningPrivacyChange } from "../client/privacy-change";
import { createCourseSummaryController, emptyCourseSummary } from "./course-summary-state";
const courseId = "11111111-1111-4111-8111-111111111111", evaluatedAt = "2026-09-30T10:00:00.000Z";
const group = (requirementKey: string | null): LearningSummaryAggregate => ({
  identity: { courseId, skillLabel: "fractions", requirementKey }, sampleCount: 0, lastObservedAt: null, latestAttemptAt: null,
  latestAttemptCount: 0, independentVerifiedCurrentCount: 0, latestIndependentVerifiedCurrentCount: 0,
  historicalIncorrectCount: 0, historicalSuccessCount: 0, unverifiedCount: 0, evidenceSources: [], representatives: [],
  applicabilityCounts: { exact: 0, equivalent_confirmed: 0, changed_needs_check: 0, version_unknown: 0, unavailable: 0 },
  openChecks: { acceptedCount: 1, inProgressCount: 0, dueCount: 0 },
});
const page = (groups = [group(null)], nextCursor: string | null = null, revision = 1): CourseLearningSummaryPage => ({
  status: "ready", groups, nextCursor, snapshotRevision: revision, evaluatedAt, pendingProjectionCount: 0,
});
const updating = (pending: number): CourseLearningSummaryPage => ({ ...page([], "repair"), status: "updating", pendingProjectionCount: pending });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const dispose: Array<() => void> = [];
afterEach(() => dispose.splice(0).forEach(cancel => cancel()));
function setup(request: Parameters<typeof createCourseSummaryController>[0]) {
  let state = emptyCourseSummary();
  const controller = createCourseSummaryController(request, { courseId }, next => { state = next; });
  dispose.push(controller.cancel);
  return { controller, state: () => state };
}
describe("course summary pagination and repair state", () => {
  it("preserves null and empty identities while appending only on explicit more", async () => {
    const request = vi.fn().mockResolvedValueOnce(page([group(null)], "next")).mockResolvedValueOnce(page([group("")]));
    const view = setup(request); await view.controller.start();
    expect(request).toHaveBeenCalledTimes(1);
    await view.controller.loadMore();
    expect(view.state().groups.map(item => item.identity.requirementKey)).toEqual([null, ""]);
    expect(request.mock.calls[1]![0]).toEqual({ courseId, limit: 10, groupCursor: "next" });
  });
  it("continues same-page repair only while the server reports decreasing pending work", async () => {
    const request = vi.fn().mockResolvedValueOnce(updating(4)).mockResolvedValueOnce(updating(2)).mockResolvedValueOnce(page());
    const view = setup(request); await view.controller.start();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]![0].groupCursor).toBe("repair");
    expect(request.mock.calls[2]![0].groupCursor).toBe("repair");
    expect(view.state()).toMatchObject({ status: "ready", pendingProjectionCount: 0, groups: [group(null)] });
  });
  it("stops without a timer or repeated request when repair makes no progress", async () => {
    const request = vi.fn().mockResolvedValue(updating(4));
    const view = setup(request); await view.controller.start();
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.state()).toMatchObject({ status: "updating", groups: [], pendingProjectionCount: 4 });
    expect(view.state().notice).toContain("刷新");
    await view.controller.loadMore(); expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([new Error("offline"), Object.assign(new Error("changed"), { status: 409 })])("never retries network failures or a cursor conflict", async error => {
    const request = vi.fn().mockResolvedValueOnce(page([group(null)], "next")).mockRejectedValueOnce(error);
    const view = setup(request); await view.controller.start(); await view.controller.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.state()).toMatchObject({ status: "error", groups: [], nextCursor: null });
  });
  it("clears an incompatible revision instead of mixing pages", async () => {
    const request = vi.fn().mockResolvedValueOnce(page([group(null)], "next")).mockResolvedValueOnce(page([group("")], null, 2));
    const view = setup(request); await view.controller.start(); await view.controller.loadMore();
    expect(view.state()).toMatchObject({ status: "error", groups: [] });
    expect(view.state().error).toContain("刷新");
  });
  it("clears private conclusions immediately and ignores the old asynchronous page", async () => {
    const old = deferred<CourseLearningSummaryPage>(), safe = deferred<CourseLearningSummaryPage>();
    const request = vi.fn().mockResolvedValueOnce(page([group(null)], "next")).mockReturnValueOnce(old.promise).mockReturnValueOnce(safe.promise);
    const view = setup(request); await view.controller.start(); const pending = view.controller.loadMore();
    notifyOpeningPrivacyChange();
    expect(view.state()).toMatchObject({ status: "loading", groups: [] });
    expect(request.mock.calls[1]![1].aborted).toBe(true);
    old.resolve(page([group("old")])); await pending;
    expect(view.state().groups).toEqual([]);
    safe.resolve(page([group("safe")], null, 2)); await Promise.resolve(); await Promise.resolve();
    expect(view.state().groups.map(item => item.identity.requirementKey)).toEqual(["safe"]);
  });
  it("cancels a departed scope and does not continue its repair requests", async () => {
    const late = deferred<CourseLearningSummaryPage>(), request = vi.fn(() => late.promise);
    const view = setup(request); const pending = view.controller.start(); view.controller.cancel();
    late.resolve(updating(4)); await pending;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1].aborted).toBe(true);
    expect(view.state().groups).toEqual([]);
  });
});
