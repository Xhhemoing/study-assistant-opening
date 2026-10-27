import { describe, expect, it } from "vitest";
import type { StudyContextAnchor, SystemQueryReceipt, TurnRecord } from "@aistudy/contracts";
import { resolveBoundConversationContext } from "./bound-conversation";
import type { StudyConversationContext } from "./study-conversation-context";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const anchor: StudyContextAnchor = { courseId: id, activityId: id, blockId: id, contentVersion: 2, attemptId: id, itemVersionId: id, kcMappingVersion: 1, sourceId: id, sourceVersion: 0, page: 2, chunkId: id, purpose: "learning_help" };
const user = (contextAnchor?: StudyContextAnchor | null): TurnRecord => ({ id, conversationId: id, role: "user", text: "为什么", mode: "hint", status: "complete", citations: [], createdAt: "2026-10-25T15:00:00.000Z", contextAnchor });

describe("owned conversation context recovery", () => {
  it("recovers a strict question from persisted user anchors without relying on query context", () => {
    expect(resolveBoundConversationContext([user(anchor)]).context).toEqual(anchor);
  });
  it("keeps persisted identity and purpose while restoring parsed display metadata", () => {
    const requested: StudyConversationContext = { attemptId: id, label: "本题", fragment: "带入的背景", returnTo: "/opening/today", purpose: "history_solution" };
    expect(resolveBoundConversationContext([user(anchor)], requested).context).toEqual({ ...anchor, label: "本题", fragment: "带入的背景", returnTo: "/opening/today" });
  });
  it.each([
    { courseId: other }, { activityId: other }, { blockId: other }, { contentVersion: 3 }, { attemptId: other },
    { itemVersionId: other }, { kcMappingVersion: 2 }, { sourceId: other }, { sourceVersion: 1 }, { page: 3 }, { chunkId: other },
  ])("blocks a query identity or version that conflicts with stored evidence: %j", requested => {
    expect(resolveBoundConversationContext([user(anchor)], requested).error).toBeTruthy();
  });
  it("does not accept a query attempt id that is absent from an existing ordinary history", () => {
    expect(resolveBoundConversationContext([user()], { attemptId: id }).error).toBeTruthy();
    expect(resolveBoundConversationContext([user({ courseId: id, purpose: "learning_help" })], { attemptId: id }).error).toBeTruthy();
  });
  it("blocks mixed question anchors and ordinary unanchored history", () => {
    expect(resolveBoundConversationContext([user(anchor), user({ ...anchor, attemptId: other })]).error).toBeTruthy();
    expect(resolveBoundConversationContext([user(), user(anchor)]).error).toBeTruthy();
    expect(resolveBoundConversationContext([user(anchor), user()]).error).toBeTruthy();
  });
  it("ignores verified query receipts for identity comparison without treating their data as learning context", () => {
    const query = { ...user(), systemQuery: { version: "study-query-v1", results: [] } as unknown as SystemQueryReceipt };
    expect(resolveBoundConversationContext([user(anchor), query]).context).toEqual(anchor);
    expect(resolveBoundConversationContext([query]).context).toBeUndefined();
    expect(resolveBoundConversationContext([query], { attemptId: id }).context).toEqual({ attemptId: id });
  });
  it("uses the latest persisted purpose when the same question changes support mode", () => {
    expect(resolveBoundConversationContext([user(anchor), user({ ...anchor, purpose: "language_support" })]).context?.purpose).toBe("language_support");
  });
  it("allows an empty new conversation to use its requested context, and ordinary history to remain ordinary", () => {
    expect(resolveBoundConversationContext([], { attemptId: id }).context).toEqual({ attemptId: id });
    expect(resolveBoundConversationContext([user()])).toEqual({});
  });
});
