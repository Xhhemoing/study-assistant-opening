import { describe, expect, it } from "vitest";
import { messagesFromResume, resolveChatMessages } from "./message-model";

const U = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

describe("message-model", () => {
  it("maps resume boundedHistory without inventing roles", () => {
    const { messages, historyTruncated } = messagesFromResume({
      conversationId: U,
      courseId: null,
      sourceIds: [S],
      boundedHistory: [
        { role: "user", text: "q" },
        { role: "assistant", text: "a" },
      ],
      historyTruncated: true,
    });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(historyTruncated).toBe(true);
  });

  it("prefers turn records with citation labels when available", () => {
    const { messages } = resolveChatMessages({
      resume: {
        conversationId: U,
        courseId: null,
        sourceIds: [S],
        boundedHistory: [{ role: "user", text: "old" }],
        historyTruncated: false,
      },
      turns: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          conversationId: U,
          role: "assistant",
          text: "answer",
          citations: [
            {
              chunkId: "44444444-4444-4444-8444-444444444444",
              sourceId: S,
              sourceVersion: 0,
              label: "p.2",
            },
          ],
          createdAt: "2026-09-13T12:00:00.000Z",
          mode: "explain",
          status: "complete",
        },
      ],
    });
    expect(messages[0]?.citationLabels).toEqual(["p.2"]);
    expect(messages[0]?.text).toBe("answer");
  });
});
