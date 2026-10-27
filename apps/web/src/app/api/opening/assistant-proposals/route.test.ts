import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), list: vi.fn(), pending: vi.fn(), count: vi.fn() }));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../features/opening/assistant/proposal-service", () => ({ createAssistantProposalService: () => ({ list: mocks.list, listPending: mocks.pending, countPending: mocks.count }) }));
vi.mock("../../../../features/opening/planning/pending-suggestions-service", () => ({ countPendingSuggestions: mocks.count }));
import { ApiError } from "../../../../features/auth/service";
import { GET } from "./route";
import { GET as getReviews } from "../reviews/route";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const conversationId = "33333333-3333-4333-8333-333333333333";
const request = (query = "") => new Request(`http://localhost/api/opening/assistant-proposals${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ scope, sql: {} });
  mocks.list.mockResolvedValue([{ id: "legacy" }]);
  mocks.pending.mockResolvedValue({ proposals: [], total: 67, nextCursor: "next_cursor" });
  mocks.count.mockResolvedValue(70);
});
it("preserves no-query GET and forwards authenticated pending filters without slicing", async () => {
  expect(await (await GET(request())).json()).toEqual({ proposals: [{ id: "legacy" }] });
  const response = await GET(request(`?status=draft&conversationId=${conversationId}&cursor=prior_cursor`));
  expect(await response.json()).toEqual({ proposals: [], total: 67, nextCursor: "next_cursor" });
  expect(mocks.pending).toHaveBeenCalledWith(scope, { conversationId, cursor: "prior_cursor" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("rejects unbounded or injected query scope before querying", async () => {
  for (const query of ["?status=accepted", "?status=draft&conversationId=invalid", `?status=draft&cursor=${"x".repeat(513)}`, `?status=draft&ownerUserId=${scope.ownerUserId}`]) {
    expect((await GET(request(query))).status).toBe(400);
  }
  expect(mocks.pending).not.toHaveBeenCalled();
});
it("does not expose a foreign conversation or convert read failures into an empty inbox", async () => {
  mocks.pending.mockRejectedValue(Object.assign(new Error("conversation not found"), { code: "NOT_FOUND" }));
  expect((await GET(request(`?status=draft&conversationId=${conversationId}`))).status).toBe(404);
  mocks.count.mockRejectedValue(new Error("database unavailable"));
  expect((await getReviews(request())).status).toBe(500);
});
it("returns the shared pending count for the authenticated owner", async () => {
  const response = await getReviews(request());
  expect(await response.json()).toEqual({ total: 70 });
  expect(mocks.count).toHaveBeenCalledWith({}, scope);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("authenticates before reading either list or its total", async () => {
  mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "sign in", 401));
  expect((await GET(request("?status=draft"))).status).toBe(401);
  expect((await getReviews(request())).status).toBe(401);
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.count).not.toHaveBeenCalled();
});
