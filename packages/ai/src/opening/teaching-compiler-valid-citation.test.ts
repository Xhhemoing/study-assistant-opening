import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";
import { createCompilerBuildPublishInput, TeachingCompileOutputError } from "./teaching-compiler";

const sourceId = randomUUID(), chunkId = randomUUID();
const chunk: SourceChunk = { id: chunkId, sourceId, sourceVersion: 1, page: 1, startMs: null, endMs: null, imageObjectKey: null, text: "矩阵的秩与零空间维数之和等于列数。" };
const payload = { activityId: randomUUID(), teachingUnitId: randomUUID(), expectedContentVersion: 0, sourceIds: [sourceId] };
function output(teach: string[], prompt: string[] = [], answer: string[] = []) {
  return { text: JSON.stringify({ blocks: [
    { type: "text", text: "矩阵的秩与零空间维数之和等于列数。", citedChunkIds: teach },
    ...[5, 4].flatMap(columns => [
      { type: "prompt", text: `一个3×${columns}矩阵的秩为2，零空间维数是多少？`, citedChunkIds: prompt },
      { type: "answer_key", ...rankPedagogy, text: `${columns} − 2 = ${columns - 2}`, citedChunkIds: answer,
        hints: { direction: "先找列数。", concept: "主元与自由变量数之和等于列数。", firstStep: `用${columns}减去2。` } },
    ]),
  ] }) };
}
it.each([
  { name: "no citations", teach: [], prompt: [], answer: [], chunks: [chunk] },
  { name: "unknown citations", teach: ["unknown"], prompt: [], answer: [], chunks: [chunk] },
  { name: "prompt only", teach: [], prompt: [chunkId], answer: [], chunks: [chunk] },
  { name: "hidden answer only", teach: [], prompt: [], answer: [chunkId], chunks: [chunk] },
  { name: "empty pack", teach: [chunkId], prompt: [], answer: [], chunks: [] },
])("rejects $name before writing", async ({ teach, prompt, answer, chunks }) => {
  const writer = vi.fn(async () => {});
  const build = createCompilerBuildPublishInput({ requireModelOutput: true, requireMaterialCitations: true, loadChunks: async () => chunks, writeLibraryBlocks: writer });
  await expect(build({}, payload, output(teach, prompt, answer))).rejects.toBeInstanceOf(TeachingCompileOutputError);
  expect(writer).not.toHaveBeenCalled();
});
it.each([[chunkId], ["unknown", chunkId]])("writes real teaching citations after filtering: %j", async (...ids) => {
  const writer = vi.fn(async (_blocks: import("./teaching-compiler").CompileLibraryBlock[]) => {});
  await createCompilerBuildPublishInput({ requireModelOutput: true, requireMaterialCitations: true, loadChunks: async () => [chunk], writeLibraryBlocks: writer })({}, payload, output(ids));
  expect(writer).toHaveBeenCalledTimes(1);
  expect(writer.mock.calls[0]![0][0]).toMatchObject({ type: "text", content: { citedChunkIds: [chunkId] } });
  expect(JSON.stringify(writer.mock.calls[0])).not.toContain("unknown");
});
it("keeps default no-material generation compatible", async () => {
  const writer = vi.fn(async () => {});
  const result = await createCompilerBuildPublishInput({ requireModelOutput: true, writeLibraryBlocks: writer })({}, { ...payload, sourceIds: [] }, output([]));
  expect(writer).toHaveBeenCalledTimes(1);
  expect(result.blockOrder.some(block => block.role === "teach")).toBe(true);
});
