import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  requireOpeningScope: vi.fn(), getSprintBudgetService: vi.fn(), read: vi.fn(),
  mapDomainError: vi.fn(), jsonError: vi.fn(), write: vi.fn(), getPlanningService: vi.fn(),
}));
vi.mock("../../../../../../features/opening/runtime", () => ({
  requireOpeningScope: deps.requireOpeningScope,
  getPlanningService: deps.getPlanningService,
}));
vi.mock("../../../../../../features/opening/exam-sprint/sprint-budget-runtime", () => ({
  getSprintBudgetService: deps.getSprintBudgetService,
}));
// Keep the real examSprintResponse wrapper, but do not import the auth service's
// application/database/model dependency graph just to exercise error delegation.
vi.mock("../../../../../../features/auth/service", () => ({
  mapDomainError: deps.mapDomainError, jsonError: deps.jsonError,
}));

import * as route from "./route";

const courseId = "a1111111-1111-4111-8111-111111111111";
const scope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
};
const sql = Object.assign(vi.fn(), { begin: vi.fn(), unsafe: vi.fn() });
const preview = {
  courseId, generatedAt: "2026-10-23T00:00:00.000Z", status: "needs_goal",
  examDate: null, timeZone: null, dailyMinutes: null, horizonTruncated: false,
  tasks: [], days: [], unscheduled: [], deferredTaskIds: [], scheduledTaskIds: [], warnings: [],
};
function context(id = courseId) { return { params: Promise.resolve({ id }) }; }
function request() { return new Request(`http://localhost/api/opening/courses/${courseId}/sprint-budget`); }

describe("GET /api/opening/courses/[id]/sprint-budget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.requireOpeningScope.mockResolvedValue({ scope, sql });
    deps.getSprintBudgetService.mockReturnValue({
      read: deps.read, acceptPlan: deps.write, proposePlan: deps.write,
      ensureAutoDraft: deps.write, createTask: deps.write,
    });
    deps.read.mockResolvedValue(preview);
    deps.mapDomainError.mockImplementation((error: unknown) => ({
      code: error instanceof Error && error.name === "ZodError" ? "VALIDATION" : "INTERNAL",
      status: error instanceof Error && error.name === "ZodError" ? 400 : 500,
      message: "safe error",
    }));
    deps.jsonError.mockImplementation((error: { status: number; code: string; message: string }) =>
      Response.json({ error: { code: error.code, message: error.message } }, { status: error.status }));
  });
  afterEach(() => {
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.getPlanningService).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(sql.begin).not.toHaveBeenCalled();
    expect(sql.unsafe).not.toHaveBeenCalled();
  });

  it("uses only the authenticated scope and SQL handle, returns the preview, and disables caching", async () => {
    const incoming = new Request(`${request().url}?workspaceId=foreign&ownerUserId=foreign&courseId=foreign&accept=true`);
    const response = await route.GET(incoming, context());
    expect(deps.requireOpeningScope).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(deps.getSprintBudgetService).toHaveBeenCalledExactlyOnceWith(sql);
    expect(deps.read).toHaveBeenCalledExactlyOnceWith(scope, courseId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-disposition")).toBe(false);
    expect(await response.json()).toEqual(preview);
    expect(deps.mapDomainError).not.toHaveBeenCalled();
  });

  it("canonicalizes a valid upper-case UUID before looking up the course's stored goal", async () => {
    const response = await route.GET(request(), context(courseId.toUpperCase()));
    expect(response.status).toBe(200);
    expect(deps.read).toHaveBeenCalledExactlyOnceWith(scope, courseId);
  });

  it.each([
    "not-a-uuid", "a1111111111141118111111111111111", `{${courseId}}`,
    ` ${courseId}`, `${courseId} `, `${courseId}/other`, "",
  ])("rejects malformed course ID %j without constructing a budget service", async id => {
    const response = await route.GET(request(), context(id));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "VALIDATION", message: "safe error" } });
    expect(deps.requireOpeningScope).toHaveBeenCalledOnce();
    expect(deps.getSprintBudgetService).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.mapDomainError).toHaveBeenCalledWith(expect.objectContaining({ name: "ZodError" }));
    expect(deps.jsonError).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, code: "UNAUTHENTICATED" },
    { status: 403, code: "WORKSPACE_FORBIDDEN" },
  ])("authenticates before ID parsing and propagates mapped $status failures with no-store", async mapped => {
    const failure = new Error("identity unavailable");
    deps.requireOpeningScope.mockRejectedValue(failure);
    deps.mapDomainError.mockReturnValue({ ...mapped, message: "denied" });
    const response = await route.GET(request(), context("invalid-even-before-auth"));
    expect(response.status).toBe(mapped.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: mapped.code, message: "denied" } });
    expect(deps.mapDomainError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(deps.getSprintBudgetService).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "factory", status: 503, code: "CONFIGURATION" },
    { stage: "read", status: 404, code: "NOT_FOUND" },
    { stage: "read", status: 500, code: "INTERNAL" },
  ])("maps $stage failure to $status without retrying, drafting, or returning partial data", async mapped => {
    const failure = new Error("private storage detail");
    deps.mapDomainError.mockReturnValue({ status: mapped.status, code: mapped.code, message: "unavailable" });
    if (mapped.stage === "factory") deps.getSprintBudgetService.mockImplementation(() => { throw failure; });
    else deps.read.mockRejectedValue(failure);
    const response = await route.GET(request(), context());
    expect(response.status).toBe(mapped.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: mapped.code, message: "unavailable" } });
    expect(deps.mapDomainError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(deps.getSprintBudgetService).toHaveBeenCalledOnce();
    expect(deps.read).toHaveBeenCalledTimes(mapped.stage === "read" ? 1 : 0);
  });

  it("exports no mutation handlers", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(route).not.toHaveProperty(method);
  });
});
