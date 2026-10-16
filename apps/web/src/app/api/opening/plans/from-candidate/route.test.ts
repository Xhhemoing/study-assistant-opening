import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { requireScope, inspect, propose } = vi.hoisted(() => ({ requireScope: vi.fn(), inspect: vi.fn(), propose: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: requireScope }));
vi.mock("../../../../../features/opening/planning/conversation-plan-service", () => ({ createConversationPlanService: () => ({ inspect, propose }) }));
import { ApiError } from "../../../../../features/auth/service";
import { GET, POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
beforeEach(() => {
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1"); requireScope.mockReset().mockResolvedValue({ scope, sql: {} });
  inspect.mockReset().mockResolvedValue({ kind: "clarification" }); propose.mockReset().mockResolvedValue({ kind: "draft" });
});
afterEach(() => vi.unstubAllEnvs());
it("authenticates before reading a candidate or generating its draft", async () => {
  requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
  expect((await GET(new Request("http://x/api/opening/plans/from-candidate?candidateId=id"))).status).toBe(401);
  expect(inspect).not.toHaveBeenCalled(); expect(propose).not.toHaveBeenCalled();
});
it("keeps the disabled path closed and responses uncacheable", async () => {
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "0");
  const response = await POST(new Request("http://x/api/opening/plans/from-candidate", { method: "POST", body: "{}" }));
  expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(propose).not.toHaveBeenCalled();
});
it("passes only authenticated scope and the candidate identity to inspection", async () => {
  const response = await GET(new Request("http://x/api/opening/plans/from-candidate?candidateId=id&ownerUserId=forged"));
  expect(response.status).toBe(200); expect(inspect).toHaveBeenCalledWith(scope, "id");
});
it("uses a separate explicit POST and returns created only for a persisted draft", async () => {
  const response = await POST(new Request("http://x/api/opening/plans/from-candidate", { method: "POST", body: JSON.stringify({ candidateId: "id" }) }));
  expect(response.status).toBe(201); expect(propose).toHaveBeenCalledWith(scope, { candidateId: "id" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
