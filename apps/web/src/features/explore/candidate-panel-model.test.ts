import { describe, expect, it } from "vitest";
import type { PromotionCandidate } from "@aistudy/contracts";
import {
  buildCandidateNoteBlocks,
  candidateCourseDraft,
  candidateKindLabel,
  pendingCandidates,
} from "./candidate-panel-model";

const baseCandidate: PromotionCandidate = {
  id: "55555555-5555-4555-8555-555555555504",
  explorationId: "55555555-5555-4555-8555-555555555501",
  turnId: "55555555-5555-4555-8555-555555555503",
  kind: "note",
  title: "熵的直觉解释",
  body: "熵是系统混乱程度的度量。",
  status: "pending",
  promotedTargetId: null,
  createdAt: "2026-08-02T08:00:00.000Z",
};

describe("candidate panel model", () => {
  it("keeps only pending candidates in creation order", () => {
    expect(pendingCandidates([
      baseCandidate,
      { ...baseCandidate, id: "55555555-5555-4555-8555-555555555505", status: "rejected" },
      { ...baseCandidate, id: "55555555-5555-4555-8555-555555555506", status: "promoted" },
    ])).toEqual([baseCandidate]);
  });

  it("builds a note block with exploration provenance", () => {
    expect(buildCandidateNoteBlocks(baseCandidate, "熵到到底是什么")).toEqual([
      expect.objectContaining({
        type: "paragraph",
        content: expect.objectContaining({
          blockNoteContent: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("来源：探索「熵到到底是什么」"),
            }),
          ]),
        }),
      }),
    ]);
  });

  it("labels candidate kinds for the review surface", () => {
    expect(candidateKindLabel("note")).toBe("笔记候选");
    expect(candidateKindLabel("question")).toBe("题目候选");
  });

  it("derives a course draft from a candidate with a fallback slug", () => {
    const draft = candidateCourseDraft(baseCandidate, 1730000000000);
    expect(draft.title).toBe("熵的直觉解释");
    expect(draft.slug).toMatch(/^promoted-/);
    expect(draft.description).toBe("熵是系统混乱程度的度量。");
  });

  it("keeps an ascii candidate title as the course slug", () => {
    const draft = candidateCourseDraft({ ...baseCandidate, title: "Entropy Intuition" }, 1730000000000);
    expect(draft.slug).toBe("entropy-intuition");
  });

  it("truncates a long candidate body to the description limit", () => {
    const draft = candidateCourseDraft({ ...baseCandidate, body: "x".repeat(800) }, 1);
    expect(draft.description.length).toBe(500);
  });
});
