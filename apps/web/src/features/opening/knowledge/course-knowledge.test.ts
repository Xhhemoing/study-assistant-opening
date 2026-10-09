import { describe, expect, it } from "vitest";
import { chaptersFirst, nextStepCopy } from "./course-knowledge";
import { evidenceTargetsForNode } from "./knowledge-evidence";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("course-knowledge helpers", () => {
  it("orders chapters before concepts and never invents mastery copy", () => {
    const ordered = chaptersFirst([
      { id: id(1), courseId: id(9), label: "概念", kind: "concept", evidenceChunkIds: [], status: "suggested" },
      { id: id(2), courseId: id(9), label: "第一章", kind: "chapter", evidenceChunkIds: [id(3)], status: "supported" },
    ]);
    expect(ordered[0]?.kind).toBe("chapter");
    expect(nextStepCopy([])).toMatch(/章节/);
    expect(nextStepCopy([{ reason: "先做独立变式" }])).toBe("先做独立变式");
  });

  it("builds material / video / problem / evidence targets", () => {
    const targets = evidenceTargetsForNode({
      id: id(1),
      courseId: id(9),
      label: "题型A",
      kind: "problem_type",
      evidenceChunkIds: [id(4)],
    });
    expect(targets.some((t) => t.kind === "material")).toBe(true);
    expect(targets.some((t) => t.kind === "problem")).toBe(true);
    expect(targets.some((t) => t.kind === "evidence")).toBe(true);
    expect(targets.some((t) => t.kind === "video")).toBe(true);
  });
});
