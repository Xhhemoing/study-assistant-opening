import { describe, expect, it, vi } from "vitest";
import { acceptPlanInputSchema, planDraftSchema, type ConversationPlanInput } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";
import { createConversationPlanController, type ConversationPlanApi } from "./conversation-plan-controller";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function draft() {
  const suggestion = (n: number) => ({ id: id(n), key: `suggestion-key-${n}`, kind: "review_cards", title: `Review ${n}`, minutes: 20,
    courseId: null, skillLabel: null, reasonCode: "review_cards", reason: "Due cards" });
  return planDraftSchema.parse({ id: id(1), date: "2026-11-11", version: 0, baseVersion: 4, status: "draft",
    blocks: [{ taskId: id(3), start: "2026-11-11T10:00:00.000Z", end: "2026-11-11T10:20:00.000Z", reason: "scheduled" },
      { taskId: id(8), start: "2026-11-11T11:00:00.000Z", end: "2026-11-11T11:20:00.000Z", reason: "existing task" }],
    unscheduledTaskIds: [id(2)], suggestedTasks: [suggestion(2), suggestion(3)] });
}
function fixture() {
  const accept = vi.fn(async (_input: unknown) => ({ ...draft(), status: "accepted" as const }));
  const api: ConversationPlanApi = { inspectConversationPlan: vi.fn(), proposeConversationPlan: vi.fn(), acceptPlan: accept, rejectPlan: vi.fn() };
  const key = vi.fn().mockReturnValueOnce("acceptance-key-one").mockReturnValueOnce("acceptance-key-two");
  return { accept, api, key, controller: createConversationPlanController(api, key) };
}

describe("conversation plan: accept only suggestions present in scheduled blocks", () => {
  it("excludes the unscheduled suggestion and unrelated existing block by task identity, not suggestion position", async () => {
    const f = fixture(), input = draft(), before = structuredClone(input);
    await f.controller.accept(input);
    expect(f.accept).toHaveBeenCalledExactlyOnceWith({ draftId: id(1), expectedBaseVersion: 4, acceptSuggestedKeys: ["suggestion-key-3"], clientKey: "acceptance-key-one" });
    expect(acceptPlanInputSchema.parse(f.accept.mock.calls[0]![0])).toMatchObject({ acceptSuggestedKeys: ["suggestion-key-3"] });
    expect(input).toEqual(before); expect(f.controller.hasUnknownAcceptance()).toBe(false);
  });
  it("sends an explicit empty selection when no suggestion is scheduled instead of omitting the field (which means all)", async () => {
    const f = fixture(), input = draft(); input.blocks = input.blocks.filter(block => block.taskId === id(8));
    await f.controller.accept(input);
    expect(f.accept.mock.calls[0]![0]).toEqual({ draftId: id(1), expectedBaseVersion: 4, acceptSuggestedKeys: [], clientKey: "acceptance-key-one" });
  });
  it("selects each scheduled suggestion once even when multiple blocks reference it and preserves suggestion order", async () => {
    const f = fixture(), input = draft();
    input.blocks.push({ ...input.blocks[0]!, taskId: id(2) }, { ...input.blocks[0]! });
    await f.controller.accept(input);
    expect(f.accept.mock.calls[0]![0]).toMatchObject({ acceptSuggestedKeys: ["suggestion-key-2", "suggestion-key-3"] });
  });
  it("keeps original selected keys, draft and base version on explicit retry after an uncertain acceptance", async () => {
    const f = fixture(); f.accept.mockRejectedValueOnce(new Error("reply lost"));
    await expect(f.controller.accept(draft())).rejects.toThrow("reply lost");
    expect(f.controller.hasUnknownAcceptance()).toBe(true); expect(f.accept).toHaveBeenCalledOnce();
    const changed = draft(); changed.id = id(9); changed.baseVersion = 8; changed.blocks = [];
    await f.controller.accept(changed);
    expect(f.accept.mock.calls.map(call => call[0])).toEqual([
      { draftId: id(1), expectedBaseVersion: 4, acceptSuggestedKeys: ["suggestion-key-3"], clientKey: "acceptance-key-one" },
      { draftId: id(1), expectedBaseVersion: 4, acceptSuggestedKeys: ["suggestion-key-3"], clientKey: "acceptance-key-one" },
    ]);
    expect(f.key).toHaveBeenCalledOnce(); expect(f.controller.hasUnknownAcceptance()).toBe(false);
  });
  it("after a definite acceptance conflict, recomputes the corrected selection with a new key", async () => {
    const f = fixture(); f.accept.mockRejectedValueOnce(new OpeningApiError(409, "plan moved"));
    await expect(f.controller.accept(draft())).rejects.toThrow("plan moved");
    expect(f.controller.hasUnknownAcceptance()).toBe(false);
    const changed = draft(); changed.baseVersion = 5; changed.blocks = [{ ...changed.blocks[0]!, taskId: id(2) }];
    await f.controller.accept(changed);
    expect(f.accept.mock.calls[1]![0]).toEqual({ draftId: id(1), expectedBaseVersion: 5, acceptSuggestedKeys: ["suggestion-key-2"], clientKey: "acceptance-key-two" });
    expect(f.key).toHaveBeenCalledTimes(2);
  });
  it("does not let an unrelated proposal success clear uncertain acceptance selection", async () => {
    const f = fixture(); f.accept.mockRejectedValueOnce(new Error("reply lost"));
    await expect(f.controller.accept(draft())).rejects.toThrow();
    vi.mocked(f.api.proposeConversationPlan).mockResolvedValueOnce({ kind: "no_change" });
    const input: Omit<ConversationPlanInput, "clientKey"> = { candidateId: id(7), expectedVersion: 0, date: "2026-11-11", expectedAcceptedVersion: 4, courseId: null };
    await f.controller.propose(input); expect(f.controller.hasUnknownAcceptance()).toBe(true);
    const changed = draft(); changed.blocks = [];
    await f.controller.accept(changed);
    expect(f.accept.mock.calls[1]![0]).toMatchObject({ acceptSuggestedKeys: ["suggestion-key-3"], clientKey: "acceptance-key-one" });
  });
});
