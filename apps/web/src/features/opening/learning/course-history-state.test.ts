import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseLearningHistoryPage } from "@aistudy/contracts";
import { createSourceActionsClient } from "../inbox/source-actions-client";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { createCourseHistoryController, emptyCourseHistory, type CourseHistoryState } from "./course-history-state";

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(cancel => cancel()); vi.unstubAllGlobals(); });
const courseId = learningObservation.courseId;
const record = (id: string) => ({ ...learningObservation, id, rootObservationId: id, answer: `answer-${id}` });
const page = (ids: string[], nextCursor: string | null = null, snapshotRevision = 3): CourseLearningHistoryPage => ({
  observations: ids.map(record), snapshotRevision, nextCursor, totalCount: 3, visibilityChanged: false,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(request: (input: Parameters<Parameters<typeof createCourseHistoryController>[0]>[0]) => Promise<CourseLearningHistoryPage>) {
  let state = emptyCourseHistory();
  const updates: CourseHistoryState[] = [];
  const controller = createCourseHistoryController(request, { courseId }, next => { state = next; updates.push(next); });
  dispose.push(() => controller.cancel());
  return { controller, updates, state: () => state };
}

describe("course history paging state", () => {
  it("loads 50 on demand, appends within one snapshot and starts a new one only on refresh", async () => {
    const request = vi.fn().mockResolvedValueOnce(page(["one"], "opaque"))
      .mockResolvedValueOnce(page(["two", "three"])) .mockResolvedValueOnce(page(["new"], null, 4));
    const view = setup(request);
    expect(request).not.toHaveBeenCalled();
    await view.controller.refresh();
    const key = view.state().snapshotKey;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith({ courseId, limit: 50 });
    await view.controller.loadMore();
    expect(request).toHaveBeenLastCalledWith({ courseId, limit: 50, cursor: "opaque" });
    expect(view.state().observations.map(row => row.id)).toEqual(["one", "two", "three"]);
    expect(view.state().snapshotRevision).toBe(3);
    expect(view.state().snapshotKey).toBe(key);
    await view.controller.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
    await view.controller.refresh();
    expect(view.state().observations.map(row => row.id)).toEqual(["new"]);
    expect(view.state().snapshotRevision).toBe(4);
    expect(view.state().snapshotKey).not.toBe(key);
  });

  it("suppresses repeated more clicks while a page is pending", async () => {
    const next = deferred<CourseLearningHistoryPage>();
    const request = vi.fn().mockResolvedValueOnce(page(["one"], "cursor")).mockReturnValueOnce(next.promise);
    const view = setup(request);
    await view.controller.refresh();
    const pending = view.controller.loadMore();
    await view.controller.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
    next.resolve(page(["two"])); await pending;
    expect(view.state().observations.map(row => row.id)).toEqual(["one", "two"]);
  });

  it("clears private old pages and card caches before safely rereading the first page", async () => {
    const fresh = deferred<CourseLearningHistoryPage>();
    const request = vi.fn().mockResolvedValueOnce(page(["private"], "cursor"))
      .mockResolvedValueOnce({ ...page(["ignored"]), visibilityChanged: true }).mockReturnValueOnce(fresh.promise);
    const view = setup(request); await view.controller.refresh();
    const key = view.state().snapshotKey;
    const pending = view.controller.loadMore();
    await Promise.resolve();
    expect(view.state().observations).toEqual([]);
    expect(view.state().notice).toContain("可见性已变化");
    expect(view.state().snapshotKey).not.toBe(key);
    expect(request).toHaveBeenLastCalledWith({ courseId, limit: 50 });
    fresh.resolve(page(["safe"], null, 4)); await pending;
    expect(view.state().observations.map(row => row.id)).toEqual(["safe"]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps private bodies cleared if the safe reread fails and never loops automatic requests", async () => {
    const request = vi.fn().mockResolvedValueOnce(page(["private"], "cursor"))
      .mockResolvedValueOnce({ ...page([]), visibilityChanged: true }).mockRejectedValueOnce(new Error("unavailable"));
    const view = setup(request); await view.controller.refresh(); await view.controller.loadMore();
    expect(view.state()).toMatchObject({ status: "error", observations: [], nextCursor: null, error: "unavailable" });
    expect(view.state().notice).toContain("可见性已变化");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not append a mismatched snapshot and removes cached bodies on a page error", async () => {
    const request = vi.fn().mockResolvedValueOnce(page(["one"], "cursor")).mockResolvedValueOnce(page(["new"], null, 4));
    const view = setup(request); await view.controller.refresh(); await view.controller.loadMore();
    expect(view.state()).toMatchObject({ status: "error", observations: [], nextCursor: null });
    expect(view.state().error).toContain("快照已变化");
  });

  it("ignores a late prior-page result after explicit refresh", async () => {
    const late = deferred<CourseLearningHistoryPage>();
    const request = vi.fn().mockResolvedValueOnce(page(["one"], "cursor")).mockReturnValueOnce(late.promise).mockResolvedValueOnce(page(["fresh"], null, 5));
    const view = setup(request); await view.controller.refresh();
    const pending = view.controller.loadMore(); await view.controller.refresh();
    late.resolve(page(["late"])); await pending;
    expect(view.state()).toMatchObject({ snapshotRevision: 5, observations: [expect.objectContaining({ id: "fresh" })] });
  });

  it("ignores results from a disposed course/filter scope", async () => {
    const late = deferred<CourseLearningHistoryPage>();
    const view = setup(() => late.promise); const pending = view.controller.refresh();
    view.controller.cancel(); const updates = view.updates.length;
    late.resolve(page(["old-scope"])); await pending;
    expect(view.updates).toHaveLength(updates);
    const request = vi.fn(async () => page([]));
    const other = createCourseHistoryController(request, { courseId: "other-course", requirementKey: null }, () => undefined);
    await other.refresh(); expect(request).toHaveBeenCalledWith({ courseId: "other-course", requirementKey: null, limit: 50 });
    other.cancel();
  });
});

const exclude = (response = Response.json({ sourceId: courseId, aiExcluded: true, deleted: false, cleanupPending: 0, retryAfter: null })) =>
  createSourceActionsClient(async () => response).act(courseId, { action: "exclude", expectedVersion: 1, expectedMembershipIds: [] });

describe("successful material privacy actions invalidate active history", () => {
  it("clears a single page and card identity before the safe first-page request returns", async () => {
    const safe = deferred<CourseLearningHistoryPage>();
    const request = vi.fn().mockResolvedValueOnce(page(["sensitive"])) .mockReturnValueOnce(safe.promise);
    const view = setup(request); await view.controller.start();
    const key = view.state().snapshotKey;
    expect(view.state().nextCursor).toBeNull();
    await exclude();
    expect(view.state()).toMatchObject({ status: "loading", observations: [], nextCursor: null });
    expect(view.state().snapshotKey).not.toBe(key);
    expect(view.state().notice).toContain("可见性已变化");
    expect(request).toHaveBeenLastCalledWith({ courseId, limit: 50 });
    safe.resolve(page(["safe"], null, 4)); await Promise.resolve();
    expect(view.state().observations.map(row => row.id)).toEqual(["safe"]);
  });

  it.each(["append", "refresh"])("ignores an old %s response after a successful privacy action", async action => {
    const late = deferred<CourseLearningHistoryPage>(), safe = deferred<CourseLearningHistoryPage>();
    const request = vi.fn().mockResolvedValueOnce(page(["sensitive"], action === "append" ? "cursor" : null))
      .mockReturnValueOnce(late.promise).mockReturnValueOnce(safe.promise);
    const view = setup(request); await view.controller.start();
    const pending = action === "append" ? view.controller.loadMore() : view.controller.refresh();
    await exclude();
    expect(view.state()).toMatchObject({ status: "loading", observations: [], nextCursor: null });
    late.resolve(page(["stale-sensitive"])); await pending;
    expect(view.state()).toMatchObject({ status: "loading", observations: [] });
    safe.resolve(page(["safe"], null, 4)); await Promise.resolve();
    expect(view.state().observations.map(row => row.id)).toEqual(["safe"]);
  });

  it.each([409, 500, "invalid-success"] as const)("does not invalidate drafts when the material action fails with %s", async failure => {
    const request = vi.fn().mockResolvedValue(page(["draft-being-edited"]));
    const view = setup(request); await view.controller.start();
    const original = view.state();
    const response = failure === "invalid-success" ? Response.json({ sourceId: courseId, aiExcluded: true })
      : new Response(null, { status: failure });
    await expect(exclude(response)).rejects.toThrow();
    expect(view.state()).toBe(original);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes the old scope without disabling the newly active scope", async () => {
    const old = setup(vi.fn().mockResolvedValue(page(["old-course"])));
    await old.controller.start(); old.controller.cancel();
    const updateCount = old.updates.length;
    const safe = deferred<CourseLearningHistoryPage>();
    const currentRequest = vi.fn().mockResolvedValueOnce(page(["current-sensitive"])).mockReturnValueOnce(safe.promise);
    const current = setup(currentRequest); await current.controller.start();
    await exclude();
    expect(old.updates).toHaveLength(updateCount);
    expect(current.state()).toMatchObject({ status: "loading", observations: [] });
    safe.resolve(page(["safe"], null, 4)); await Promise.resolve();
    expect(current.state().observations.map(row => row.id)).toEqual(["safe"]);
  });
});


it("clears a completed single page on a cross-tab message before its replacement arrives", async () => {
  const channels: Array<{ onmessage: ((event: MessageEvent) => void) | null }> = [];
  vi.stubGlobal("window", { BroadcastChannel: class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { channels.push(this); }
    postMessage() {}
    close() {}
  } });
  const safe = deferred<CourseLearningHistoryPage>();
  const request = vi.fn().mockResolvedValueOnce(page(["cross-tab-sensitive"])).mockReturnValueOnce(safe.promise);
  const view = setup(request); await view.controller.start();
  const key = view.state().snapshotKey;
  channels[0]!.onmessage!(new MessageEvent("message", { data: "changed" }));
  expect(view.state()).toMatchObject({ status: "loading", observations: [], nextCursor: null });
  expect(view.state().snapshotKey).not.toBe(key);
  safe.resolve(page([])); await Promise.resolve();
  expect(view.state()).toMatchObject({ status: "ready", observations: [] });
});
