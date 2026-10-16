import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { record, requireScope } = vi.hoisted(() => ({ record: vi.fn(), requireScope: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(), recordOpeningSuggestionFeedback: record }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: requireScope }));
import { ApiError } from "../../../../../../features/auth/service";
import { POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" }, sql = {};
const input = { draftId: "00000000-0000-4000-8000-000000000001", expectedDraftVersion: 0,
  suggestionKey: "planner:2026-10-16:review_cards:none:none", clientKey: "feedback-one" };
const request = (body: unknown = input) => new Request("http://x/api/opening/plans/suggestions/feedback", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => { vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1"); record.mockReset(); requireScope.mockReset();
  requireScope.mockResolvedValue({ scope, sql }); record.mockResolvedValue({ feedbackId: input.draftId }); });
afterEach(() => vi.unstubAllEnvs());
it("authenticates before accepting feedback and keeps the disabled path closed", async () => {
  requireScope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
  expect((await POST(request())).status).toBe(401); expect(record).not.toHaveBeenCalled();
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "0");
  expect((await POST(request())).status).toBe(404); expect(record).not.toHaveBeenCalled();
});
it("passes only authenticated ownership and rejects invented server metadata before writes", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(record).toHaveBeenCalledExactlyOnceWith(sql, scope, input);
  record.mockClear();
  expect((await POST(request({ ...input, requirementKey: "invented" }))).status).toBe(400);
  expect(record).not.toHaveBeenCalled();
});
it("rejects oversized bodies before feedback work", async () => {
  const oversized = request({ ...input, extra: "x".repeat(9000) });
  expect((await POST(oversized)).status).toBe(413); expect(record).not.toHaveBeenCalled();
});
