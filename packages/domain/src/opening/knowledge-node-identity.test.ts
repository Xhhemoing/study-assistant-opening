import { describe, expect, it } from "vitest";
import type { KnowledgeNode } from "@aistudy/contracts";
import { sameKnowledgeNodeIdentity } from "./knowledge-node-identity";

const original: KnowledgeNode = { id: "node", courseId: "course", label: "Integral substitution", kind: "procedure",
  evidenceChunkIds: ["chunk-b", "chunk-a"], status: "supported" };

describe("knowledge node identity", () => {
  it("ignores evidence order and verification status, without guessing from nearby labels", () => {
    expect(sameKnowledgeNodeIdentity(original, { ...original, evidenceChunkIds: ["chunk-a", "chunk-b"], status: "needs_check" })).toBe(true);
    for (const change of [{ label: "Integral substitutions" }, { kind: "concept" as const }, { courseId: "other-course" },
      { evidenceChunkIds: ["replacement-version-chunk"] }]) {
      expect(sameKnowledgeNodeIdentity(original, { ...original, ...change })).toBe(false);
    }
  });
});
