import { describe, expect, it, vi } from "vitest";
import type { ConversationPlanInput, PlanDraft } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";
import { createConversationPlanController, type ConversationPlanApi } from "./conversation-plan-controller";
const id = "11111111-1111-4111-8111-111111111111";
const input: Omit<ConversationPlanInput, "clientKey"> = { candidateId: id, expectedVersion: 0, date: "2026-10-16", expectedAcceptedVersion: 2, courseId: null, minutes: 20 };
const draft: PlanDraft = { id, date: input.date, version: 0, baseVersion: 2, status: "draft", blocks: [], unscheduledTaskIds: [] };
const makeApi = (): ConversationPlanApi => ({ inspectConversationPlan: vi.fn(), proposeConversationPlan: vi.fn(async () => ({ kind: "draft" as const, draft })),
  acceptPlan: vi.fn(async () => ({ ...draft, status: "accepted" as const })), rejectPlan: vi.fn() });
describe("conversation proposal intent retention", () => {
  it("keeps one exact request/key after an unknown result and only retries explicitly", async () => {
    const api = makeApi(), key = vi.fn(() => "proposal-key-01"), controller = createConversationPlanController(api, key);
    vi.mocked(api.proposeConversationPlan).mockRejectedValueOnce(new Error("offline"));
    await expect(controller.propose(input)).rejects.toThrow("offline");
    expect(api.proposeConversationPlan).toHaveBeenCalledTimes(1);
    expect(controller.hasUnknownProposal()).toBe(true);
    await controller.propose({ ...input, minutes: 60, courseId: id });
    expect(vi.mocked(api.proposeConversationPlan).mock.calls[0]).toEqual(vi.mocked(api.proposeConversationPlan).mock.calls[1]);
    expect(key).toHaveBeenCalledTimes(1); expect(controller.hasUnknownProposal()).toBe(false);
  });
  it("allows corrected intent after a definite validation rejection", async () => {
    const api = makeApi(), controller = createConversationPlanController(api, () => "proposal-key-01");
    vi.mocked(api.proposeConversationPlan).mockRejectedValueOnce(new OpeningApiError(400, "invalid"));
    await expect(controller.propose(input)).rejects.toThrow("invalid");
    expect(controller.hasUnknownProposal()).toBe(false);
    await controller.propose({ ...input, minutes: 30 });
    expect(api.proposeConversationPlan).toHaveBeenLastCalledWith(expect.objectContaining({ minutes: 30 }));
  });
  it("freezes draft ID, base version and selected keys across an uncertain acceptance", async () => {
    const api = makeApi(), controller = createConversationPlanController(api, () => "acceptance-key-01");
    vi.mocked(api.acceptPlan).mockRejectedValueOnce(new Error("offline"));
    await expect(controller.accept(draft)).rejects.toThrow("offline");
    await controller.accept({ ...draft, id: "22222222-2222-4222-8222-222222222222", baseVersion: 3 });
    expect(vi.mocked(api.acceptPlan).mock.calls[0]).toEqual(vi.mocked(api.acceptPlan).mock.calls[1]);
    expect(controller.hasUnknownAcceptance()).toBe(false);
  });
});
