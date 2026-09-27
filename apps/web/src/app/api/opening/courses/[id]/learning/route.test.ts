import { beforeEach, describe, expect, it, vi } from "vitest";

const summarizeLearning = vi.hoisted(() => vi.fn());
const requireOpeningScope = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../features/opening/runtime", () => ({
  getLearningReadService: vi.fn(() => ({ summarizeLearning })),
  requireOpeningScope,
}));

import { GET } from "./route";

const COURSE = "11111111-1111-4111-8111-111111111111";
const scope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
};

function get(): Request {
  return new Request(`http://localhost/api/opening/courses/${COURSE}/learning`);
}

describe("GET /api/opening/courses/[id]/learning", () => {
  beforeEach(() => {
    summarizeLearning.mockReset();
    requireOpeningScope.mockReset();
    requireOpeningScope.mockResolvedValue({ scope, sql: {} });
  });

  it("returns a genuine empty summary for an owned course", async () => {
    summarizeLearning.mockResolvedValue([]);
    const response = await GET(get(), { params: Promise.resolve({ id: COURSE }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(summarizeLearning).toHaveBeenCalledWith(scope, COURSE);
  });

  it("returns 404 when the course is not owned", async () => {
    summarizeLearning.mockRejectedValue(
      Object.assign(new Error("course not found"), { code: "NOT_FOUND" }),
    );
    const response = await GET(get(), { params: Promise.resolve({ id: COURSE }) });
    expect(response.status).toBe(404);
  });

  it("keeps backend unavailability as 503", async () => {
    summarizeLearning.mockRejectedValue(
      Object.assign(new Error("database unavailable"), { code: "UNAVAILABLE" }),
    );
    const response = await GET(get(), { params: Promise.resolve({ id: COURSE }) });
    expect(response.status).toBe(503);
  });

  it("does not invent a summary when authentication fails", async () => {
    const { ApiError } = await import("../../../../../../features/auth/service");
    requireOpeningScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "login required", 401));
    const response = await GET(get(), { params: Promise.resolve({ id: COURSE }) });
    expect(response.status).toBe(401);
    expect(summarizeLearning).not.toHaveBeenCalled();
  });
});
