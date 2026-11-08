import { describe, expect, it, vi } from "vitest";
import { CourseSourcePurposeError, createCourseSourcePurposeClient } from "./course-source-purpose-client";

const courseId = "11111111-1111-4111-8111-111111111111";
const otherCourse = "44444444-4444-4444-8444-444444444444";
const sourceId = "22222222-2222-4222-8222-222222222222";
const current = { id: "33333333-3333-4333-8333-333333333333", courseId, assetType: "source" as const, assetId: sourceId, purpose: null, updatedAt: "2026-11-08T12:00:00.123Z" };

describe("course source purpose transport", () => {
  it("reads true null without reclassifying role=reference as purpose", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ assets: [{ ...current, role: "reference" }] }));
    expect(await createCourseSourcePurposeClient(transport).read(courseId, sourceId)).toEqual(current);
    expect(transport).toHaveBeenCalledWith(`/api/courses/${courseId}/assets`, expect.objectContaining({ cache: "no-store", method: "GET" }));
  });
  it("sends exact millisecond CAS and purpose only, without role or visibility updates", async () => {
    const saved = { ...current, purpose: "mock_exam" as const, updatedAt: "2026-11-08T12:00:00.124Z" };
    const transport = vi.fn<typeof fetch>(async () => Response.json({ membership: saved }));
    expect(await createCourseSourcePurposeClient(transport).update(courseId, current, "mock_exam")).toEqual(saved);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toEqual({ assetType: "source", assetId: sourceId, purpose: "mock_exam", expectedUpdatedAt: current.updatedAt });
  });
  it("can explicitly clear classification to null", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ membership: { ...current, updatedAt: "2026-11-08T12:00:00.124Z" } }));
    await createCourseSourcePurposeClient(transport).update(courseId, { ...current, purpose: "practice" }, null);
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).purpose).toBeNull();
  });
  it("adds a course-local purpose independently of role/private visibility", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ membership: { ...current, purpose: "teaching" } }, { status: 201 }));
    await createCourseSourcePurposeClient(transport).add(courseId, sourceId, "reference", "teaching");
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toEqual({ assetType: "source", assetId: sourceId, role: "reference", visibility: "private", sortOrder: 0, purpose: "teaching" });
  });
  it.each([401, 403, 404, 409, 500])("preserves denial/conflict status %s without retry or exposing server internals", async status => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ error: { code: status === 409 ? "CONFLICT" : "FORBIDDEN", message: "private key:SECRET" } }, { status }));
    const error = await createCourseSourcePurposeClient(transport).update(courseId, current, "practice").catch(reason => reason);
    expect(error).toBeInstanceOf(CourseSourcePurposeError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(status === 409 ? "CONFLICT" : "FORBIDDEN");
    expect(error.message).not.toContain("SECRET");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("never treats already-linked 409 as successful purpose classification", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFLICT" } }, { status: 409 }));
    await expect(createCourseSourcePurposeClient(transport).add(courseId, sourceId, "reference", "mock_exam")).rejects.toMatchObject({ status: 409 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a snapshot from another course before sending", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(createCourseSourcePurposeClient(transport).update(otherCourse, current, "teaching")).rejects.toThrow("其他课程");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { ...current, courseId: otherCourse },
    { ...current, purpose: undefined },
    { ...current, purpose: "unknown" },
    { ...current, updatedAt: "invalid" },
    { ...current, updatedAt: "2026-11-08T12:00:00.123456Z" },
    { ...current, updatedAt: "2026-11-08T12:00:00Z" },
    { ...current, updatedAt: "2026-11-08T12:00:00.123+00:00" },
  ])("rejects incompatible or legacy responses rather than claiming success", async row => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ assets: [row] }));
    await expect(createCourseSourcePurposeClient(transport).read(courseId, sourceId)).rejects.toThrow();
  });
  it("does not accept ignored purpose or a stale update acknowledgement", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ membership: current }));
    const client = createCourseSourcePurposeClient(transport);
    await expect(client.add(courseId, sourceId, "reference", "practice")).rejects.toThrow("尚未确认");
    await expect(client.update(courseId, current, null)).rejects.toThrow("尚未确认");
  });
});
