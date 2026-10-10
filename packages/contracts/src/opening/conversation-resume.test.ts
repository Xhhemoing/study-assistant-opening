import { expect, it } from "vitest";
import {
  conversationResumeSchema,
  providerHistoryMessageSchema,
} from "./conversations";

const U = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const citation = {
  chunkId: C,
  sourceId: S,
  sourceVersion: 1,
  label: "p.2",
};

const baseResume = {
  conversationId: U,
  courseId: null,
  sourceIds: [S],
  historyTruncated: false,
};

it("keeps resume citations and accepts legacy history without citations", () => {
  const withLocators = { ...citation, page: 2, startMs: 0, slideLabel: "S1" };
  const withCitations = conversationResumeSchema.parse({
    ...baseResume,
    boundedHistory: [{ role: "assistant", text: "a", citations: [withLocators] }],
  });
  expect(withCitations.boundedHistory[0]?.citations).toEqual([withLocators]);

  const legacy = conversationResumeSchema.parse({
    ...baseResume,
    boundedHistory: [{ role: "user", text: "continue step 2" }],
  });
  expect(legacy.boundedHistory[0]?.citations ?? []).toEqual([]);
});

it("rejects malformed resume citations", () => {
  expect(
    conversationResumeSchema.safeParse({
      ...baseResume,
      boundedHistory: [
        {
          role: "assistant",
          text: "a",
          citations: [{ chunkId: C, sourceId: S, sourceVersion: 1, label: "p.2", extra: true }],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    conversationResumeSchema.safeParse({
      ...baseResume,
      boundedHistory: [{ role: "assistant", text: "a", citations: [{ label: "p.2" }] }],
    }).success,
  ).toBe(false);
});

it("keeps provider history strict role/text without citations", () => {
  expect(providerHistoryMessageSchema.safeParse({ role: "assistant", text: "a" }).success).toBe(
    true,
  );
  expect(
    providerHistoryMessageSchema.safeParse({
      role: "assistant",
      text: "a",
      citations: [citation],
    }).success,
  ).toBe(false);
  expect(
    providerHistoryMessageSchema.safeParse({
      role: "assistant",
      text: "a",
      citations: [],
    }).success,
  ).toBe(false);
});
