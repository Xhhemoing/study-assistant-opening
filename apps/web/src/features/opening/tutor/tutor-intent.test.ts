import { describe, expect, it, vi } from "vitest";
import type { OpeningConversationRepository } from "@aistudy/database";
import { DEFAULT_STUDY_SESSION_INTENT } from "@aistudy/domain";
import { createTutorService } from "./tutor-service";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const conversationId = "33333333-3333-4333-8333-333333333333";
const activityId = "44444444-4444-4444-8444-444444444444";
const request = { conversationId, clientKey: "automatic-turn-1", sourceIds: [], privacy: "saved" as const };

function fixture() {
  const appendSavedTurn = vi.fn(async () => ({ jobId: "job", turnId: "turn", assistantTurnId: "assistant" }));
  const findTurnByClientKey = vi.fn<OpeningConversationRepository["findTurnByClientKey"]>(async () => null);
  const loadContinuityTurns = vi.fn(async () => [{ role: "user" as const, text: "今天的学习计划是什么？", citations: [] }]);
  const sessionIntent = vi.fn(async () => ({ intent: { ...DEFAULT_STUDY_SESSION_INTENT, explanationStyle: "full" as const }, action: "continue" as const }));
  const service = createTutorService({
    conversations: { getOwned: async () => ({ courseId: null }), appendSavedTurn, findTurnByClientKey, loadContinuityTurns } as unknown as OpeningConversationRepository,
    sourceChunks: { listForSources: async () => [] } as never,
    readSelection: async () => null,
    studyContext: { sessionIntent: sessionIntent as never },
    systemQueryEnabled: () => true,
  });
  return { service, appendSavedTurn, findTurnByClientKey, sessionIntent };
}

describe("saved tutor automatic intent", () => {
  it.each([
    ["解释这个证明", "explain", undefined],
    ["先别给答案，只给提示", "hint", undefined],
    ["线性代数，10天后期末，每天60分钟，帮我做学习计划", "explain", "plan"],
  ] as const)("resolves %s before persisting the turn", async (text, mode, purpose) => {
    const f = fixture();
    await f.service.submitTurn(scope, { ...request, text });
    expect(f.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({ mode, purpose }));
  });

  it("uses a confirmed full-explanation preference ahead of the activity hint default", async () => {
    const f = fixture();
    await f.service.submitTurn(scope, { ...request, text: "继续", contextAnchor: { purpose: "learning_help", activityId } });
    expect(f.sessionIntent).toHaveBeenCalledOnce();
    expect(f.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({ mode: "explain" }));
  });

  it("preserves resolved defaults on retry and still passes explicit changes to the replay guard", async () => {
    const f = fixture();
    f.findTurnByClientKey.mockResolvedValue({ userTurnId: "turn", jobId: "job", assistantTurnId: "assistant", learningSessionId: null, mode: "hint", purpose: "answer", querySystem: false });
    await f.service.submitTurn(scope, { ...request, text: "继续", contextAnchor: { purpose: "learning_help", activityId } });
    expect(f.sessionIntent).not.toHaveBeenCalled();
    expect(f.appendSavedTurn).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "hint", purpose: "answer" }));
    await f.service.submitTurn(scope, { ...request, text: "继续", mode: "explain" });
    expect(f.appendSavedTurn).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "explain", purpose: "answer" }));
  });

  it("routes record follow-ups to the existing read path without a learning session", async () => {
    const f = fixture();
    await f.service.submitTurn(scope, { ...request, text: "明天呢", purpose: "answer" });
    expect(f.appendSavedTurn).toHaveBeenCalledWith(expect.objectContaining({ purpose: "query", querySystem: true, learningSessionId: null, attemptId: null }));
    expect(f.sessionIntent).not.toHaveBeenCalled();
  });

  it("does not let changed conversation history turn a replay into a record query", async () => {
    const f = fixture();
    f.findTurnByClientKey.mockResolvedValue({ userTurnId: "turn", jobId: "job", assistantTurnId: "assistant", learningSessionId: null, mode: "explain", querySystem: false });
    await f.service.submitTurn(scope, { ...request, text: "明天呢" });
    expect(f.appendSavedTurn.mock.calls[0]?.[0]).not.toHaveProperty("querySystem");
  });
});
