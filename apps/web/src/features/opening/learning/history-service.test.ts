import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCourseLearningHistoryRequest } from "./history-service";
import { ApiError } from "../../auth/service";
import { GET } from "../../../app/api/opening/courses/[id]/observations/history/route";

const dependencies = vi.hoisted(() => ({ requireScope: vi.fn(), readHistory: vi.fn() }));
vi.mock("../runtime", () => ({ requireOpeningScope: dependencies.requireScope }));
vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  readOpeningCourseLearningHistory: dependencies.readHistory,
}));

const courseId = "11111111-1111-4111-8111-111111111111";
const parse = (query: string) => parseCourseLearningHistoryRequest(courseId, new URLSearchParams(query));
describe("course history HTTP query boundary", () => {
  it("distinguishes all, unassigned and exact original requirement keys", () => {
    expect(parse("")).toEqual({ courseId, limit: 50 });
    expect(parse("requirement=unassigned")).toEqual({ courseId, requirementKey: null, limit: 50 });
    expect(parse("requirementKey=")).toEqual({ courseId, requirementKey: "", limit: 50 });
    expect(parse("requirementKey=%20%E7%AC%AC%E4%B8%80%E7%AB%A0%20").requirementKey).toBe(" 第一章 ");
    expect(parse("requirementKey=null").requirementKey).toBe("null");
  });
  it("preserves an opaque cursor and accepts both exact size boundaries", () => {
    const cursor = "opaque+/= with spaces";
    expect(parse(new URLSearchParams({ cursor, limit: "1" }).toString())).toEqual({ courseId, limit: 1, cursor });
    expect(parse("limit=200").limit).toBe(200);
  });
  it.each(["limit=0", "limit=201", "limit=1.5", "limit=2x", "limit=", "limit=-1", "limit=1e2", "limit=1&limit=2",
    "cursor=", "cursor=a&cursor=b", "mode=all", "ownerUserId=other", "requirement=all", "requirement=unassigned&requirementKey=x",
    "requirementKey=x&requirementKey=y"])("rejects invalid or ambiguous query %s", query => {
    expect(() => parse(query)).toThrow();
  });
  it("rejects an invalid course route identity", () => {
    expect(() => parseCourseLearningHistoryRequest("not-a-uuid", new URLSearchParams())).toThrow();
  });
});

describe("course history route authorization and error mapping", () => {
  const scope = { workspaceId: "22222222-2222-4222-8222-222222222222", ownerUserId: "33333333-3333-4333-8333-333333333333" };
  const sql = { connection: "authenticated runtime" };
  const page = { observations: [], snapshotRevision: 7, nextCursor: null, totalCount: 0, visibilityChanged: false };
  const read = (query = "", id = courseId) => GET(new Request(`http://localhost/api/opening/courses/${id}/observations/history?${query}`),
    { params: Promise.resolve({ id }) });
  beforeEach(() => {
    vi.resetAllMocks();
    dependencies.requireScope.mockResolvedValue({ scope, sql });
    dependencies.readHistory.mockResolvedValue(page);
  });
  it("passes authenticated scope and original opaque query values to the actual repository interface", async () => {
    const cursor = "opaque+/= with spaces";
    const response = await read(new URLSearchParams({ cursor, requirementKey: "", limit: "1" }).toString());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(page);
    expect(dependencies.requireScope).toHaveBeenCalledWith(expect.any(Request));
    expect(dependencies.readHistory).toHaveBeenCalledExactlyOnceWith(sql, scope, { courseId, cursor, requirementKey: "", limit: 1 });
  });
  it.each(["", "requirement=unassigned"])("keeps all and unassigned request semantics for %s", async query => {
    expect((await read(query)).status).toBe(200);
    expect(dependencies.readHistory).toHaveBeenCalledExactlyOnceWith(sql, scope,
      { courseId, limit: 50, ...(query ? { requirementKey: null } : {}) });
  });
  it("returns 401 before parsing or reading an anonymous request", async () => {
    dependencies.requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Sign in required", 401));
    const response = await read("ownerUserId=forged");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(dependencies.readHistory).not.toHaveBeenCalled();
  });
  it.each(["limit=2x", "limit=1&limit=2", "requirement=unassigned&requirementKey=x", "ownerUserId=forged"])("maps query rejection to 400 before repository access: %s", async query => {
    const response = await read(query);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
    expect(dependencies.readHistory).not.toHaveBeenCalled();
  });
  it("maps an invalid route id to 400", async () => {
    expect((await read("", "not-a-uuid")).status).toBe(400);
    expect(dependencies.readHistory).not.toHaveBeenCalled();
  });
  it.each([["NOT_FOUND", 404], ["VALIDATION", 400]] as const)("maps repository %s without returning a page", async (code, status) => {
    dependencies.readHistory.mockRejectedValue(Object.assign(new Error("course or cursor unavailable"), { code }));
    const response = await read();
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message: "course or cursor unavailable" } });
  });
});
