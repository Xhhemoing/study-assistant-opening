import { expect, it, vi } from "vitest";
import { preparePhotoPractice } from "./photo-practice-client";
const sourceId = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";

it("prepares the exact selected question image version without supplying an answer", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ sourceId, sourceVersion: 2, courseId }));
  expect(await preparePhotoPractice({ sourceId, sourceVersion: 2 }, fetcher)).toEqual({ sourceId, sourceVersion: 2, courseId });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ sourceId, sourceVersion: 2 });
});
it("rejects a changed question reference or a failed prepare instead of opening an unrelated attempt", async () => {
  await expect(preparePhotoPractice({ sourceId, sourceVersion: 2 }, vi.fn().mockResolvedValue(Response.json({ sourceId, sourceVersion: 3, courseId })))).rejects.toThrow("版本已改变");
  await expect(preparePhotoPractice({ sourceId, sourceVersion: 2 }, vi.fn().mockResolvedValue(Response.json({ error: { message: "图片尚未解析完成" } }, { status: 409 })))).rejects.toThrow("图片尚未解析完成");
});
