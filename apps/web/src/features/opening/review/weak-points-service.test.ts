import { describe, expect, it, vi } from "vitest";
import { createWeakPointsReadService } from "./weak-points-service";
import type { WeakPointsRead } from "./weak-points-model";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const empty: WeakPointsRead = { dataAsOf: "2026-10-23T00:00:00.000Z", features: [], display: { requirements: [] }, completeness: { total: 0, status: "complete" } };
const courseId = "33333333-3333-4333-8333-333333333333";
const archivedId = "44444444-4444-4444-8444-444444444444";
const missingId = "55555555-5555-4555-8555-555555555555";
function feature(id: string): WeakPointsRead["features"][number] {
  return { observationId: id, courseId: id, requirementKey: "span", skillLabel: "求系数", attemptedAt: empty.dataAsOf,
    eligibility: { verifiedCorrect: "no", independentAttempt: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "no", reasonCodes: [], policyVersion: "opening-evidence-v3" },
    views: [], retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null } };
}

describe("weak-point read service", () => {
  it("uses one owner-scoped complete state read and one course list for any course count", async () => {
    const readState = vi.fn(async () => empty);
    const listCourses = vi.fn(async () => Array.from({ length: 250 }, (_, index) => ({ id: String(index), title: `Course ${index}` })));
    const result = await createWeakPointsReadService({ readState, listCourses }).read(scope);
    expect(readState).toHaveBeenCalledExactlyOnceWith(scope);
    expect(listCourses).toHaveBeenCalledExactlyOnceWith(scope);
    expect(result).toEqual({ points: [], evaluatedAt: empty.dataAsOf, incomplete: false });
  });

  it("fails visibly if the qualified read or course list fails", async () => {
    const failure = new Error("source unavailable");
    await expect(createWeakPointsReadService({ readState: async () => { throw failure; }, listCourses: async () => [] }).read(scope)).rejects.toBe(failure);
    await expect(createWeakPointsReadService({ readState: async () => empty, listCourses: async () => { throw failure; } }).read(scope)).rejects.toBe(failure);
  });

  it("hides archived or no-longer-visible courses without misreporting the full read as incomplete", async () => {
    const state: WeakPointsRead = { ...empty, features: [feature(courseId), feature(archivedId), feature(missingId)],
      display: { requirements: [{ courseId: archivedId, requirementKey: "span", dueRetest: true }] },
      completeness: { total: 3, status: "complete" } };
    const listCourses = async () => [
      { id: courseId, title: "线代", archivedAt: null },
      { id: archivedId, title: "归档课程", archivedAt: new Date(empty.dataAsOf) },
    ];
    const summary = await createWeakPointsReadService({ readState: async () => state, listCourses }).read(scope);
    expect(summary.points).toMatchObject([{ courseId, courseTitle: "线代", state: "needs_practice" }]);
    expect(summary.points).toHaveLength(1);
    expect(summary.incomplete).toBe(false);
    const incomplete = await createWeakPointsReadService({
      readState: async () => ({ ...state, completeness: { total: 4, status: "truncated" } }), listCourses,
    }).read(scope);
    expect(incomplete.incomplete).toBe(true);
  });
});
