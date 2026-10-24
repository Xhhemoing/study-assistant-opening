import { describe, expect, it, vi } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import type { TeachingOutline } from "@aistudy/domain";
import { createCompilerBuildPublishInput, createCompilerProviderInput } from "./teaching-compiler";
import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";

const ACTIVITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNIT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const outline: TeachingOutline = { kind: "teaching_path", activityId: ACTIVITY, outlineId: "saved", focusItemId: "inverse",
  items: [{ itemId: "real", title: "实数", goalIds: [], intendedBlockTypes: ["text"], sourceIds: [SOURCE] },
    { itemId: "inverse", title: "用户确认的反函数单元", goalIds: ["inverse-goal"], intendedBlockTypes: ["text", "prompt"], sourceIds: [SOURCE] }], prereqs: [] };
const chunk = (sourceId: string): SourceChunk => ({ id: sourceId, sourceId, sourceVersion: 1, page: 1, text: `资料 ${sourceId}`,
  slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });
const payload = { activityId: ACTIVITY, teachingUnitId: UNIT, expectedContentVersion: 0, sourceIds: [SOURCE, OTHER] };
const hints = { direction: "先辨认函数。", concept: "考虑定义域与值域。", firstStep: "将因变量写在等式左侧。" };
const output = { itemTitles: ["模型试图重命名"], blocks: [
  { type: "text", text: "说明反函数的定义。" },
  { type: "prompt", text: "反函数的定义是什么？" }, { type: "answer_key", text: "在限定定义域内逆转映射。", hints, ...rankPedagogy },
  { type: "prompt", text: "反函数定义域如何选择？" }, { type: "answer_key", text: "使用原函数的值域。", hints, ...rankPedagogy },
] };

describe("saved outline compile and evidence continuity", () => {
  it("sends and republishes the saved focus/title, ignoring model outline and title replacement", async () => {
    const options = { readOutline: () => outline, loadChunks: async () => [chunk(SOURCE), chunk(OTHER)], requireModelOutput: true };
    const prompt = await createCompilerProviderInput(options)({}, payload);
    expect(prompt.text).toContain("用户确认的反函数单元");
    expect(prompt.chunks.map(item => item.sourceId)).toEqual([SOURCE]);
    const published = await createCompilerBuildPublishInput({ ...options, evidenceChunks: prompt.chunks })({}, payload,
      { text: JSON.stringify({ ...output, outline: { ...outline, activityId: OTHER } }) });
    expect(published.activityId).toBe(ACTIVITY);
    expect(published.generationConfig?.extras).toMatchObject({ focusItemId: "inverse", focusItemTitle: "用户确认的反函数单元",
      outline: { outlineId: "saved", focusItemId: "inverse" } });
  });
  it("does not accept a model-created outline for a first/legacy production compile", async () => {
    const result = await createCompilerBuildPublishInput({ requireModelOutput: true })({}, payload,
      { text: JSON.stringify({ ...output, outline: { ...outline, activityId: OTHER, focusItemId: "real" } }) });
    expect(result.activityId).toBe(ACTIVITY);
    expect(result.generationConfig?.extras?.outlineId).toBe(`outline-${ACTIVITY}`);
  });
  it("restricts retrieval and even a wider retriever response to the focus sources", async () => {
    const retrieveContext = vi.fn(async () => ({ chunks: [chunk(SOURCE), chunk(OTHER)], mode: "hybrid" as const }));
    const result = await createCompilerProviderInput({ readOutline: () => outline, retrieveContext,
      loadChunks: async () => [chunk(SOURCE), chunk(OTHER)] })({}, payload);
    expect(retrieveContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceIds: [SOURCE], chunks: [chunk(SOURCE)] }));
    expect(result.chunks).toEqual([chunk(SOURCE)]);
  });
  it("treats a no-source focus as no evidence, not as all activity sources", async () => {
    const result = await createCompilerProviderInput({ readOutline: () => ({ ...outline,
      items: outline.items.map(item => ({ ...item, sourceIds: [] })) }), loadChunks: async () => [chunk(SOURCE)] })({}, payload);
    expect(result.chunks).toEqual([]);
  });
});
