import { describe, expect, it } from "vitest";
import { ApiError, jsonError } from "../../auth/service";
import { addMembershipBodySchema, createCourseBodySchema, parseCourseRequest, readCourseJson, removeMembershipBodySchema } from "./course-request-schemas";

const assetId = "11111111-1111-4111-8111-111111111111";
const reject = (run: () => unknown) => {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ApiError); return error as ApiError; }
  throw new Error("expected a validation error");
};

describe("course request validation", () => {
  it("accepts the bodies the app sends", () => {
    expect(parseCourseRequest(createCourseBodySchema, { title: " 高等数学 ", slug: "materials-abc", description: "" })).toEqual({ title: "高等数学", slug: "materials-abc", description: "" });
    expect(parseCourseRequest(addMembershipBodySchema, { assetType: "document", assetId, role: "reference", visibility: "private" })).toMatchObject({ assetType: "document" });
    expect(parseCourseRequest(addMembershipBodySchema, { assetType: "source", assetId, role: "core", sortOrder: 0, visibility: "private" })).toMatchObject({ sortOrder: 0 });
    expect(parseCourseRequest(removeMembershipBodySchema, { assetType: "source", assetId })).toEqual({ assetType: "source", assetId });
  });
  it("rejects bad bodies with a Chinese message in the VALIDATION envelope", async () => {
    const missingTitle = reject(() => parseCourseRequest(createCourseBodySchema, { slug: "a" }));
    expect(missingTitle.status).toBe(400);
    expect(missingTitle.message).toBe("请填写课程名称。");
    expect(reject(() => parseCourseRequest(createCourseBodySchema, { title: "x", slug: "Bad Slug" })).message).toContain("小写字母");
    expect(reject(() => parseCourseRequest(createCourseBodySchema, null)).message).toBe("请求内容格式不正确。");
    expect(reject(() => parseCourseRequest(addMembershipBodySchema, { assetType: "video", assetId, role: "core", visibility: "private" })).message).toBe("资料类型不受支持。");
    expect(reject(() => parseCourseRequest(addMembershipBodySchema, { assetType: "source", assetId: "x", role: "core", visibility: "private" })).message).toBe("资料编号格式不正确。");
    const body = await jsonError(missingTitle).json();
    expect(body).toEqual({ error: { code: "VALIDATION", message: "请填写课程名称。" } });
  });
  it("maps malformed JSON to a Chinese validation error", async () => {
    await expect(readCourseJson(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toMatchObject({ code: "VALIDATION", message: "请求内容不是有效的 JSON。" });
  });
});
