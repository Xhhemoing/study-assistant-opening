import { expect, it } from "vitest";
import { cardReviewKind, cardVariantRequestSchema, cardVariantProposalSchema } from "./reviews";

it("requires explicit classification for old manual cards and preserves mistake origins", () => {
  expect(cardReviewKind({ tags: [] })).toBeNull();
  expect(cardReviewKind({ tags: ["review:concept"] })).toBe("concept");
  expect(cardReviewKind({ tags: ["review:question"] })).toBe("question");
  expect(cardReviewKind({ tags: ["错题", "review:concept"] })).toBe("question");
  expect(cardReviewKind({ tags: ["review:concept"], originObservationRootId: "origin" })).toBe("question");
});

it("never accepts a client grade or elapsed time for variant completion", () => {
  const complete = { action: "complete", observationId: "11111111-1111-4111-8111-111111111111" };
  expect(cardVariantRequestSchema.safeParse(complete).success).toBe(true);
  for (const extra of [{ grade: "easy" }, { elapsedMs: 10 }, { assisted: false }, { activityId: complete.observationId }]) {
    expect(cardVariantRequestSchema.safeParse({ ...complete, ...extra }).success).toBe(false);
  }
  expect(cardVariantProposalSchema.safeParse({ prompt: "只有一个没有答案的新问题" }).success).toBe(false);
});
