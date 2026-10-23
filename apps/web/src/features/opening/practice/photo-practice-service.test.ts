import { describe, expect, it, vi } from "vitest";
import { CourseMembershipError } from "@aistudy/database";
import type { SourceRecord } from "@aistudy/contracts";
import type { AuthRuntime } from "../../auth/service";
import { preparePhotoPractice } from "./photo-practice-service";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const courseId = "44444444-4444-4444-8444-444444444444";
const principal = { userId, workspaceId, sessionId: userId };
const source = { id: sourceId, workspaceId, uploadState: "uploaded", parseState: "ready", version: 2 } as SourceRecord;
const course = { id: courseId, workspaceId, slug: `quick-practice-${userId}`, archivedAt: null };
function setup() {
  const courses = { listCourses: vi.fn().mockResolvedValue([]), createCourse: vi.fn().mockResolvedValue(course),
    addAssetMembership: vi.fn().mockResolvedValue({}), getMembership: vi.fn().mockRejectedValue(new CourseMembershipError("NOT_FOUND", "missing")) };
  const sources = { get: vi.fn().mockResolvedValue(source) };
  return { courses, sources, runtime: { courses } as unknown as AuthRuntime };
}

describe("photo practice preparation", () => {
  it("creates a stable personal course and attaches only the confirmed source", async () => {
    const { courses, sources, runtime } = setup();
    expect(await preparePhotoPractice(runtime, principal, { sourceId, sourceVersion: 2 }, sources)).toEqual({ courseId, sourceId, sourceVersion: 2 });
    expect(sources.get).toHaveBeenCalledWith({ workspaceId, ownerUserId: userId }, sourceId);
    expect(courses.createCourse).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, slug: `quick-practice-${userId}` }));
    expect(courses.addAssetMembership).toHaveBeenCalledWith(expect.objectContaining({ courseId, assetType: "source", assetId: sourceId, visibility: "private" }));
  });
  it("converges after a simultaneous create and existing membership", async () => {
    const { courses, sources, runtime } = setup();
    courses.listCourses.mockResolvedValueOnce([]).mockResolvedValueOnce([course]);
    courses.createCourse.mockRejectedValue(new CourseMembershipError("CONFLICT", "exists"));
    courses.addAssetMembership.mockRejectedValue(new CourseMembershipError("DUPLICATE_MEMBERSHIP", "exists"));
    courses.getMembership.mockRejectedValueOnce(new CourseMembershipError("NOT_FOUND", "missing")).mockResolvedValueOnce({});
    expect(await preparePhotoPractice(runtime, principal, { sourceId }, sources)).toEqual({ courseId, sourceId, sourceVersion: 2 });
    expect(courses.getMembership).toHaveBeenCalledWith({ workspaceId, courseId, assetType: "source", assetId: sourceId });
  });
  it("recovers a lost successful response without creating another course", async () => {
    const { courses, sources, runtime } = setup();
    courses.listCourses.mockResolvedValue([course]);
    courses.getMembership.mockResolvedValue({});
    await preparePhotoPractice(runtime, principal, { sourceId }, sources);
    expect(courses.createCourse).not.toHaveBeenCalled();
    expect(courses.addAssetMembership).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...source, version: 3 }, "CONFLICT"],
    [{ ...source, uploadState: "pending" }, "CONFLICT"],
    [{ ...source, parseState: "running" }, "CONFLICT"],
    [{ ...source, workspaceId: courseId }, "WORKSPACE_FORBIDDEN"],
  ])("rejects stale, incomplete or foreign sources before writes", async (record, code) => {
    const { courses, sources, runtime } = setup();
    sources.get.mockResolvedValue(record);
    await expect(preparePhotoPractice(runtime, principal, { sourceId, sourceVersion: 2 }, sources)).rejects.toMatchObject({ code });
    expect(courses.createCourse).not.toHaveBeenCalled();
    expect(courses.addAssetMembership).not.toHaveBeenCalled();
  });
  it("does not silently reopen an archived course", async () => {
    const { courses, sources, runtime } = setup();
    courses.listCourses.mockResolvedValue([{ ...course, archivedAt: new Date().toISOString() }]);
    await expect(preparePhotoPractice(runtime, principal, { sourceId }, sources)).rejects.toMatchObject({ status: 409 });
    expect(courses.addAssetMembership).not.toHaveBeenCalled();
  });
});
