import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ principal: vi.fn(), count: vi.fn(), delivery: vi.fn() }));
vi.mock("../../../../server/runtime", () => ({ getAuthRuntime: () => ({ cards: {} }) }));
vi.mock("../../../../features/auth/service", () => ({ requirePrincipal: mocks.principal, mapDomainError: (error: unknown) => error, jsonError: () => Response.json({ error: "unauthorized" }, { status: 401 }) }));
vi.mock("../../../../features/review/review-service", () => ({ countDueReviewsForPrincipal: mocks.count }));
vi.mock("../../../../features/opening/server/content-delivery", () => ({ openingContentDelivery: mocks.delivery }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); mocks.principal.mockResolvedValue({ userId: "owner", workspaceId: "workspace" }); mocks.count.mockResolvedValue({ count: 7 }); });
it("returns private metadata without delivering content or exposure receipts", async () => {
  const response = await GET(new Request("https://study.test/api/reviews/count"));
  expect(await response.json()).toEqual({ count: 7 });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.delivery).not.toHaveBeenCalled();
});
it("requires the session before reading the queue", async () => {
  mocks.principal.mockRejectedValue(new Error("unauthenticated"));
  expect((await GET(new Request("https://study.test/api/reviews/count"))).status).toBe(401);
  expect(mocks.count).not.toHaveBeenCalled();
});
