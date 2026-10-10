import { describe, expect, it } from "vitest";
import { conversationResumeSchema } from "@aistudy/contracts";
import { ephemeralHistoryFromMessages, messagesFromResume, messagesFromTurns, resolveChatMessages, showsGeneralMaterialBadge } from "./message-model";

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

  it("maps outcome_unknown assistant turns without converting their status", () => {
    const { messages } = resolveChatMessages({
      resume: null,
      turns: [{
        id: "33333333-3333-4333-8333-333333333333",
        conversationId: U,
        role: "assistant",
        text: "结果状态未知，请勿重复提交",
        citations: [],
        createdAt: "2026-09-13T12:00:00.000Z",
        mode: "explain",
        status: "outcome_unknown",
      }],
    });
    expect(messages[0]?.status).toBe("outcome_unknown");
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
    expect(messages[0]?.citations).toEqual([
      {
        chunkId: "44444444-4444-4444-8444-444444444444",
        sourceId: S,
        sourceVersion: 0,
        label: "p.2",
      },
    ]);
    expect(messages[0]?.text).toBe("answer");
  });

  it("keeps full citations on resume turns instead of dropping them to empty labels", () => {
    const citation = {
      chunkId: "44444444-4444-4444-8444-444444444444",
      sourceId: S,
      sourceVersion: 3,
      label: "p.2",
    };
    const { messages } = messagesFromResume({
      conversationId: U,
      courseId: null,
      sourceIds: [S],
      boundedHistory: [
        { role: "user", text: "q" },
        { role: "assistant", text: "a", citations: [citation] },
      ],
      historyTruncated: false,
    });
    expect(messages[1]?.citations).toEqual([citation]);
    expect(messages[1]?.citationLabels).toEqual(["p.2"]);
    expect(messages[0]?.citations).toEqual([]);
  });

  it("maps parsed resume citations and defaults omitted citations to empty", () => {
    const citation = {
      chunkId: "44444444-4444-4444-8444-444444444444",
      sourceId: S,
      sourceVersion: 3,
      label: "p.2",
    };
    const parsed = conversationResumeSchema.parse({
      conversationId: U,
      courseId: null,
      sourceIds: [S],
      boundedHistory: [
        { role: "user", text: "q" },
        { role: "assistant", text: "a", citations: [citation] },
      ],
      historyTruncated: false,
    });
    const { messages } = messagesFromResume(parsed);
    expect(messages[0]?.citations).toEqual([]);
    expect(messages[1]?.citations).toEqual([citation]);
    expect(messages[1]?.citationLabels).toEqual(["p.2"]);
  });

  it("copies turn.citations onto the chat view instead of labels only", () => {
    const citation = {
      chunkId: "55555555-5555-4555-8555-555555555555",
      sourceId: S,
      sourceVersion: 2,
      label: "slide A-1",
    };
    const messages = messagesFromTurns([
      {
        id: "33333333-3333-4333-8333-333333333333",
        conversationId: U,
        role: "assistant",
        text: "sourced answer",
        citations: [citation],
        createdAt: "2026-09-13T12:00:00.000Z",
        mode: "explain",
        status: "complete",
      },
    ]);
    expect(messages[0]?.citations).toEqual([citation]);
    expect(messages[0]?.citationLabels).toEqual(["slide A-1"]);
  });
});

it("carries only ephemeral text and known provenance into bounded history", () => {
  const ephemeral = Array.from({ length: 18 }, (_, index) => ({
    id: `ephemeral-${index}`, origin: "ephemeral" as const, role: "user" as const,
    text: `message-${index}`, citations: [], citationLabels: [], provenanceId: index === 17 ? null : S,
  }));
  expect(ephemeralHistoryFromMessages(ephemeral)).toHaveLength(16);
  expect(ephemeralHistoryFromMessages(ephemeral)[0]).toEqual({ role: "user", text: "message-2", provenanceId: S });
  expect(ephemeralHistoryFromMessages(ephemeral)[15]).toEqual({ role: "user", text: "message-17" });
});

describe("showsGeneralMaterialBadge", () => {
  it("is true only for assistant turns with material context and zero citations", () => {
    expect(showsGeneralMaterialBadge({ role: "assistant", citations: [], hadMaterialContext: true })).toBe(true);
    expect(showsGeneralMaterialBadge({
      role: "assistant",
      citations: [{ chunkId: "44444444-4444-4444-8444-444444444444", sourceId: S, sourceVersion: 1, label: "p.1" }],
      hadMaterialContext: true,
    })).toBe(false);
    expect(showsGeneralMaterialBadge({ role: "assistant", citations: [], hadMaterialContext: false })).toBe(false);
    expect(showsGeneralMaterialBadge({ role: "user", citations: [], hadMaterialContext: true })).toBe(false);
  });
});
