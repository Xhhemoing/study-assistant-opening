import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import { createTutorStreamReader, createTutorStreamWriter, withTutorDeltaBatches } from "./tutor-stream";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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

it("flushes at the monotonic deadline even when the timer callback has not run", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const published: string[] = [];
    await withTutorDeltaBatches(async (_signal, delta) => {
      await delta("first");
      await delta(" second");
      expect(published).toEqual(["first"]);
      now.mockReturnValue(41);
      await delta(" third");
      expect(published).toEqual(["first", " second"]);
    }, async text => { published.push(text); });
    expect(published).toEqual(["first", " second", " third"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    now.mockRestore();
    vi.useRealTimers();
  }
});

it("drains overlapping callbacks accepted before close in arrival order", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const finishProvider = deferred();
  const published: string[] = [];
  let emit!: (text: string) => Promise<void>;
  const run = withTutorDeltaBatches(async (_signal, delta) => {
    emit = delta;
    await finishProvider.promise;
  }, async text => {
    if (text === "first") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    published.push(text);
  });
  const first = emit("first");
  await firstStarted.promise;
  const second = emit(" second");
  const third = emit(" third");
  finishProvider.resolve();
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await emit(" late");
  releaseFirst.resolve();
  await Promise.all([first, second, third, run]);
  expect(published.join("")).toBe("first second third");
});
