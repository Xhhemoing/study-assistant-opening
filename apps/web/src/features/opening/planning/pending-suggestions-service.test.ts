import { beforeEach, expect, it, vi } from "vitest";
const reads = vi.hoisted(() => ({ assistant: vi.fn(), retests: vi.fn(), proposals: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  readOpeningAssistantReviewCandidates: reads.assistant,
  readOpeningRetestReviewCandidates: reads.retests,
  createOpeningAssistantProposalsRepository: () => ({ countPending: reads.proposals }),
}));
import { countPendingSuggestions } from "./pending-suggestions-service";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const sql = {} as never;
beforeEach(() => {
  vi.resetAllMocks();
  reads.assistant.mockResolvedValue([{ workspaceId: scope.workspaceId, status: "pending" },
    { workspaceId: "other", status: "pending" }, { workspaceId: scope.workspaceId, status: "accepted" }]);
  reads.retests.mockResolvedValue([{}, {}]);
  reads.proposals.mockResolvedValue(67);
});
it("counts visible legacy candidates, retests, and every eligible new draft for one owner", async () => {
  expect(await countPendingSuggestions(sql, scope)).toBe(70);
  expect(reads.assistant).toHaveBeenCalledWith(sql, scope);
  expect(reads.retests).toHaveBeenCalledWith(sql, scope);
  expect(reads.proposals).toHaveBeenCalledWith(scope);
});
it.each(["assistant", "retests", "proposals"] as const)("preserves an unavailable %s read instead of reporting zero", async kind => {
  reads[kind].mockRejectedValue(new Error("database unavailable"));
  await expect(countPendingSuggestions(sql, scope)).rejects.toThrow("database unavailable");
});
