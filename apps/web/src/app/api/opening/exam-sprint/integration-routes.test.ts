import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), bind: vi.fn(), mapSource: vi.fn(), record: vi.fn(), review: vi.fn() }));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.authorize }));
vi.mock("../../../../features/opening/exam-sprint/runtime", () => ({
  getExamIntegrationService: () => deps, getExamForecastService: () => deps, getExamReviewService: () => deps,
}));
import { ApiError } from "../../../../features/auth/service";
import { GET, POST, PATCH } from "./integration/route";
import { GET as forecast, POST as addPaper } from "./forecast/route";
import { GET as review, POST as gradePhoto } from "./reviews/route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const id = "8a98ea06-fb2b-4fe6-835e-a960cdb8129d";
const request = (body?: unknown, query = "") => new Request(`http://localhost/api/opening/exam-sprint${query}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
describe("exam integration HTTP boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks(); deps.authorize.mockResolvedValue({ scope, sql: {} });
    for (const fn of [deps.read, deps.bind, deps.mapSource, deps.record, deps.review]) fn.mockResolvedValue({ ok: true });
  });
  it("authenticates every operation before reading input or invoking a service", async () => {
    deps.authorize.mockRejectedValue(new ApiError("UNAUTHENTICATED", "登录", 401));
    for (const run of [GET, POST, PATCH, forecast, addPaper, review, gradePhoto]) {
      const response = await run(request({ ownerUserId: "forged" }));
      expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(deps.read).not.toHaveBeenCalled(); expect(deps.review).not.toHaveBeenCalled();
  });
  it("passes owner scope and explicit binding/mapping data only", async () => {
    expect((await POST(request({ clientKey: "binding-123", courseId: id, expectedPackVersion: "v1" }))).status).toBe(200);
    expect(deps.bind).toHaveBeenCalledWith(scope, expect.objectContaining({ courseId: id, materials: [] }));
    expect((await PATCH(request({ clientKey: "mapping-123", sourceItemId: "q1", skillIds: ["skill1"] }))).status).toBe(200);
    expect((await forecast(request(undefined, "?teacher=Teacher"))).status).toBe(200);
    expect(deps.read).toHaveBeenCalledWith(scope, "Teacher");
    expect((await review(request(undefined, `?id=${id}`))).status).toBe(200);
    expect(deps.read).toHaveBeenCalledWith(scope, id);
  });
  it("rejects forged grades/identities, duplicate skills, untrusted image URLs and oversized input", async () => {
    expect((await POST(request({ clientKey: "binding-123", courseId: id, expectedPackVersion: "v1", ownerUserId: id }))).status).toBe(400);
    expect((await gradePhoto(request({ clientKey: "review-123", sourceItemId: "q1", workSourceId: id, workSourceVersion: 0,
      referenceSourceId: id, referenceSourceVersion: 0, correct: true, imageUrl: "http://localhost/private" }))).status).toBe(400);
    expect((await addPaper(request({ clientKey: "paper-123", sourceId: id, sourceVersion: 0, teacher: "T", year: 2025, label: "卷", kind: "past_exam",
      skills: [{ skillId: "s", points: 10 }, { skillId: "s", points: 20 }] }))).status).toBe(400);
    const huge = new Request("http://localhost", { method: "POST", headers: { "content-length": "32769" }, body: "{}" });
    expect((await gradePhoto(huge)).status).toBe(413);
    expect(deps.review).not.toHaveBeenCalled(); expect(deps.record).not.toHaveBeenCalled(); expect(deps.bind).not.toHaveBeenCalled();
  });
});
