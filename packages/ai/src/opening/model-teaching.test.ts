import { describe, expect, it } from "vitest";
import { buildModelTeachingInput, compileModelTeaching } from "./model-teaching";
import type { SourceChunk } from "@aistudy/contracts";

const chunk: SourceChunk = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", sourceId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", sourceVersion: 3, page: 2, text: "rank + nullity = number of columns", startMs: null, endMs: null, slideLabel: null, imageObjectKey: null };
const lesson = { title: "Rank", goals: ["Explain the identity"], outline: ["Rank and nullity"], blocks: [
  { type: "text", text: "rank + nullity = number of columns", citedChunkIds: [chunk.id] },
  { type: "prompt", text: "Try a matrix independently.", citedChunkIds: [] },
] };
const compile = (raw: unknown, chunks = [chunk]) => compileModelTeaching({ text: JSON.stringify(raw), chunks,
  activityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", teachingUnitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  expectedContentVersion: 2, revisionNumber: 3, newId: () => crypto.randomUUID() });

describe("model-backed teaching", () => {
  it("consumes actual generated content and anchors the exact sent source version", () => {
    const result = compile(lesson);
    expect(result.blocks[0]!.content.text).toBe(lesson.blocks[0]!.text);
    expect(result.publishInput.sourceRefs).toEqual([{ sourceId: chunk.sourceId, version: 3, chunkId: chunk.id, page: 2 }]);
    expect(result.publishInput.verificationStatus).toBe("needs_check");
    expect(result.publishInput.generationConfig?.extras?.modelGenerated).toBe(true);
    expect(result.blocks[1]!.role).toBe("prompt");
  });
  it.each([{ stub: true }, { compiler: "teaching-compiler" }, { ...lesson, blocks: [] }, { ...lesson, mastery: 0.99 }])("rejects placeholders and unexpected authority fields", raw => {
    expect(() => compile(raw)).toThrow();
  });
  it("rejects citations not in the actual provider context", () => {
    expect(() => compile(lesson, [])).toThrow("unauthorized");
  });
  it("does not pretend general content is sourced or verified", () => {
    const result = compile({ ...lesson, blocks: lesson.blocks.map(b => ({ ...b, citedChunkIds: [] })) }, []);
    expect(result.publishInput.sourceRefs).toEqual([]);
    expect(result.publishInput.generationConfig?.extras?.noMaterials).toBe(true);
    expect(result.publishInput.verificationStatus).toBe("needs_check");
  });
  it("builds a substantive instruction and authorized material input", () => {
    const input = buildModelTeachingInput("秩与零空间", [chunk]);
    expect(input.text).toContain("秩与零空间");
    expect(input.chunks).toEqual([chunk]);
    expect(input.maxOutputTokens).toBeGreaterThan(256);
    expect(input.instruction).toContain("independent learner prompt");
  });
});
