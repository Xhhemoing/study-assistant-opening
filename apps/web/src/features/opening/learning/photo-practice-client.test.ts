import { expect, it, vi } from "vitest";
import { photoQuestionRecognition, preparePhotoPractice } from "./photo-practice-client";
const sourceId = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";

it.each([0, 2])("prepares the exact question image version %s without supplying an answer", async sourceVersion => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ sourceId, sourceVersion, courseId }));
  expect(await preparePhotoPractice({ sourceId, sourceVersion }, fetcher)).toEqual({ sourceId, sourceVersion, courseId });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ sourceId, sourceVersion });
});
it("rejects a changed question reference or a failed prepare instead of opening an unrelated attempt", async () => {
  await expect(preparePhotoPractice({ sourceId, sourceVersion: 2 }, vi.fn().mockResolvedValue(Response.json({ sourceId, sourceVersion: 3, courseId })))).rejects.toThrow("版本已改变");
  await expect(preparePhotoPractice({ sourceId, sourceVersion: 2 }, vi.fn().mockResolvedValue(Response.json({ error: { message: "图片尚未解析完成" } }, { status: 409 })))).rejects.toThrow("图片尚未解析完成");
});
it("restores recognition by read-only GET and creates only an explicit source/version request", async () => {
  const result = { sourceId, sourceVersion: 0, jobId: courseId, status: "queued", proposal: null };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(result));
  expect(await photoQuestionRecognition({ sourceId, sourceVersion: 0 }, false, fetcher)).toEqual(result);
  expect(fetcher.mock.calls[0]).toEqual([`/api/opening/practice/recognition?sourceId=${sourceId}&sourceVersion=0`, { cache: "no-store" }]);
  await photoQuestionRecognition({ sourceId, sourceVersion: 0 }, true, fetcher);
  expect(fetcher.mock.calls[1]?.[1].method).toBe("POST");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ sourceId, sourceVersion: 0 });
});
it("rejects a recognition result for a different source revision", async () => {
  await expect(photoQuestionRecognition({ sourceId, sourceVersion: 0 }, false, vi.fn().mockResolvedValue(Response.json({ sourceId, sourceVersion: 1, jobId: null, status: "idle", proposal: null })))).rejects.toThrow("版本不一致");
});
