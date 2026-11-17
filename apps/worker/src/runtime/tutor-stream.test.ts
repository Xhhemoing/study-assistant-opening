import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import { createTutorStreamReader, createTutorStreamWriter } from "./tutor-stream";

it("sm95 parses the cached attempt fence and rejects malformed identities before delivery", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
    attemptFence: { attemptId: id, itemVersionId: id, rootObservationId: id, headObservationId: id, answerRevision: 1 } };
  const hgetall = vi.fn().mockResolvedValueOnce({ context: JSON.stringify(context), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, attemptFence: { ...context.attemptFence, answerRevision: 0 } }), text: "cached", sequence: "1" });
  const reader = createTutorStreamReader({ hgetall } as unknown as IORedis);
  expect(await reader.read(id, id)).toMatchObject({ ...context, text: "cached", sequence: 1 });
  await expect(reader.read(id, id)).rejects.toThrow();
});

it("returns only confirmed publication sequences and includes the expected execution identity", async () => {
  const evalScript = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const writer = createTutorStreamWriter({ eval: evalScript } as unknown as IORedis);
  expect(await writer.append("workspace", "job", "hello", "execution")).toBe(1);
  expect(await writer.append("workspace", "job", "stale", "old-execution")).toBe(0);
  expect(evalScript.mock.calls[0]?.at(-1)).toBe("execution");
  expect(await writer.append("workspace", "job", "", "execution")).toBe(0);
  expect(evalScript).toHaveBeenCalledTimes(2);
});
