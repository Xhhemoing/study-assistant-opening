import { describe, expect, it } from "vitest";
import {
  savedTurnRetryAssistantId, savedTurnRetryMatches, type SavedTurnRetryIntent,
} from "./opening-conversation-retry";

const assistantId = "11111111-1111-4111-8111-111111111111";
const sourceA = "22222222-2222-4222-8222-222222222222";
const sourceB = "33333333-3333-4333-8333-333333333333";
const chunkId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const otherId = "77777777-7777-4777-8777-777777777777";

const original = {
  text: "按原资料解释第四页", mode: "hint", sourceIds: [sourceA, sourceB],
  sourceVersions: { [sourceA]: 2, [sourceB]: 3 }, currentPage: 4, chunkId,
  learningSessionId: sessionId, attemptId, strategyTemplateId: "original-strategy",
  contextAnchor: { purpose: "learning_help", sourceId: sourceA, sourceVersion: 2, page: 4, chunkId, attemptId },
  purpose: "answer",
} satisfies SavedTurnRetryIntent;
type RetryInput = Parameters<typeof savedTurnRetryMatches>[0];
function submitted(): RetryInput {
  return { ...original, sourceIds: [...original.sourceIds], contextAnchor: { ...original.contextAnchor } };
}

describe("saved failed-turn handle", () => {
  it("recognizes only a full assistant UUID after the existing retry prefix", () => {
    expect(savedTurnRetryAssistantId(`retry-${assistantId}`)).toBe(assistantId);
    for (const key of [assistantId, "retry-", "retry-current-selection", `retry-${assistantId}:changed`]) {
      expect(savedTurnRetryAssistantId(key)).toBeNull();
    }
  });

  it("matches the literal persisted intent without mutating it or depending on selection order", () => {
    const before = JSON.stringify(original);
    expect(savedTurnRetryMatches(submitted(), original)).toBe(true);
    expect(savedTurnRetryMatches({ ...submitted(), sourceIds: [sourceB, sourceA, sourceA] }, original)).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });

  const replacements: Array<[string, Partial<RetryInput>]> = [
    ["text", { text: "另一个问题" }],
    ["mode", { mode: "explain" }],
    ["source ids", { sourceIds: [sourceB] }],
    ["page", { currentPage: 8 }],
    ["chunk", { chunkId: otherId }],
    ["learning session", { learningSessionId: otherId }],
    ["attempt", { attemptId: otherId }],
    ["strategy", { strategyTemplateId: "new-strategy" }],
    ["context source version", { contextAnchor: { ...original.contextAnchor, sourceVersion: 4 } }],
    ["context purpose", { contextAnchor: { ...original.contextAnchor, purpose: "language_support" } }],
    ["composer purpose", { purpose: "plan" }],
    ["system query", { querySystem: true }],
  ];
  it.each(replacements)("rejects a changed %s instead of adopting the current editor", (_field, changed) => {
    expect(savedTurnRetryMatches({ ...submitted(), ...changed }, original)).toBe(false);
  });

  it("normalizes absent optional fields only when the persisted fields were null", () => {
    const legacy: SavedTurnRetryIntent = {
      ...original, learningSessionId: null, attemptId: null, strategyTemplateId: null,
      contextAnchor: null, purpose: null,
    };
    const input: RetryInput = {
      text: legacy.text, mode: legacy.mode, sourceIds: [...legacy.sourceIds],
      currentPage: legacy.currentPage, chunkId: legacy.chunkId, learningSessionId: null,
    };
    expect(savedTurnRetryMatches(input, legacy)).toBe(true);
    expect(savedTurnRetryMatches(input, original)).toBe(false);
  });
});
