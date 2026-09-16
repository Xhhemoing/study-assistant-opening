import { describe, expect, it } from "vitest";
import {
  PROVIDER_HISTORY_MAX_TURNS,
  buildBoundedHistory,
  buildConversationResume,
  toConversationSummary,
} from "./conversation-continuity";

const U = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-09-13T12:00:00.000Z";

describe("conversation continuity (RU-02)", () => {
  it("builds discovery summary without client-seeded inventing", () => {
    expect(
      toConversationSummary({
        id: U,
        title: "inverse",
        courseId: null,
        updatedAt: ISO,
        lastTurnPreview: "step 2",
      }),
    ).toMatchObject({ id: U, title: "inverse", lastTurnPreview: "step 2" });
  });

  it("bounds provider history and sets historyTruncated", () => {
    const turns = Array.from({ length: PROVIDER_HISTORY_MAX_TURNS + 3 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `t${i}`,
    }));
    const { boundedHistory, historyTruncated } = buildBoundedHistory(turns);
    expect(historyTruncated).toBe(true);
    expect(boundedHistory).toHaveLength(PROVIDER_HISTORY_MAX_TURNS);
    expect(boundedHistory[0]?.text).toBe("t3");
    expect(buildBoundedHistory(turns.slice(0, 2)).historyTruncated).toBe(false);
  });

  it("assembles resume with boundedHistory for provider", () => {
    const result = buildConversationResume({
      conversationId: U,
      courseId: null,
      sourceIds: [S1],
      turns: [
        { role: "user", text: "step 1" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "continue step 2" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resume.boundedHistory).toHaveLength(3);
    expect(result.resume.historyTruncated).toBe(false);
    expect(result.resume.conversationId).toBe(U);
  });

  it("re-validates sticky page/chunk on resume (never trust client)", () => {
    const bad = buildConversationResume({
      conversationId: U,
      courseId: null,
      sourceIds: [S1],
      turns: [{ role: "user", text: "x" }],
      sticky: { sourceIds: [S1], currentPage: 9 },
      authorizedChunks: [{ id: C1, sourceId: S1, page: 4 }],
    });
    expect(bad).toEqual({
      ok: false,
      selection: { ok: false, code: "page_not_in_sources" },
    });

    const good = buildConversationResume({
      conversationId: U,
      courseId: null,
      sourceIds: [S1],
      turns: [{ role: "user", text: "x" }],
      sticky: { sourceIds: [S1], currentPage: 4, chunkId: C1 },
      authorizedChunks: [{ id: C1, sourceId: S1, page: 4 }],
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.resume.currentPage).toBe(4);
    expect(good.resume.chunkId).toBe(C1);
  });
});
